/**
 * PDF 上传云笔记（1:1 复刻 pdf-upload.js 的 uploadPdfAsNote 主流程）
 *
 * 流程：加载模板 bin -> PDF 转图 -> 上传模板到 OSS -> 逐页上传图片并构建
 * resourceList（每页 9 条固定结构）-> Resources/AddOrUpdate -> Notes/AddOrUpdate
 */
import { DEFAULT_API_BASE } from '@/config'

import { aesEncrypt } from '@/utils/crypto'
import { dateStamp, uploadFile, invalidateStsCache } from '@/utils/oss'
import { convertPdfToImages, type PdfPageImage } from '@/utils/pdf'

/**
 * 有限并发地执行任务（保持输入顺序）。
 *
 * 修复：原实现把模板文件与每页图片**全部串行上传**。
 * 100 页 PDF = 108 次串行 OSS PUT，加上每次换取 STS，
 * 几 MB 的文件要跑好几分钟，期间界面完全无响应。
 * 改为 4 路并发，并配合 utils/oss 里的 STS 凭证缓存。
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

const TEMPLATE_BASE = 'example/'
const TEMPLATE_UUID = 'a888b5fb-e65d-4611-a3af-1f80a0fb6ced'

/**
 * 图片资源固定文件名的**主体部分**（复刻 pdf-upload.js）。
 *
 * 修复：原实现把后缀也写死成 `.webp`，但 convertPdfToImages 在浏览器不支持 webp 编码时
 * 会返回原始格式（通常是 png/jpeg），于是对象键后缀与真实内容不符，
 * 部分客户端按扩展名解析会失败。现改为按 blob.type 决定后缀。
 */
const IMG_BASENAME =
  'B466246B6F67160E63431159941CD9A9screenCaptureb59d24b6-00fa-4f53-bc4f-1df255a5101a'

/** 按真实 MIME 取扩展名（含点） */
function imageExtOf(blob: Blob): string {
  const t = (blob.type || '').toLowerCase()
  if (t.includes('png')) return '.png'
  if (t.includes('jpeg') || t.includes('jpg')) return '.jpg'
  if (t.includes('webp')) return '.webp'
  return '.webp'
}

const TEMPLATE_FILES = [
  'page_router.bin',
  `${TEMPLATE_UUID}/059848e4-1971-47fb-9e47-517266cdef05_matrix.bin`,
  `${TEMPLATE_UUID}/a2b4fb47-3623-45be-9fe9-57fc62e66651_file.bin`,
  `${TEMPLATE_UUID}/e339e39b-64d9-4de0-bfaa-dace2a3f8e7d_command.bin`,
  `${TEMPLATE_UUID}/header.bin`,
  `${TEMPLATE_UUID}/router.bin`,
  `${TEMPLATE_UUID}/screenshot.png`,
  `${TEMPLATE_UUID}/snapshot.bin`
]

/** 每页固定的 8 条模板资源（相对路径 + 固定 md5 + resourceType） */
const TEMPLATE_RESOURCES: Array<{ rel: string; md5: string; resourceType: number }> = [
  { rel: 'page_router.bin', md5: 'C6FFAEB070ADBEC6B886BE63587CB0F8', resourceType: 1 },
  {
    rel: `${TEMPLATE_UUID}/059848e4-1971-47fb-9e47-517266cdef05_matrix.bin`,
    md5: '5D03C5A75809ED20D24C18388BB8AB63',
    resourceType: 1
  },
  {
    rel: `${TEMPLATE_UUID}/a2b4fb47-3623-45be-9fe9-57fc62e66651_file.bin`,
    md5: '5924B6262213683E6A4A2AFD3E4A270B',
    resourceType: 1
  },
  {
    rel: `${TEMPLATE_UUID}/e339e39b-64d9-4de0-bfaa-dace2a3f8e7d_command.bin`,
    md5: 'FEC4C90827E797E54126BB996BF0AF05',
    resourceType: 1
  },
  { rel: `${TEMPLATE_UUID}/header.bin`, md5: 'A929A287A521818CA4E56A9E643866AE', resourceType: 1 },
  { rel: `${TEMPLATE_UUID}/router.bin`, md5: '053971527BD9F3D4E3F9B2A1A4D2023F', resourceType: 1 },
  {
    rel: `${TEMPLATE_UUID}/screenshot.png`,
    md5: '538BC7AC54289E9EAA758C50A006AE59',
    resourceType: 2
  },
  { rel: `${TEMPLATE_UUID}/snapshot.bin`, md5: '9A26C2CA8A7C8731602497EA578C994F', resourceType: 1 }
]

