/**
 * 图库模块接口（复刻 index.js loadPictures / doUploadPicture，
 * 并按官方 APK com.zykj.gallery.api.PictureService 校正请求体）
 * - 列表：GET  /api/services/app/PictureLibrary/GetAllPicturesFromLibrary
 * - 上传登记：POST /api/services/app/PictureLibrary/AddPictureAsync  body {name,picture,size,appName}
 * - 应用记录：POST /api/services/app/StoreAppControl/RecordPicturesAsync body {appName,packageName,pictures[]}
 */
import { request } from '@/utils/request'

export interface PictureItem {
  picture: string
  name: string
  size: string
  createTime: string
  [key: string]: any
}

export interface PictureListResult {
  items: PictureItem[]
  totalCount: number
}

/** 分页拉取图库（isRecycleBin: false=正常, true=回收站） */
export async function getPictures(
  isRecycleBin: boolean,
  skip: number,
  maxResultCount: number
): Promise<PictureListResult> {
  const resp = await request<{ result: PictureListResult }>(
    `/api/services/app/PictureLibrary/GetAllPicturesFromLibrary?SkipCount=${skip}&MaxResultCount=${maxResultCount}&IsRecycleBin=${isRecycleBin}`,
    { method: 'GET' }
  )
  return resp.result
}

/**
 * 上传后登记图片到图库
 * 官方 GalleryBody = { name, picture, size, appName }（appName 在 body 内，官方取值 "图库"）
 * @param name  图库记录名（官方 = URL 去掉扩展名的文件名，即 nonce）
 * @param picture 图片完整 URL
 * @param size  文件大小文本
 * @param appName 应用名，官方默认 "图库"
 */
export async function addPicture(
  name: string,
  picture: string,
  size: string,
  appName = '图库'
): Promise<any> {
  return request(`/api/services/app/PictureLibrary/AddPictureAsync`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      AppName: 'com.zykj.manage',
      AppVersion: '32'
    },
    body: JSON.stringify({ name, picture, size, appName })
  })
}

/**
 * 记录图片到应用（官方在 AddPictureAsync 之后调用；RecordImgBean{appName,packageName,pictures}）
 * 注意：该接口属「应用管控」范畴，浏览器端非必需，调用失败不影响图库登记。
 */
export async function recordPictures(
  pictures: string[],
  appName = '图库',
  packageName = 'com.zykj.manage'
): Promise<any> {
  return request(`/api/services/app/StoreAppControl/RecordPicturesAsync`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      AppName: 'com.zykj.manage',
      AppVersion: '32'
    },
    body: JSON.stringify({ appName, packageName, pictures })
  })
}

/* ============ 图库回收站操作（依据官方 APK com.zykj.gallery.api.PictureService） ============ */

const PIC_HEADERS = { Accept: 'application/json', AppName: 'com.zykj.manage', AppVersion: '32' }

/** 移入回收站（POST，body 为 id 数组） */
export async function moveToRecycleBin(ids: number[]): Promise<any> {
  return request(`/api/services/app/PictureLibrary/MoveToRecycleBinAsync`, {
    method: 'POST',
    headers: PIC_HEADERS,
    body: JSON.stringify(ids)
  })
}

/** 从回收站恢复（POST，body 为 id 数组） */
export async function recoverPictures(ids: number[]): Promise<any> {
  return request(`/api/services/app/PictureLibrary/RecoverPictureFromRecycleBinAsync`, {
    method: 'POST',
    headers: PIC_HEADERS,
    body: JSON.stringify(ids)
  })
}

/** 彻底删除（DELETE + ids 查询参数，可重复） */
export async function deletePictures(ids: number[]): Promise<any> {
  const q = ids.map((i) => `ids=${encodeURIComponent(String(i))}`).join('&')
  return request(`/api/services/app/PictureLibrary/DeletePicture?${q}`, {
    method: 'DELETE',
    headers: PIC_HEADERS
  })
}

/** 清空回收站（POST，无 body） */
export async function emptyRecycleBin(): Promise<any> {
  return request(`/api/services/app/PictureLibrary/EmptyRecycleBinAsync`, {
    method: 'POST',
    headers: PIC_HEADERS
  })
}

/**
 * 文件大小文本（复刻官方 blankj SizeUtils/ConvertUtils，保留 3 位小数、无空格、单位 B/KB/MB/GB）
 * 例：784972 字节 -> "766.574KB"
 */
export function formatFileSize(bytes: number): string {
  if (!bytes || bytes < 0) return '0.000B'
  if (bytes < 1024) return bytes.toFixed(3) + 'B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(3) + 'KB'
  if (bytes < 1024 * 1024 * 1024) return (bytes / 1024 / 1024).toFixed(3) + 'MB'
  return (bytes / 1024 / 1024 / 1024).toFixed(3) + 'GB'
}
