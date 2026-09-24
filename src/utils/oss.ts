/**
 * 阿里云 OSS 直传封装（1:1 复刻 index.js 的 uploadFile / fetchOssBaseUrl）
 *
 * 流程：调用 ObjectStorage/GenerateTokenV2Async 换取 STS 凭证，
 * 再用 ali-oss 直传到 {fc}/res/{userId}/{yyyyMMdd}/{nonce}/{fileName}。
 */
import { DEFAULT_API_BASE } from '@/config'

import OSS from 'ali-oss'
import CryptoJS from 'crypto-js'

/** 上传类型 -> fc 数值映射（复刻 V_MAP） */
const V_MAP: Record<string, number> = {
  note_v2: 1,
  eval_v2: 2,
  quora_v2: 3,
  mistake_v2: 4,
  study_v2: 5,
  column_v2: 6,
  paper_v2: 7,
  revise_v2: 8,
  selection_v2: 9,
  /** 图库图片（来自官方 APK GalleryRepository 反编译：默认 fc=11） */
  imagestore_v2: 11,
  manage_v2: 19
}

/** 资源分类 -> fr 数值映射（复刻 G_MAP） */
const G_MAP: Record<string, number> = { res: 1 }

const FR = 'res'
const FT = 2
const FE = ''
const FO = '0'

function apiBase(): string {
  return localStorage.getItem('apiBaseUrl') || DEFAULT_API_BASE
}

/**
 * 资源日期目录（复刻 index.js 的 dateStr）
 *
 * 修复：原来用 toISOString() 取 UTC 日期，而服务端按北京时间生成 STS
 * 会话策略里的路径前缀。北京时间 00:00-08:00 期间两者相差一天，OSS PUT
 * 会被 SessionPolicy 隐式拒绝（403 Access denied by authorizer's policy）。
 * 改为按本机本地日期计算，与服务端策略一致。
 */
