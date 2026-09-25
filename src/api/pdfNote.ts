/**
 * PDF 上传云笔记（App 原生结构版）
 *
 * 背景：官方云笔记 App 打开笔记时的渲染数据源是每页独立的 ObjectBox 数据库
 * （page_mdb/data.mdb）+ snapshot.bin（protobuf 对象列表）+ 图片文件，
 * 而非网页端回放用的页目录 bin 文件。旧「页目录模板 + page_router.bin」结构
 * 在 App 里只能得到空画板（data.mdb 由 App 打开时自建空库）。
 *
 * 本版结构（逆向自官方 App 真实笔记，样本见 _work/mdb-sample）：
 *   每页一个页 hash 目录，云端资源 5 件套（pageIndex 分组）：
 *     <页hash>/data.mdb       resourceType=1  ObjectBox 绘制记录（模板字节替换生成）
 *     <页hash>/lock.mdb       resourceType=1  ObjectBox 锁文件（模板原样）
 *     <页hash>/snapshot.bin   resourceType=1  protobuf 对象列表（模板 uuid 替换）
 *     <页hash>/screenshot.png resourceType=2  页面缩略图（App 笔记列表封面）
 *     <页hash>/<uuid>.jpg     resourceType=0  PDF 页面图片
 *   App 同步下载时自动映射为本地 <页hash>/page_mdb/data.mdb + res/image/ + <dirName>/。
 *
 * 模板生成原理：App 保存的 data.mdb/snapshot.bin 中所有页特定内容
 * （uuid、fileId/页hash 路径、图片 SHA-256）均为等长 ASCII 串，
 * 因此可以「模板字节复制 + 全局等长替换」生成任意页，无需手写 ObjectBox 格式。
 */
import { DEFAULT_API_BASE } from '@/config'

import { aesEncrypt } from '@/utils/crypto'
import { dateStamp, uploadFile, invalidateStsCache } from '@/utils/oss'
import { convertPdfToImages, blobToMd5, type PdfPageImage } from '@/utils/pdf'

/**
 * 有限并发地执行任务（保持输入顺序）。
 * 4 路并发 + utils/oss 里的 STS 凭证缓存，避免几十页串行上传时界面长时间无响应。
 */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let cursor = 0
  async function runner() {
    for (;;) {
      const i = cursor++
      if (i >= items.length) return
      results[i] = await worker(items[i], i)
    }
  }
  const lanes = Math.min(limit, items.length)
  await Promise.all(Array.from({ length: lanes }, runner))
  return results
}

const UPLOAD_CONCURRENCY = 4

const APP_TEMPLATE_BASE = 'example/app-template/'
const APP_TEMPLATE_FILES = ['data.mdb', 'snapshot.bin', 'lock.mdb'] as const

/**
 * 模板（官方 App 1.13.3 创建的纯图片页，含完整命令流：图片对象带 parentGraphId
 * 挂接页面树 + snapshot childGraph 条目带 filePath）中的全部页特定内容。
 * 生成每页时一一分配新值并在 data.mdb/snapshot.bin 里全局等长替换。
 *
 * 渲染链路（App 1.13.3 实测）：loadDirAsMdbFmt 按 data.mdb 命令流重建页面，
 * 图片 GraphData 缺 parentGraphId 时对象挂不上树 → 不渲染（repairer 只查文件
 * 存在性，会误报"完整未缺失"）；snapshot 仅在保存时重写，打开时不作为渲染源。
 */
const TPL_UUID_GRAPH = '663fa741-761a-4cdf-87e9-af9dbd3d65f4' // 图片对象 graphId（data.mdb 4 处 + snapshot 1 处）
const TPL_UUID_IMG = '3c7e11a7-abf7-48b9-be95-92004685ca67' // 图片文件名 uuid（{imgUuid}.jpg）
const TPL_UUID_FILE = '7a9f2e3f-6cc3-49f0-8a75-8018e978c39e' // 命令数据引用（{cmdUuid}_file.bin）
const TPL_UUID_PAGE = 'e9f509fe-9f71-45ea-b708-1cd22329bd2d' // 页根 id（GraphData.parentGraphId + snapshot 根 id）
const TPL_UUID_DIR = 'f65f0cf8-e883-426d-87b8-9fb3428865dd' // 会话目录名（data.mdb 内引用）

