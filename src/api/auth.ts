/**
 * 登录相关接口（复刻 index.js login_btn 逻辑）
 */
import { request } from '@/utils/request'
import { API_BASE_URL } from '@/config'

export interface LoginResult {
  accessToken: string
  refreshToken: string
  expireInSeconds: number
  refreshExpireInSeconds: number
}

export interface UserInfo {
  realName?: string
  photo?: string
  schoolCode?: string
  [key: string]: any
}

/** 学校发现（其它学校自适应登录） */
export interface SchoolInfo {
  name: string
  server: string
  webServer?: string
  lcid?: string
}

/**
 * 查询学校信息。
 * 注意：未知学校代码时接口仍返回 200，但内容为 `{"name":"Unknown"}`（没有 server 字段），
 * 旧站未做判断会导致后续 `info.server.startsWith` 直接抛错，这里补上校验。
 */
export async function discoverSchool(code: string): Promise<SchoolInfo> {
  const resp = await fetch(`https://hagateway.zykj.org/api/discovery/${encodeURIComponent(code)}`)
  if (!resp.ok) throw new Error('学校代码无效')
  let info: SchoolInfo
  try {
    info = await resp.json()
  } catch {
    throw new Error('学校信息解析失败')
  }
  if (!info || !info.server || info.name === 'Unknown') {
    throw new Error(`学校代码「${code}」无效或未被收录`)
  }
  return info
}

/**
 * 由学校代码与 discovery 结果推导可用的 API 基地址候选（按优先级）。
 *
 * 2026-09-23 调整：**优先学校原生域名**（`{code}.api.zykj.org`），
 * 这也是官方 App 实际使用的地址；实测与作者 loshop 代理能力完全一致。
 * 作者的 loshop 服务随站点停运可能随时下线，故只作为最后的兜底候选。
 */
export function buildApiBaseCandidates(code: string, discoveredServer: string): string[] {
  const list: string[] = []
  const push = (u?: string) => {
    if (u && !list.includes(u)) list.push(u)
  }
  // 1) discovery 给出的学校服务器（官方 App 用的就是这个）
  push(discoveredServer)
  // 2) 由学校代码直接推导的原生地址
  push(`http://${code}.api.zykj.org`)
  // 3) 兜底：作者的 loshop 代理域名（仅在原生地址不可用时才会用到）
  const knownProxy: Record<string, string> = {
    sxz: 'https://zyapi.loshop.com.cn',
    sxzsyxx: 'https://zyapi-sxzsyxx.loshop.com.cn',
    bjbsz: 'https://zyapi-bjbsz.loshop.com.cn'
  }
  push(knownProxy[code])
  const m = /^https?:\/\/([^.]+)\.[^/]*zykj\.org/i.exec(discoveredServer || '')
  if (m) push(`https://zyapi-${m[1]}.loshop.com.cn`)
  return list
}

export async function loginApi(
  userName: string,
  password: string,
  apiBaseUrl: string = API_BASE_URL
): Promise<LoginResult> {
  const data = await request<{ result: LoginResult; error: any }>(
    `${apiBaseUrl}/api/TokenAuth/Login`,
    {
      method: 'POST',
      skipAuth: true,
      body: JSON.stringify({ userName, password, clientType: 1 })
    }
  )
  if (!data.result) throw new Error(data.error?.message || '登录失败')
  return data.result
}

export async function getUserInfo(apiBaseUrl: string, token: string): Promise<UserInfo> {
  const data = await request<{ result: UserInfo }>(
    `${apiBaseUrl}/api/services/app/User/GetInfoAsync`,
    { method: 'GET', baseUrl: apiBaseUrl, skipAuth: true, headers: { Authorization: `Bearer ${token}` } }
  )
  return data.result
}

export async function refreshTokenApi(
  apiBaseUrl: string,
  refreshToken: string,
  token: string
): Promise<LoginResult> {
  const data = await request<{ result: LoginResult }>(
    `${apiBaseUrl}/api/TokenAuth/RefreshToken`,
    {
      method: 'POST',
      baseUrl: apiBaseUrl,
      skipAuth: true,
      headers: { 'Content-Type': 'application/json', refreshtoken: refreshToken, Authorization: `Bearer ${token}` }
    }
  )
  return data.result
}