export function dateStamp(date: Date = new Date()): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}${month}${day}`
}

/** MD5 大写（复刻 index.js md5） */
function md5Upper(str: string): string {
  return CryptoJS.MD5(str).toString().toUpperCase()
}

/** 生成 UUID 风格 nonce（复刻 generateNonce） */
export function generateNonce(): string {
  return (String(1e7) + -1e3 + -4e3 + -8e3 + -1e11).replace(/[018]/g, (c) =>
    (
      (Number(c) ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (Number(c) / 4)))) as number
    ).toString(16)
  )
}

export interface StsCredential {
  region?: string
  accessKeyId: string
  accessKeySecret: string
  securityToken: string
  bucket?: string
  endpoint?: string
}

/**
 * STS 凭证缓存。
 *
 * 修复：原实现**每次上传都先换一次 STS**。PDF 上传云笔记时，
 * 一个 100 页的 PDF 就是 8 个模板文件 + 100 张图 = 108 次上传 → 216 次请求，
 * 全部串行，几分钟都跑不完，界面像卡死一样。
 *
 * 实际上 STS 凭证的有效期远大于单次上传，且同一 (userId, fc) 的凭证可复用。
 * 这里缓存 20 分钟；离到期不足 60 秒时提前刷新，避免上传中途失效。
 */
const STS_TTL_MS = 20 * 60 * 1000
const STS_REFRESH_MARGIN_MS = 60 * 1000
const stsCache = new Map<string, { cred: StsCredential; expireAt: number }>()

/** 取（或换）STS 凭证 */
export async function getStsCredential(
  userId: string,
  fc: string,
  nonce: string
): Promise<StsCredential> {
  const key = `${userId}|${fc}`
  const now = Date.now()
  const hit = stsCache.get(key)
  if (hit && hit.expireAt > now + STS_REFRESH_MARGIN_MS) {
    return hit.cred
  }
  const cred = await generateStsToken(userId, fc, nonce)
  stsCache.set(key, { cred, expireAt: now + STS_TTL_MS })
  return cred
}

/** 上传出错且怀疑是凭证过期时调用，强制下次重新换取 */
export function invalidateStsCache(userId?: string, fc?: string): void {
  if (!userId || !fc) {
    stsCache.clear()
    return
  }
  stsCache.delete(`${userId}|${fc}`)
}

/** 请求 STS 临时凭证（复刻 GenerateTokenV2Async 调用） */
export async function generateStsToken(
  userId: string,
  fc: string,
  nonce: string
): Promise<StsCredential> {
  const ts = Date.now()
  const rawStr = `${userId}+${fc}+${FR}+${FT}+${FE}+${FO}+${nonce}+${ts}`
  const sign = md5Upper(rawStr)
  const token = localStorage.getItem('token')

  const resp = await fetch(`${apiBase()}/api/services/app/ObjectStorage/GenerateTokenV2Async`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      fc: V_MAP[fc],
      fr: G_MAP[FR],
      ft: FT,
      fe: FE,
      fo: FO,
      nonce,
      ts,
      sign
    })
  })

  if (!resp.ok) {
    const errorText = await resp.text()
    throw new Error(`服务器响应错误(${resp.status}): ${errorText.substring(0, 100)}`)
  }

  const responseText = await resp.text()
  let data: any
  try {
    data = JSON.parse(responseText)
  } catch {
    throw new Error('服务器返回数据格式错误，请重新登录后再试')
  }
  if (!data.result) throw new Error('获取 token 失败: ' + JSON.stringify(data))
  return data.result as StsCredential
}

/**
 * 上传文件到 OSS（复刻 uploadFile，返回文件完整 URL）
 * @param file 文件/Blob
 * @param userId 用户 ID
 * @param fc 上传类型前缀，如 note_v2
 * @param nonceInput 指定 nonce，留空自动生成
 * @param fileNameInput 指定远端文件名（可含子路径），留空用 file.name
 */
export async function uploadFile(
  file: Blob | File,
  userId: string,
  fc: string,
  nonceInput = '',
  fileNameInput = ''
): Promise<string> {
  const nonce = nonceInput.trim() || generateNonce()
  const remoteFileName = fileNameInput.trim() || (file as File).name
  const dateStr = dateStamp()

  const result = await getStsCredential(userId, fc, nonce)

  const client = new OSS({
    region: result.region || 'oss-cn-hangzhou',
    accessKeyId: result.accessKeyId,
    accessKeySecret: result.accessKeySecret,
    stsToken: result.securityToken,
    bucket: result.bucket
  })

  const remoteFile = `${fc}/${FR}/${userId}/${dateStr}/${nonce}/${remoteFileName}`
  await client.put(remoteFile, file as any)

  const endpoint = result.endpoint || `https://${result.bucket}.oss-cn-hangzhou.aliyuncs.com`
  return endpoint.replace(/\/+$/, '') + '/' + remoteFile
}

/* ============ 图库图片上传（复刻官方 APK GalleryRepository，前缀 imagestore_v2） ============
 * 依据：中育管控桌面 APK 反编译
 *   com.zykj.gallery.repository.GalleryRepository.h/f  —— 令牌与对象键
 *   com.zykj.gallery.oss.UploadUtils.ossUpload          —— OSS 直传
 *   com.zykj.huiwei.launcher.viewmodels.MainViewModel$saveToOssImg$2 —— 上传编排
 * 与普通 uploadFile 的差异：fc=11、前缀 imagestore_v2、ft=1(File)、fe=扩展名、
 * 对象键末段是「nonce+扩展名」（而非 nonce/文件名 两段）。
 */

/** 图库上传类型数值（fc=11，前缀 imagestore_v2） */
export const IMAGE_FC = 11
export const IMAGE_PREFIX = 'imagestore_v2'

/** 取图片扩展名（含点、小写；取不到则 .jpg）
 *  复刻官方：MimeTypeMap.getExtensionFromMimeType() 为空时回退 "jpg"，再拼 "." */
export function imageExt(file: File): string {
  const m = /\.([A-Za-z0-9]+)$/.exec(file.name || '')
  if (m) return '.' + m[1].toLowerCase()
  const sub = (file.type || '').split('/')[1]
  if (sub && /^[A-Za-z0-9.+-]+$/.test(sub)) return '.' + sub.toLowerCase()
  return '.jpg'
}

