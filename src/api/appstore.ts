/**
 * 应用商店接口（依据官方 APK 反编译）
 * 官方 com.zykj.* 各应用均调用：
 *   GET {apiBase}/api/services/app/AppStore/CheckUpdateAsync?packageName={包名}&version={版本}&appType=0
 * 返回最新版本信息（含安装包地址 fileUrl、图标 icon、版本、大小等）。
 *
 * 旧版网站「下载应用」页即用此接口取最新安装包地址。
 */
import { request } from '@/utils/request'

export interface AppInfo {
  id?: number
  packageName: string
  name: string
  icon?: string
  fileUrl?: string
  size?: number
  versionCode?: number
  versionName?: string
  forceUpdate?: boolean
  description?: string
  summary?: string
  disabled?: boolean
  downloads?: number
  score?: number
  creationTime?: string
  lastModificationTime?: string
}

/** 查询某个包名的最新版本；命不中返回 null */
export async function checkUpdate(
  packageName: string,
  version = 11,
  appType = 0,
  baseUrl?: string
): Promise<AppInfo | null> {
  const resp = await request<{ result: AppInfo | null }>(
    `/api/services/app/AppStore/CheckUpdateAsync?packageName=${encodeURIComponent(packageName)}&version=${version}&appType=${appType}`,
    { method: 'GET', ...(baseUrl ? { baseUrl } : {}) }
  )
  return resp?.result ?? null
}

/**
 * 本校接口未收录的应用，用快照地址兜底。
 *
 * 说明：旧站用通用接口 `https://zyapi.loshop.com.cn` 查询，但该域名**未返回 CORS 头**，
 * 浏览器直接 fetch 会被跨域拦截（实测报错 "blocked by CORS policy"）。
 * 因此浏览器端不再请求通用接口，改用此前抓取到的地址作为快照兜底。
 */
const SNAPSHOT_FALLBACK: Record<string, AppInfo> = {
  'com.zhongyukejiao.learningexpert': {
    packageName: 'com.zhongyukejiao.learningexpert',
    name: '优客畅学',
    versionName: '1.1.3',
    versionCode: 10103,
    size: 70127973,
    lastModificationTime: '2026-02-13',
    description: '本校接口未收录，使用快照地址',
    fileUrl:
      'http://sxz.alicdn.zykj.org/manage_v2/res/1/20260728/9dda09508a8d11f18695b5b2e064b0e4/' +
      encodeURIComponent('优课畅学_master_20260213.05_release_10103_1.1.3.apk')
  }
}

/** 查询（本校接口优先；未命中时用快照兜底） */
export async function checkUpdateWithFallback(packageName: string): Promise<AppInfo | null> {
  const local = await checkUpdate(packageName).catch(() => null)
  if (local && (local.fileUrl || local.name)) return local
  return SNAPSHOT_FALLBACK[packageName] ?? null
}

/** 下载页展示的应用清单（复刻旧站「下载应用」表格） */
export interface AppEntry {
  key: string
  label: string
  packageName: string
  note?: string
}

export const DOWNLOAD_APPS: AppEntry[] = [
  { key: 'note', label: '云笔记', packageName: 'com.friday.cloudsnote' },
  { key: 'exam', label: '新测评', packageName: 'com.zykj.evaluation' },
  { key: 'learn', label: '优客畅学', packageName: 'com.zhongyukejiao.learningexpert', note: '本校接口未收录，使用快照地址' },
  { key: 'user', label: '用户中心', packageName: 'com.zykj.manage' },
  { key: 'mistake', label: '错题本', packageName: 'com.zykj.mistake' },
  { key: 'web', label: '在线专栏', packageName: 'com.zykj.subscriber', note: '安装包名为「浏览器」' },
  { key: 'chat', label: '随身答', packageName: 'com.zykj.student.dialogue' }
]

/** 文件大小文本（与官方 blankj 一致：3 位小数、无空格、B/KB/MB/GB） */
export function formatSize(bytes?: number): string {
  if (!bytes || bytes < 0) return '—'
  if (bytes < 1024) return bytes.toFixed(3) + 'B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(3) + 'KB'
  if (bytes < 1024 * 1024 * 1024) return (bytes / 1024 / 1024).toFixed(3) + 'MB'
  return (bytes / 1024 / 1024 / 1024).toFixed(3) + 'GB'
}
