/**
 * 云笔记接口（复刻 index.js 中 loadNotes/searchNotes/noteGetAll/noteDownload 等）
 *
 * 说明：
 * - 登录后 API 基地址会变为学校特定服务器，故此处动态从 localStorage 读取，
 *   而非使用 config 中加载时固化的常量。
 * - 省锡中（zyapi.loshop.com.cn）使用 /special/ 代理路径，其它学校使用原始
 *   /CloudNotes/api/Notes|Resources/ 路径。
 */
import { DEFAULT_API_BASE } from '@/config'

import { aesEncrypt, aesDecrypt } from '@/utils/crypto'

/** 当前 API 基地址（登录后可能被替换为学校服务器） */
function apiBase(): string {
  return localStorage.getItem('apiBaseUrl') || DEFAULT_API_BASE
}

/** 是否使用省锡中 special 代理路径（复刻 useSpecialPath） */
function useSpecialPath(): boolean {
  const base = localStorage.getItem('apiBaseOrigin') || apiBase()
  return !!base && base.includes('zyapi.loshop.com.cn')
}

/** 云笔记 Notes 服务路径（复刻 getCloudNoteApiPath） */
function notesPath(endpoint: string, encryptedParams: string): string {
  const base = apiBase()
  const special = `${base}/special/${endpoint}?${encryptedParams}`
  const direct = `${base}/CloudNotes/api/Notes/${endpoint}?${encryptedParams}`
  return useSpecialPath() ? special : direct
}

/** 云笔记 Resources 服务路径（复刻 getCloudNoteApiPathR） */
function resourcesPath(endpoint: string, encryptedParams: string): string {
  const base = apiBase()
  const special = `${base}/special/${endpoint}?${encryptedParams}`
  const direct = `${base}/CloudNotes/api/Resources/${endpoint}?${encryptedParams}`
  return useSpecialPath() ? special : direct
}