/** 模板 data.mdb 里记录的本地路径（userNote/{userId}/note/{fileId}/{页hash}） */
const TPL_NOTE_FILE_ID = 'a90a7564ba884cc2928db8e072ff4368'
const TPL_PAGE_HASH = '1790279207798'
/** 模板路径里的 userId 段（仅当目标 userId 与其等长时才替换，避免破坏偏移） */
const TPL_USER_ID = '2295'
/** 模板 data.mdb 里记录的图片内容 SHA-256（64 hex，等长替换） */
const TPL_IMG_SHA256 = 'fbb9a1cb7b079c93a10893da1d35eb82fc9f17c008493dd0800e919dc0ce0079'

/**
 * 模板 data.mdb 里记录的页面/图片显示尺寸（int32 宽高对，两处：
 * 页面板对象与图片对象各一份，值相同 = 图片恰好铺满页面板）。
 * 生成时按 PDF 页图宽高比改写，让笔记画板与页面比例一致、
 * App 内打开不再拉伸变形（实测：模板 1920/1039=1.848 的横版源图
 * 1100x777=1.416 被拉成 1.82；按比例写入 1471x1039 后渲染 1.416，完全吻合）。
 */
const TPL_BOARD_H = 1039
const TPL_BOARD_W = 1920
/** 自适应后的高度基准：保持与官方模板相同的画板高度感 */
const BOARD_BASE_H = 1039
/** 显示尺寸的上下限保护（int32 范围内远不到，防极端长条页生成异常值） */
const BOARD_MIN_W = 200
const BOARD_MAX_W = 8000

let appTemplateCache: Record<string, ArrayBuffer> | null = null

/** 加载 App 结构模板（data.mdb/snapshot.bin/lock.mdb） */
async function loadAppTemplate(): Promise<Record<string, ArrayBuffer>> {
  if (appTemplateCache) return appTemplateCache
  const cache: Record<string, ArrayBuffer> = {}
  for (const f of APP_TEMPLATE_FILES) {
    const resp = await fetch(APP_TEMPLATE_BASE + f)
    if (!resp.ok) throw new Error('加载 App 模板文件失败: ' + f)
    cache[f] = await resp.arrayBuffer()
  }
  appTemplateCache = cache
  return cache
}

/**
 * 等长字节替换（要求 from/to 编码后长度一致，否则抛错）。
 * 用于 ObjectBox 模板的页特定内容替换——等长保证不破坏文件内部偏移。
 */
function replaceAllAscii(
  bytes: Uint8Array<ArrayBuffer>,
  from: string,
  to: string
): Uint8Array<ArrayBuffer> {
  const enc = new TextEncoder()
  const f = enc.encode(from)
  const t = enc.encode(to)
  if (f.length !== t.length) throw new Error(`替换长度不一致: "${from}" -> "${to}"`)
  const out = new Uint8Array(bytes.byteLength)
  out.set(bytes)
  outer: for (let i = 0; i <= out.length - f.length; i++) {
    for (let j = 0; j < f.length; j++) {
      if (out[i + j] !== f[j]) continue outer
    }
    out.set(t, i)
    i += f.length - 1
  }
  return out
}

/**
 * 整段等长替换：把 from 换成 to，要求「两段整体」编码后等长（分段长度可不同）。
 * 用于路径这类必须保持槽位长度、但内部各段长度可重新分配的场合——
 * 例如模板 userId 段 4 位（2295）替换成 5 位（30174）时，
 * 同步把页 hash 段从 13 位缩短为 12 位，整条路径仍为原长度，
 * 从而既能修正 userId 又不破坏 ObjectBox 定长字符串槽位。
 */
function replaceAllAsciiSameTotal(
  bytes: Uint8Array<ArrayBuffer>,
  from: string,
  to: string
): Uint8Array<ArrayBuffer> {
  const enc = new TextEncoder()
  const f = enc.encode(from)
  const t = enc.encode(to)
  if (f.length !== t.length) {
    throw new Error(`整段等长替换长度不一致: "${from}"(${f.length}) -> "${to}"(${t.length})`)
  }
  const out = new Uint8Array(bytes.byteLength)
  out.set(bytes)
  outer: for (let i = 0; i <= out.length - f.length; i++) {
    for (let j = 0; j < f.length; j++) {
      if (out[i + j] !== f[j]) continue outer
    }
    out.set(t, i)
    i += f.length - 1
  }
  return out
}

