/**
 * 系统信息接口（依据官方 APK 反编译；均为网站此前未使用的接口）
 *
 * 已实测可用（本校后端 zyapi-sxzsyxx）：
 *   StudentUser/GetStudentUserTodoAsync      待办计数
 *   Setting/GetAllSettings                   学校设置
 *   Setting/GetSystemSettingsAsync           系统功能开关
 *   Message/GetMyUnreadMessageCountAsync     消息未读数
 *   Message/GetMyDefaultSystemMessageListAsync 系统消息（POST）
 *   StoreAppControl/CanIOpen{Camera|Album|ScreenShot}Async  相机/相册/截屏许可（需 packageName）
 *   User/GetMyTopics                         我的话题（学科，含颜色）
 *   WebWhiteList/GetAllWhiteUrlAsync         网址白名单（返回加密串）
 *   Notice/GetNoticeAsync?id=                公告详情（需 id）
 */
import { request } from '@/utils/request'

const APP_HEADERS = { Accept: 'application/json', AppName: 'com.zykj.manage', AppVersion: '32' }

/** 待办计数 */
export interface TodoSummary {
  homeworkCount?: number
  reviseCount?: number
  quoraCount?: number
  unReadSpecialCount?: number
  unReplySpecialCount?: number
  [k: string]: any
}

export async function getTodoSummary(): Promise<TodoSummary> {
  const r = await request<{ result: TodoSummary }>('/api/services/app/StudentUser/GetStudentUserTodoAsync', {
    method: 'GET',
    headers: APP_HEADERS
  })
  return r.result || {}
}

/** 学校设置（校名、背景图、学号长度等） */
export async function getAllSettings(): Promise<Record<string, any>> {
  const r = await request<{ result: Record<string, any> }>('/api/services/app/Setting/GetAllSettings', {
    method: 'GET',
    headers: APP_HEADERS
  })
  return r.result || {}
}

/** 系统功能开关 */
export async function getSystemSettings(): Promise<Record<string, any>> {
  const r = await request<{ result: Record<string, any> }>('/api/services/app/Setting/GetSystemSettingsAsync', {
    method: 'GET',
    headers: APP_HEADERS
  })
  return r.result || {}
}

/** 消息未读数：[{type, count}] */
export interface UnreadItem {
  type: number
  count: number
}

export async function getUnreadCounts(): Promise<UnreadItem[]> {
  const r = await request<{ result: UnreadItem[] }>('/api/services/app/Message/GetMyUnreadMessageCountAsync', {
    method: 'GET',
    headers: APP_HEADERS
  })
  return r.result || []
}

/** 系统消息列表 */
export interface SystemMessage {
  isRead?: boolean
  title?: string
  content?: string
  creationTime?: string
  messageType?: number
  parameter?: { id?: number; [k: string]: any }
  senderInfo?: { id?: number; userName?: string; fullName?: string; [k: string]: any }
  [k: string]: any
}

export async function getSystemMessages(skipCount = 0, maxResultCount = 20): Promise<SystemMessage[]> {
  const r = await request<{ result: SystemMessage[] }>(
    '/api/services/app/Message/GetMyDefaultSystemMessageListAsync',
    {
      method: 'POST',
      headers: APP_HEADERS,
      body: JSON.stringify({ skipCount, maxResultCount })
    }
  )
  return r.result || []
}

/** 标记消息已读 */
export async function setMessageRead(ids: number[]): Promise<any> {
  return request('/api/services/app/Message/SetMessageReadAsync', {
    method: 'POST',
    headers: APP_HEADERS,
    body: JSON.stringify({ ids })
  })
}

/** 能力许可类型 */
export type AbilityKind = 'Camera' | 'Album' | 'ScreenShot'

const ABILITY_LABEL: Record<AbilityKind, string> = {
  Camera: '相机',
  Album: '相册',
  ScreenShot: '截屏'
}

/** 查询某个应用能否打开相机/相册/截屏（官方 StoreAppControl 能力开关） */
export async function canIOpen(kind: AbilityKind, packageName = 'com.zykj.manage'): Promise<boolean> {
  const r = await request<{ result: boolean }>(
    `/api/services/app/StoreAppControl/CanIOpen${kind}Async?packageName=${encodeURIComponent(packageName)}`,
    { method: 'GET', headers: APP_HEADERS }
  )
  return r.result === true
}

export { ABILITY_LABEL }

/** 我的话题（学科，含颜色） */
export interface Topic {
  id: number
  name?: string
  content?: string
  sort?: number
  isActive?: boolean
  color?: string
}

export async function getMyTopics(): Promise<Topic[]> {
  const r = await request<{ result: Topic[] }>('/api/services/app/User/GetMyTopics', {
    method: 'GET',
    headers: APP_HEADERS
  })
  return r.result || []
}

/** 网址白名单（返回服务端加密串，仅作展示） */
export async function getWhiteUrls(): Promise<string> {
  const r = await request<{ result: string }>('/api/services/app/WebWhiteList/GetAllWhiteUrlAsync', {
    method: 'GET',
    headers: APP_HEADERS
  })
  return r.result || ''
}

/** 常用网站白名单 */
export async function getCommonWebSites(): Promise<any[]> {
  const r = await request<{ result: any[] }>('/api/services/app/WebWhiteList/GetAllCommonWebSiteAsync', {
    method: 'GET',
    headers: APP_HEADERS
  })
  return r.result || []
}

/** 公告详情（需 id） */
export interface NoticeInfo {
  id?: number
  title?: string
  content?: string
  creationTime?: string
  [k: string]: any
}

export async function getNotice(id: number): Promise<NoticeInfo | null> {
  const r = await request<{ result: NoticeInfo }>(`/api/services/app/Notice/GetNoticeAsync?id=${id}`, {
    method: 'GET',
    headers: APP_HEADERS
  })
  return r.result ?? null
}