/** 图片资源的固定 md5（复刻 core.py） */
const IMG_MD5 = '4126E637D965204140D4982A1B847283'

let templateFilesCache: Record<string, Blob> | null = null

function apiBase(): string {
  return localStorage.getItem('apiBaseUrl') || DEFAULT_API_BASE
}

/** 生成自定义 fileId（复刻 generateCustomFileId，须含 g-z 字符） */
export function generateCustomFileId(prefix = 'h', length = 32): string {
  const allChars = '0123456789abcdefghijklmnopqrstuvwxyz'
  for (;;) {
    let body = ''
    for (let i = 0; i < length; i++) {
      body += allChars.charAt(Math.floor(Math.random() * allChars.length))
    }
    if (/[g-z]/.test(body)) return prefix + body
  }
}

/** 生成页 hash（复刻 generatePageHash） */
function generatePageHash(): string {
  return String(Date.now() + Math.floor(Math.random() * 1000))
}

/** 固定格式时间戳：YYYY-MM-DD HH:mm:ss（不依赖浏览器 locale） */
function formatTimestamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  )
}

/** 加载模板 bin 文件（复刻 loadTemplateFiles） */
async function loadTemplateFiles(): Promise<Record<string, Blob>> {
  if (templateFilesCache) return { ...templateFilesCache }
  const cache: Record<string, Blob> = {}
  for (const f of TEMPLATE_FILES) {
    const resp = await fetch(TEMPLATE_BASE + f)
    if (!resp.ok) throw new Error('加载模板文件失败: ' + f)
    cache[f] = await resp.blob()
  }
  templateFilesCache = cache
  return { ...cache }
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
 * 保存笔记（复刻 saveNote）
 *
 * 修复：fileUrl 原先硬编码 ezy-sxz 桶，而资源实际上传到服务端 STS 返回的桶
 * （本校为 ezy-sxzsyxx），且协议写死 http。学校 App 按 fileUrl 取资源，
 * 桶和协议不一致会导致笔记打不开。现改为使用实际上传得到的 OSS 根地址。
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

/** PDF 上传为云笔记主流程（复刻 uploadPdfAsNote） */
export async function uploadPdfAsNote(opts: UploadPdfOptions): Promise<PdfPageImage[]> {
  const { file, noteName, onProgress } = opts
  const report = (p: number, t: string) => onProgress?.(p, t)

  if (!isTokenValid()) throw new Error('登录已过期，请重新登录')

  // 步骤1：加载模板文件
  report(5, '正在加载模板文件...')
  const templates = await loadTemplateFiles()

  // 步骤2：PDF 转图片
  report(15, '正在转换PDF...')
  const pdfImages =
    opts.images && opts.images.length
      ? opts.images
      : await convertPdfToImages(file, (p, c, t) => {
          report(15 + p * 30, `转换PDF：第 ${c}/${t} 页`)
        })

  const userId = getUserIdFromToken()
  if (!userId) throw new Error('无法从登录凭据解析用户 ID，请重新登录后再试')
  const customFileId = generateCustomFileId()
  const todayStr = dateStamp()
  /**
   * 修复：原实现用 `toLocaleString('zh-CN', {...})` 生成时间戳，
   * 不同浏览器 / ICU 版本输出格式不一致（可能是 `2026/9/23`、`2026年9月23日`、
   * 也可能带上午/下午），服务端解析可能出错。改为手写固定格式。
   */
  const timestamp = formatTimestamp(new Date())

  // 步骤3：上传模板文件到 OSS
  report(50, '正在上传模板文件...')
  const ossPageHash = generatePageHash()

  // 通过上传首个模板文件获取 OSS 根地址
  report(52, '正在获取OSS配置...')
  const testFileUrl = await uploadFile(
    templates['page_router.bin'],
    userId,
    'note_v2',
    customFileId,
    ossPageHash + '/page_router.bin'
  )
  const urlObj = new URL(testFileUrl)
  const ossRoot = urlObj.protocol + '//' + urlObj.host + '/'
  delete templates['page_router.bin']

  // 剩余模板文件并发上传（原实现串行）
  const restTemplates = Object.keys(templates).filter((f) => f.includes('/'))
  await mapLimit(restTemplates, UPLOAD_CONCURRENCY, (f) =>
    uploadFile(templates[f], userId, 'note_v2', customFileId, ossPageHash + '/' + f)
  )

  // 步骤4：逐页上传图片并构建 resourceList
  report(65, '正在上传图片...')
  const resourceList: ResourceEntry[] = []
  const ossBase = `${ossRoot}note_v2/res/${userId}/${todayStr}/${customFileId}`
  const baseOss = `${ossBase}/${ossPageHash}`

  // ① 先按页码确定性地算好每一页的目录名与文件名
  const pagePlans = pdfImages.map((img) => {
    const pageHash = generatePageHash()
    const pageBase = `/storage/emulated/0/Android/data/com.friday.cloudsnote/userNote/${userId}/note/${customFileId}/${pageHash}`
    // 后缀按真实图片格式决定，避免对象键与实际内容不符
    const imgName = `${pageHash}/${IMG_BASENAME}${imageExtOf(img.blob)}`
    return { pageHash, pageBase, imgName, blob: img.blob }
  })

  // ② 并发上传（原实现串行），失败且疑似凭证过期时清缓存重试一次
  let done = 0
  await mapLimit(pagePlans, UPLOAD_CONCURRENCY, async (plan) => {
    try {
      await uploadFile(plan.blob, userId, 'note_v2', customFileId, plan.imgName)
    } catch (e) {
      invalidateStsCache(userId, 'note_v2')
      await uploadFile(plan.blob, userId, 'note_v2', customFileId, plan.imgName)
    }
    done++
    report(65 + (done / pagePlans.length) * 25, `已上传第 ${done}/${pagePlans.length} 页`)
  })

  // ③ 再按页码顺序构建 resourceList（顺序必须与页码一致，不能受并发完成顺序影响）
  pagePlans.forEach((plan, pageIndex) => {
    for (const tpl of TEMPLATE_RESOURCES) {
      resourceList.push({
        id: `${plan.pageBase}/${tpl.rel}`,
        fileId: customFileId,
        pageName: plan.pageBase,
        pageIndex,
        md5: tpl.md5,
        resourceType: tpl.resourceType,
        ossImageUrl: `${baseOss}/${tpl.rel}`,
        createTimeStamp: timestamp,
        updateTimeStamp: timestamp,
        toBeUploaded: false,
        wasDeleted: false
      })
    }

    // 图片资源：resourceType 为 pageIndex，md5 固定
    resourceList.push({
      id: `${plan.pageBase}/res/image/${plan.imgName.split('/').pop()}`,
      fileId: customFileId,
      pageName: plan.pageBase,
      pageIndex,
      md5: IMG_MD5,
      resourceType: pageIndex,
      ossImageUrl: `${ossBase}/${plan.imgName}`,
      createTimeStamp: timestamp,
      updateTimeStamp: timestamp,
      toBeUploaded: false,
      wasDeleted: false
    })
  })

  // 步骤5、6：保存资源与笔记
  report(92, '正在保存资源...')
  await saveResourceList(resourceList)

  report(97, '正在保存笔记...')
  await saveNote(userId, customFileId, noteName, todayStr, ossRoot)

  report(100, '上传完成！')
  return pdfImages
}