/**
 * 按页图宽高比改写 data.mdb 里的页面/图片显示尺寸（int32 高宽对，LE）。
 * 高度固定 BOARD_BASE_H，宽度 = 高度 × 页图宽高比（clamp 到保护范围），
 * 模板中该高宽对出现多处（页面板对象 + 图片对象各一份），全部同步改写；
 * 一处都找不到说明模板版本不匹配，直接抛错避免静默生成变形页。
 * 返回新数组，不改动传入缓冲（模板缓存不可污染）。
 */
function applyImageRatio(
  bytes: Uint8Array<ArrayBuffer>,
  imgW: number,
  imgH: number
): Uint8Array<ArrayBuffer> {
  if (!imgW || !imgH) return bytes
  const h = BOARD_BASE_H
  const w = Math.min(BOARD_MAX_W, Math.max(BOARD_MIN_W, Math.round((BOARD_BASE_H * imgW) / imgH)))
  if (h === TPL_BOARD_H && w === TPL_BOARD_W) return bytes
  const out = new Uint8Array(bytes)
  const p = [TPL_BOARD_H, TPL_BOARD_W].map((v) => [
    v & 0xff,
    (v >> 8) & 0xff,
    (v >> 16) & 0xff,
    (v >> 24) & 0xff
  ])
  const wb = [w & 0xff, (w >> 8) & 0xff, (w >> 16) & 0xff, (w >> 24) & 0xff]
  let hits = 0
  for (let i = 0; i + 8 <= out.length; i++) {
    if (
      out[i] === p[0][0] &&
      out[i + 1] === p[0][1] &&
      out[i + 2] === p[0][2] &&
      out[i + 3] === p[0][3] &&
      out[i + 4] === p[1][0] &&
      out[i + 5] === p[1][1] &&
      out[i + 6] === p[1][2] &&
      out[i + 7] === p[1][3]
    ) {
      if (h !== TPL_BOARD_H) out.set([h & 0xff, (h >> 8) & 0xff, (h >> 16) & 0xff, (h >> 24) & 0xff], i)
      out.set(wb, i + 4)
      hits++
      i += 7
    }
  }
  if (hits === 0) throw new Error('data.mdb 模板中未找到页面尺寸字段（1039/1920），模板版本可能不匹配')
  return out
}

/** 计算 blob 的 SHA-256（小写 hex，用于 data.mdb 内的图片校验值） */
async function blobToSha256(blob: Blob): Promise<string> {  const buf = await blob.arrayBuffer()
  const digest = await crypto.subtle.digest('SHA-256', buf)
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

function apiBase(): string {
  return localStorage.getItem('apiBaseUrl') || DEFAULT_API_BASE
}

/**
 * 生成自定义 fileId。总长 32（'h' + 31 位），与官方 App 的 32 位 hex fileId 等长——
 * data.mdb 模板里的 convertUrl 路径需要按等长规则替换 fileId 段。
 */
export function generateCustomFileId(prefix = 'h', length = 31): string {
  const allChars = '0123456789abcdefghijklmnopqrstuvwxyz'
  for (;;) {
    let body = ''
    for (let i = 0; i < length; i++) {
      body += allChars.charAt(Math.floor(Math.random() * allChars.length))
    }
    if (/[g-z]/.test(body)) return prefix + body
  }
}

/**
 * 生成页 hash（复刻 generatePageHash，毫秒时间戳）。
 * 位数必须与「模板路径槽位」对齐：模板路径固定 120 字节，
 * userId 段比模板长的位数，由页 hash 位数等量缩短来补偿
 * （见 pageHashLength），否则整条路径超长会撑坏 ObjectBox 定长槽位。
 * 传入 seed 时按其值定长截断/补齐，保证页间严格递增。
 */
function generatePageHash(len = 13, seed?: number): string {
  const base = String(
    seed !== undefined ? seed : Date.now() + Math.floor(Math.random() * 1000)
  )
  // 位数多了取低位（时间戳低位仍单调递增），少了左侧补 1
  if (base.length >= len) return base.slice(base.length - len)
  return base.padStart(len, '1')
}

/**
 * 页 hash 的目标位数。模板路径槽位总长恒定（120 字节，
 * = 前缀 + userId + '/note/' + fileId(32) + '/' + 页hash），
 * 因此 userId 每多 1 位，页 hash 就要少 1 位；反之亦然。
 */
function pageHashLength(userId: string): number {
  const len = 13 - (userId.length - TPL_USER_ID.length)
  // 页 hash 需具备足够区分度与单调性，限制在合理区间
  return Math.min(16, Math.max(8, len))
}

/** 固定格式时间戳：YYYY-MM-DD HH:mm:ss（不依赖浏览器 locale） */
function formatTimestamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  )
}