function authHeaders(): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${localStorage.getItem('token') || ''}`
  }
}

export interface NoteItem {
  fileId: string
  fileName: string
  /** 12 = 笔记，0 = 文件夹（服务端已不再返回 type=1） */
  type: number
  createTime?: string
  updateTime?: string
  /** 所属目录 fileId（根目录为 "0"） */
  parentId?: string
  /** 已移入回收站（为 true 时不应出现在正常列表/搜索里） */
  isRecycleBin?: boolean
}

export interface NoteResource {
  ossImageUrl: string
  pageIndex: number
  resourceType: number
}

/** 401 校验 */
function check401(status: number): void {
  if (status === 401) {
    throw new Error('身份失效，请重新登录')
  }
}

/**
 * 统一校验云笔记接口响应并解密 data。
 *
 * 修复：原先 `getAllNotes` / `getRecycleNotes` / `getNoteResources` / `getNoteResourcesForZip`
 * 都不检查 `json.code`。服务端出错时 `json.data` 为空 → `aesDecrypt(undefined)` 返回空串 →
 * `JSON.parse('')` 抛 `Unexpected end of JSON input`，
 * 界面弹出这句完全无法定位的话，真正的服务端错误（code/msg）被吞掉了。
 */
function decodeNoteData<T = any>(json: any): T {
  if (!json || typeof json !== 'object') throw new Error('响应格式异常')
  if (json.code !== 0) {
    throw new Error(json.msg || `接口返回错误（code=${json.code}）`)
  }
  const text = aesDecrypt(json.data)
  if (!text) {
    throw new Error('响应解密失败：AES 密钥可能已跨天，刷新页面后重试')
  }
  try {
    return JSON.parse(text) as T
  } catch {
    throw new Error('响应内容解析失败（解密结果与预期结构不符）')
  }
}

/** 按 parentId 获取某文件夹下的笔记/子文件夹（复刻 loadNotes） */
export async function getNotesByParentId(parentId = '0'): Promise<NoteItem[]> {
  const params = `parentid=${parentId}&isNoteNode=true`
  const url = notesPath('GetByParentId', aesEncrypt(params))
  const res = await fetch(url, { headers: authHeaders() })
  check401(res.status)
  const data = decodeNoteData<{ noteList?: NoteItem[] }>(await res.json())
  return (data.noteList || []) as NoteItem[]
}

/**
 * 获取全部笔记（复刻 noteGetAll 的取数部分）。
 *
 * 过滤规则（实测 GetAll 返回的 noteList 字段）：
 *   type = 12 → 笔记；type = 0 → 文件夹；type = 1 服务端已不再返回。
 *   isRecycleBin = true → 已移入回收站，**必须排除**，否则删除后的笔记
 *   仍会出现在「全部笔记」列表里（表现为「删了不消失」）。
 * 原实现只按 `type === 1 || type === 12` 过滤：既漏了 type=0 文件夹，
 * 又把回收站笔记（也是 type=12）当成正常笔记返回了。
 */
export async function getAllNotes(): Promise<NoteItem[]> {
  const res = await fetch(`${apiBase()}/CloudNotes/api/Notes/GetAll`, {
    method: 'GET',
    headers: authHeaders()
  })
  check401(res.status)
  // 响应体的 data 字段为 AES 加密内容，需解密后才能取 noteList
  const data = decodeNoteData<{ noteList?: NoteItem[] }>(await res.json())
  const list: NoteItem[] = data.noteList || []
  return list.filter((item) => item.type === 12 && item.isRecycleBin !== true)
}

/** 关键词搜索笔记（复刻 searchNotes，排除回收站条目） */
export async function searchNotes(fileName: string): Promise<NoteItem[]> {
  const query = `fileName=${fileName}`
  const url = notesPath('Search', aesEncrypt(query))
  const res = await fetch(url, { method: 'GET', headers: authHeaders() })
  check401(res.status)
  const data = decodeNoteData<{ noteList?: NoteItem[] }>(await res.json())
  const list: NoteItem[] = data.noteList || []
  return list.filter((item) => item.type === 12 && item.isRecycleBin !== true)
}

/** 按 fileId 获取笔记的图片资源列表（复刻 noteDownload 取数部分） */
export async function getNoteResources(fileId: string): Promise<NoteResource[]> {
  const url = resourcesPath('GetByFileId', aesEncrypt('fileId=' + fileId))
  const res = await fetch(url, { method: 'GET', headers: authHeaders() })
  check401(res.status)
  const data = decodeNoteData<{ resourceList?: NoteResource[] }>(await res.json())
  return (data.resourceList || []) as NoteResource[]
}

/**
 * 获取全部资源用于打包下载（复刻 noteDownload2 取数部分）。
 * 注意：/special/ 路径只存在于作者服务器（zyapi.loshop.com.cn），
 * 学校原生域名下必须走 /CloudNotes/api/Resources/GetByFileId?&lt;AES&gt;（实测 200），
 * 否则「下载笔记」会 404 报错。
 */
export async function getNoteResourcesForZip(fileId: string): Promise<NoteResource[]> {
  if (!fileId) return []
  const url = resourcesPath('GetByFileId', aesEncrypt('fileId=' + fileId))
  const res = await fetch(url, { method: 'GET', headers: authHeaders() })
  check401(res.status)
  const data = decodeNoteData<{ resourceList?: NoteResource[] }>(await res.json())
  return (data.resourceList || []) as NoteResource[]
}

/* ============ 回收站 / 删除（依据官方云笔记 APK 接口定义） ============
 * 出处：APK com.friday.* 的 Retrofit 接口
 *   @o("CloudNotes/api/Notes/MoveToRecycleBin")  body = List<String>(fileId 列表)
 *   @o("CloudNotes/api/Notes/Delete")            body = List<String>
 *   @o("CloudNotes/api/Notes/ExpiredDelete")     body = List<String>
 *   @o("CloudNotes/api/Notes/Restore")           body = RestoreReq{parentId, fileId}
 * 与查询接口不同：写接口的 body 是 **AES 加密后的 JSON 字符串**（实测确认：
 * 传加密 JSON 体返回 code=1「操作失败」（格式正确、仅 id 不存在），
 * 传明文/查询串则返回 code=1001「请求参数有误」）。
 */

/** 云笔记写接口 URL */
function notesWriteUrl(endpoint: string): string {
  return `${apiBase()}/CloudNotes/api/Notes/${endpoint}`
}

/** 发送写请求（AES 加密 JSON 体），code!==0 抛错；成功时返回解密后的 data */
async function notesPost<T = any>(endpoint: string, payload: unknown): Promise<T | null> {
  const res = await fetch(notesWriteUrl(endpoint), {
    method: 'POST',
    headers: authHeaders(),
    body: aesEncrypt(JSON.stringify(payload))
  })
  check401(res.status)
  let json: any = {}
  try {
    json = await res.json()
  } catch {
    throw new Error('响应解析失败')
  }
  if (json.code !== 0) {
    throw new Error(json.msg || '操作失败')
  }
  if (!json.data) return null
  try {
    return JSON.parse(aesDecrypt(json.data)) as T
  } catch {
    return null
  }
}

/** 回收站条目（MoveToRecycleBin 的返回元素，含真实 parentId，可用于撤销恢复） */
export interface RestoreResponse {
  parentId: string
  fileId: string
  isRecycleBin: boolean
  expirationTimeStamp: number
  updateTime: string
  version: number
}

/**
 * 把笔记移入回收站。
 * 实测：对根目录下的笔记，返回体里的 parentId 是 "-1"（仅作标记）；
 * 而 Restore 只认 "0" 表示根目录，调用方需做归一化。
 */
export async function moveNoteToRecycleBin(fileIds: string[]): Promise<RestoreResponse[]> {
  return (await notesPost<RestoreResponse[]>('MoveToRecycleBin', fileIds)) || []
}

/** 从回收站恢复（parentId：根目录传 '0'，子目录传该目录 fileId） */
export async function restoreNote(parentId: string, fileId: string): Promise<void> {
  await notesPost('Restore', { parentId: parentId === '-1' ? '0' : parentId, fileId })
}

/** 拉取回收站中的笔记（GetAll 返回 isRecycleBin=true 的条目） */
export async function getRecycleNotes(): Promise<NoteItem[]> {
  const res = await fetch(`${apiBase()}/CloudNotes/api/Notes/GetAll`, {
    method: 'GET',
    headers: authHeaders()
  })
  check401(res.status)
  const data = decodeNoteData<{ noteList?: NoteItem[] }>(await res.json())
  const list: NoteItem[] = data.noteList || []
  return list.filter((item) => item.isRecycleBin === true)
}

/** 彻底删除笔记 */
export async function deleteNoteForever(fileIds: string[]): Promise<void> {
  await notesPost('Delete', fileIds)
}

/** 过期删除 */
export async function expiredDeleteNotes(fileIds: string[]): Promise<void> {
  await notesPost('ExpiredDelete', fileIds)
}

/** 删除单个笔记资源（Resources/Delete，body = List<ResourceDeleteEntity>） */
export async function deleteNoteResources(items: unknown[]): Promise<void> {
  const res = await fetch(`${apiBase()}/CloudNotes/api/Resources/Delete`, {
    method: 'POST',
    headers: authHeaders(),
    body: aesEncrypt(JSON.stringify(items))
  })
  check401(res.status)
  const json = await res.json()
  if (json.code !== 0) throw new Error(json.msg || '删除资源失败')
}