export interface GalleryUploadResult {
  /** 登记到图库的完整 URL（= endpoint + '/' + objectKey） */
  url: string
  /** 图库记录名（= 文件名去掉扩展名，即 nonce） */
  name: string
  /** 对象键 */
  objectKey: string
}

/**
 * 上传图片到图库（严格复刻官方 中育管控桌面 的 saveToOssImg 流程）：
 *  1) STS：POST ObjectStorage/GenerateTokenV2Async
 *       body { fc:11, ft:1(File), fe:扩展名, fr:1(res), fo:'0', nonce, ts, sign }
 *       sign = MD5( `${userId}+imagestore_v2+res+1+${fe}+0+${nonce}+${ts}` )（大写）
 *  2) 直传：objectKey = imagestore_v2/res/{userId}/{yyyyMMdd}/{nonce}{ext}
 *  3) 返回 url = endpoint + '/' + objectKey
 */
export async function uploadGalleryImage(file: File, userId: string): Promise<GalleryUploadResult> {
  const nonce = generateNonce()
  const ts = Date.now()
  const ext = imageExt(file)
  const sign = md5Upper(`${userId}+${IMAGE_PREFIX}+${FR}+1+${ext}+${FO}+${nonce}+${ts}`)
  const token = localStorage.getItem('token')

  const resp = await fetch(`${apiBase()}/api/services/app/ObjectStorage/GenerateTokenV2Async`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      fc: IMAGE_FC,
      ft: 1,
      fe: ext,
      fr: 1,
      fo: FO,
      nonce,
      ts,
      sign
    })
  })

  if (!resp.ok) {
    const errorText = await resp.text()
    throw new Error(`服务器响应错误(${resp.status}): ${errorText.substring(0, 100)}`)
  }
  const data: any = await resp.json()
  if (!data.result) throw new Error('获取 token 失败: ' + JSON.stringify(data))
  const result = data.result as StsCredential

  const client = new OSS({
    region: result.region || 'oss-cn-hangzhou',
    accessKeyId: result.accessKeyId,
    accessKeySecret: result.accessKeySecret,
    stsToken: result.securityToken,
    bucket: result.bucket
  })

  const objectKey = `${IMAGE_PREFIX}/${FR}/${userId}/${dateStamp()}/${nonce}${ext}`
  await client.put(objectKey, file as any)

  const endpoint = result.endpoint || `https://${result.bucket}.oss-cn-hangzhou.aliyuncs.com`
  return { url: endpoint.replace(/\/+$/, '') + '/' + objectKey, name: nonce, objectKey }
}

/**
 * 已删除 fetchOssBaseUrl / getOssBaseUrl / setOssBaseUrl。
 *
 * 删除原因（对应排查项 P1-25）：
 *  1. 全工程没有任何调用方（上传流程用的是 uploadFile 返回的真实 endpoint）；
 *  2. 它本身有 bug —— 签名串写成 `note_v2+res+1++0`（ft=1），
 *     而请求体发的是 `{fc:1, fr:1, ft:2, fe:'', fo:'0'}`，两者不一致，
 *     服务端校验签名必定失败；
 *  3. 兜底桶写死 `ezy-sxz`（省锡中），其它学校会拿到错误的桶。
 */

/** 从服务端获取当前登录用户 ID（复刻 getUserId） */
export async function fetchUserId(): Promise<string> {
  const token = localStorage.getItem('token')
  if (!token) throw new Error('localStorage 中未找到 token')

  const resp = await fetch(`${apiBase()}/api/services/app/User/GetInfoAsync`, {
    method: 'GET',
    headers: {
      Accept: 'application/json, text/plain, */*',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      Authorization: `Bearer ${token}`
    }
  })
  if (!resp.ok) throw new Error('请求用户信息失败: ' + resp.status)
  const data = await resp.json()
  if (data.result && data.result.id) return String(data.result.id)
  throw new Error('无法获取用户ID: ' + JSON.stringify(data))
}