/** 从 token 解析用户 ID（复刻 pdf-upload.js 的 getUserId） */
function getUserIdFromToken(): string {
  const token = localStorage.getItem('token') || ''
  try {
    const payload = JSON.parse(atob(token.split('.')[1]))
    return payload.sub || payload.nameid || payload.userId || ''
  } catch {
    return ''
  }
}

/** token 是否有效（复刻 isTokenValid，预留 5 分钟） */
export function isTokenValid(): boolean {
  const token = localStorage.getItem('token')
  if (!token) return false
  try {
    const payload = JSON.parse(atob(token.split('.')[1]))
    return !!payload.exp && payload.exp > Date.now() / 1000 + 300
  } catch {
    return false
  }
}

interface ResourceEntry {
  id: string
  fileId: string
  userId: number
  pageName: string
  pageIndex: number
  md5: string
  resourceType: number
  ossImageUrl: string
  createTimeStamp: string
  updateTimeStamp: string
  toBeUploaded: boolean
  wasDeleted: boolean
}

/** 保存资源列表（复刻 saveResourceList） */
async function saveResourceList(resourceList: ResourceEntry[]): Promise<void> {
  const token = localStorage.getItem('token')
  const data = aesEncrypt(JSON.stringify(resourceList))
  const resp = await fetch(`${apiBase()}/CloudNotes/api/Resources/AddOrUpdate`, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + token,
      'Content-Type': 'application/json; charset=UTF-8'
    },
    body: data
  })
  const result = await resp.json()
  if (result.code !== 0) throw new Error('保存资源失败: ' + JSON.stringify(result))
}

/**
 * 保存笔记（复刻 saveNote）。
 * fileUrl 使用实际上传得到的 OSS 根地址（桶与协议以 STS 返回为准）。
 */
async function saveNote(
  userId: string,
  customFileId: string,
  fileName: string,
  todayStr: string,
  ossRoot: string
): Promise<void> {
  const token = localStorage.getItem('token')
  const fileUrl = `${ossRoot}note_v2/res/${userId}/${todayStr}/${customFileId}/`
  const data = aesEncrypt(
    JSON.stringify({
      fileId: customFileId,
      fileName,
      parentId: '0',
      type: '12',
      fileUrl
    })
  )
  const resp = await fetch(`${apiBase()}/CloudNotes/api/Notes/AddOrUpdate`, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + token,
      'Content-Type': 'application/json; charset=UTF-8'
    },
    body: data
  })
  const result = await resp.json()
  if (result.code !== 0) throw new Error('保存笔记失败: ' + JSON.stringify(result))
}

export interface UploadPdfOptions {
  file: File
  noteName: string
  /** 已转换好的图片（若已预先转换可传入，避免重复转换） */
  images?: PdfPageImage[]
  onProgress?: (percent: number, text: string) => void
}

/** PDF 上传为云笔记主流程（App 原生结构版） */
export async function uploadPdfAsNote(opts: UploadPdfOptions): Promise<PdfPageImage[]> {
  const { file, noteName, onProgress } = opts
  const report = (p: number, t: string) => onProgress?.(p, t)

  if (!isTokenValid()) throw new Error('登录已过期，请重新登录')

  // 步骤1：加载 App 结构模板
  report(3, '正在加载模板文件...')
  const templates = await loadAppTemplate()

  // 步骤2：PDF 转图片
  report(10, '正在转换PDF...')
  const pdfImages =
    opts.images && opts.images.length
      ? [...opts.images]
      : await convertPdfToImages(file, (p, c, t) => {
          report(10 + p * 25, `转换PDF：第 ${c}/${t} 页`)
        })

  const userId = getUserIdFromToken()
  if (!userId) throw new Error('无法从登录凭据解析用户 ID，请重新登录后再试')
  const customFileId = generateCustomFileId()
  const todayStr = dateStamp()
  const timestamp = formatTimestamp(new Date())

  // 步骤3：为每页生成页 hash、uuid 映射与替换后的页数据
  // 页 hash 以起始时间为基准按页序递增（每页 +1000ms），保证 PDF 第 N 页
  // 对应笔记第 N 页（App 端页序既按 pageIndex 也按页 hash 目录时间排列）
  report(38, '正在生成画板数据...')
  const hashBase = Date.now()
  interface PagePlan {
    pageHash: string
    imgUuid: string
    dirUuid: string
    dataMdb: Blob
    snapshotBin: Blob
    lockMdb: Blob
    imgBlob: Blob
    imgMd5: string
    dataMd5: string
    lockMd5: string
    snapMd5: string
  }
  const pagePlans: PagePlan[] = []
  // 页 hash 位数随 userId 位数互补（模板槽位等长约束）
  const phLen = pageHashLength(userId)
  for (let i = 0; i < pdfImages.length; i++) {
    // 以起始时间戳为基准按页序递增，保证 PDF 第 N 页对应笔记第 N 页
    // （App 端页序既按 pageIndex，也按页 hash 目录名排序）
    const pageHash = generatePageHash(phLen, hashBase + i * 1000 + Math.floor(Math.random() * 500))
    // 每页独立分配：图片对象 id / 图片文件名 / 命令引用 / 页根 / 会话目录
    const graphUuid = crypto.randomUUID()
    const imgUuid = crypto.randomUUID()
    const cmdUuid = crypto.randomUUID()
    const pageRootUuid = crypto.randomUUID()
    const dirUuid = crypto.randomUUID()

    const imgBlob = pdfImages[i].blob
    const [imgMd5, imgSha256] = await Promise.all([blobToMd5(imgBlob), blobToSha256(imgBlob)])

    // 页图实际宽高：渲染路径直接携带；外部传入的 images 可能缺省，现读兜底
    let imgW = pdfImages[i].width
    let imgH = pdfImages[i].height
    if (!imgW || !imgH) {
      const bmp = await createImageBitmap(imgBlob)
      imgW = bmp.width
      imgH = bmp.height
      bmp.close()
    }

    // data.mdb：全部页特定内容等长替换（graphId 含 parentGraphId 引用链）
    let dataBytes = new Uint8Array(templates['data.mdb'])
    dataBytes = replaceAllAscii(dataBytes, TPL_UUID_GRAPH, graphUuid)
    dataBytes = replaceAllAscii(dataBytes, `${TPL_UUID_IMG}.jpg`, `${imgUuid}.jpg`)
    dataBytes = replaceAllAscii(dataBytes, `${TPL_UUID_FILE}_file.bin`, `${cmdUuid}_file.bin`)
    dataBytes = replaceAllAscii(dataBytes, TPL_UUID_PAGE, pageRootUuid)
    dataBytes = replaceAllAscii(dataBytes, TPL_UUID_DIR, dirUuid)
    dataBytes = replaceAllAscii(dataBytes, TPL_IMG_SHA256, imgSha256)
    // 本地路径整段替换：userId + fileId + 页 hash 一次性改掉。
    // 模板路径槽位长度固定（120 字节），userId 位数变化必须与页 hash 位数互补，
    // 否则超长会撑坏 ObjectBox 定长字符串槽位、过短则留残字节。
    // 关键：App 编辑页 loadDirAsMdbFmt 会用「真实 userId 路径」去匹配 data.mdb 内
    // 记录的路径，userId 段保留模板值（2295）时匹配失败 → 按空画板加载 →
    // 回写覆盖云端 data.mdb，表现就是「点进编辑没有图片」（预览读 screenshot.png，故正常）。
    dataBytes = replaceAllAsciiSameTotal(
      dataBytes,
      `${TPL_USER_ID}/note/${TPL_NOTE_FILE_ID}/${TPL_PAGE_HASH}`,
      `${userId}/note/${customFileId}/${pageHash}`
    )
    // 画板/图片显示尺寸按 PDF 页比例自适应，避免 App 内打开被拉伸变形
    dataBytes = applyImageRatio(dataBytes, imgW, imgH)

    // snapshot.bin：仅 uuid 替换
    let snapBytes = new Uint8Array(templates['snapshot.bin'])
    snapBytes = replaceAllAscii(snapBytes, TPL_UUID_GRAPH, graphUuid)
    snapBytes = replaceAllAscii(snapBytes, `${TPL_UUID_IMG}.jpg`, `${imgUuid}.jpg`)
    snapBytes = replaceAllAscii(snapBytes, `${TPL_UUID_FILE}_file.bin`, `${cmdUuid}_file.bin`)
    snapBytes = replaceAllAscii(snapBytes, TPL_UUID_PAGE, pageRootUuid)

    const dataMdb = new Blob([dataBytes], { type: 'application/octet-stream' })
    const snapshotBin = new Blob([snapBytes], { type: 'application/octet-stream' })
    // lock.mdb 为 ObjectBox 运行时锁文件，App 打开数据库时自行管理，原样上传模板
    const lockMdb = new Blob([templates['lock.mdb']], { type: 'application/octet-stream' })
    const [dataMd5, lockMd5, snapMd5] = await Promise.all([
      blobToMd5(dataMdb),
      blobToMd5(lockMdb),
      blobToMd5(snapshotBin)
    ])

    pagePlans.push({
      pageHash,
      imgUuid,
      dirUuid,
      dataMdb,
      snapshotBin,
      lockMdb,
      imgBlob,
      imgMd5,
      dataMd5,
      lockMd5,
      snapMd5
    })
  }

  // 步骤4：上传每页 5 件套并构建 resourceList（页序 = PDF 页序 = pageIndex）
  report(45, '正在上传页面数据...')
  const resourceList: ResourceEntry[] = []
  let ossRoot = ''
  let uploaded = 0
  for (let i = 0; i < pagePlans.length; i++) {
    const plan = pagePlans[i]
    const base = `${plan.pageHash}`
    const uploads: Array<[Blob, string]> = [
      [plan.dataMdb, `${base}/data.mdb`],
      [plan.lockMdb, `${base}/lock.mdb`],
      [plan.snapshotBin, `${base}/snapshot.bin`],
      [plan.imgBlob, `${base}/${plan.imgUuid}.jpg`],
      [plan.imgBlob, `${base}/screenshot.png`]
    ]
    let firstUrl = ''
    for (const [blob, remote] of uploads) {
      let url = ''
      try {
        url = await uploadFile(blob, userId, 'note_v2', customFileId, remote)
      } catch (e) {
        invalidateStsCache(userId, 'note_v2')
        url = await uploadFile(blob, userId, 'note_v2', customFileId, remote)
      }
      if (!firstUrl) firstUrl = url
    }
    if (!ossRoot) {
      const urlObj = new URL(firstUrl)
      ossRoot = urlObj.protocol + '//' + urlObj.host + '/'
    }
    const pageOss = `${ossRoot}note_v2/res/${userId}/${todayStr}/${customFileId}/${plan.pageHash}`
    const localBase = `/storage/emulated/0/Android/data/com.friday.cloudsnote/userNote/${userId}/note/${customFileId}/${plan.pageHash}`

    const entry = (
      idSuffix: string,
      ossSuffix: string,
      md5: string,
      resourceType: number
    ): ResourceEntry => ({
      id: `${localBase}/${idSuffix}`,
      fileId: customFileId,
      userId: Number(userId) || 0,
      pageName: localBase,
      pageIndex: i,
      md5,
      resourceType,
      ossImageUrl: `${pageOss}/${ossSuffix}`,
      createTimeStamp: timestamp,
      updateTimeStamp: timestamp,
      toBeUploaded: false,
      wasDeleted: false
    })

    // 顺序与官方 App 一致：data.mdb -> lock.mdb -> snapshot.bin -> screenshot.png -> 图片
    resourceList.push(entry('page_mdb/data.mdb', 'data.mdb', plan.dataMd5, 1))
    resourceList.push(entry('page_mdb/lock.mdb', 'lock.mdb', plan.lockMd5, 1))
    resourceList.push(entry(`${plan.dirUuid}/snapshot.bin`, 'snapshot.bin', plan.snapMd5, 1))
    resourceList.push(entry(`${plan.dirUuid}/screenshot.png`, 'screenshot.png', plan.imgMd5, 2))
    resourceList.push(entry(`res/image/${plan.imgUuid}.jpg`, `${plan.imgUuid}.jpg`, plan.imgMd5, 0))

    uploaded++
    report(45 + (uploaded / pagePlans.length) * 45, `已上传第 ${uploaded}/${pagePlans.length} 页`)
  }

  // 步骤5：保存资源与笔记
  report(94, '正在保存资源...')
  await saveResourceList(resourceList)

  report(97, '正在保存笔记...')
  await saveNote(userId, customFileId, noteName, todayStr, ossRoot)

  report(100, '上传完成！')
  return pdfImages
}
