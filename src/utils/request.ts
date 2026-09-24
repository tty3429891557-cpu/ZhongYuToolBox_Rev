/**
 * 统一请求封装（基于 fetch）
 * 自动附加 Authorization: Bearer <token>，统一 JSON 解析与错误处理。
 * 401 时自动恢复：先 refreshToken，失败再用记录的凭据自动重新登录，然后重试一次。
 */
import { API_BASE_URL } from '@/config'

/**
 * 当前学校 API 基地址。
 *
 * 修复：`API_BASE_URL` 是 config 在**模块加载时**固化的常量，
 * 登录后 localStorage 里的 apiBaseUrl 会换成真实学校，但常量不会变。
 * 于是所有用相对路径的接口（测评概览 / 题目分析 / 错题 / 随身答 / 专栏 / 图库…）
 * 在登录到非默认学校（如 bjbsz）后仍打向默认学校 sxz —— 404 或取到别人的数据。
 * 现改为每次发请求时动态读取。
 */
export function currentApiBase(): string {
  return localStorage.getItem('apiBaseUrl') || API_BASE_URL
}

export interface RequestOptions extends RequestInit {
  /** 是否跳过 token 注入（如登录接口） */
  skipAuth?: boolean
  /** 基础地址，默认 API_BASE_URL */
  baseUrl?: string
  /** 返回原始 Response（不解析 json） */
  raw?: boolean
  /** 跳过 401 自动恢复（用于恢复流程内部的请求，防止递归/死循环） */
  skipRecover?: boolean
}

/** 正在进行的恢复流程（并发 401 只处理一次） */
let recovering: Promise<boolean> | null = null

/** 尝试恢复登录态：先刷新 token，失败则自动重新登录 */
async function tryRecover(): Promise<boolean> {
  if (recovering) return recovering
  recovering = (async () => {
    const { useAuthStore } = await import('@/stores/auth')
    const auth = useAuthStore()
    try {
      const refreshed = await auth.doRefresh()
      if (refreshed) return true
      await auth.autoRelogin()
      return true
    } catch {
      return false
    }
  })()
  try {
    return await recovering
  } finally {
    recovering = null
  }
}

async function redirectLogin() {
  try {
    const { default: router } = await import('@/router')
    router.push('/login')
  } catch {
    /* ignore */
  }
}

/** 默认请求超时（ms）。学校服务器/代理挂起时若无超时，界面会永久转圈（表现为「用着用着卡死」） */
const DEFAULT_TIMEOUT_MS = 30000

export async function request<T = any>(
  url: string,
  options: RequestOptions = {}
): Promise<T> {
  const { skipAuth, baseUrl, raw, skipRecover, headers, ...rest } = options
  const token = localStorage.getItem('token')

  const finalHeaders: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(headers as Record<string, string>)
  }
  if (!skipAuth && token) {
    finalHeaders['Authorization'] = `Bearer ${token}`
  }

  const fullUrl = url.startsWith('http')
    ? url
    : `${baseUrl || currentApiBase()}${url}`

  // 超时控制：调用方已传 signal 时复用（用 AbortSignal.any 合并，不支持则退化为调用方的 signal）
  const outerSignal = rest.signal
  const timeoutCtl = typeof AbortController !== 'undefined' ? new AbortController() : null
  const timer = timeoutCtl
    ? window.setTimeout(() => timeoutCtl.abort(), DEFAULT_TIMEOUT_MS)
    : 0
  let signal: AbortSignal | undefined = outerSignal ?? undefined
  if (timeoutCtl) {
    const anyFn = (AbortSignal as any)?.any
    signal = outerSignal && typeof anyFn === 'function'
      ? anyFn.call(AbortSignal, [outerSignal, timeoutCtl.signal])
      : timeoutCtl.signal
  }

  let resp: Response
  try {
    resp = await fetch(fullUrl, {
      ...rest,
      signal,
      headers: finalHeaders
    })
  } catch (e: any) {
    if (timeoutCtl && timeoutCtl.signal.aborted && !outerSignal?.aborted) {
      throw new Error(`请求超时（${DEFAULT_TIMEOUT_MS / 1000}s）：${fullUrl}`)
    }
    throw e
  } finally {
    if (timer) window.clearTimeout(timer)
  }

  // 401：尝试恢复登录态并重试一次
  if (resp.status === 401 && !skipAuth && !skipRecover) {
    const recovered = await tryRecover()
    if (recovered) {
      return request<T>(url, { ...options, skipRecover: true })
    }
    const { useAuthStore } = await import('@/stores/auth')
    useAuthStore().logout()
    await redirectLogin()
    throw new Error('登录已过期，请重新登录')
  }

  if (!resp.ok) {
    let msg = `请求失败: ${resp.status}`
    try {
      const errJson = await resp.json()
      msg = errJson.error?.message || errJson.message || msg
    } catch {
      /* ignore */
    }
    throw new Error(msg)
  }

  if (raw) return resp as unknown as T
  return (await resp.json()) as T
}

/**
 * ABP 框架接口返回结构：{ result, targetUrl, success, error, unAuthorizedRequest }
 *
 * 修复：原实现 `resp && 'result' in resp`，当服务端返回的是**字符串/数字**（部分
 * 接口直接返回纯文本或 base64）时，`in` 运算符对原始值会抛
 * `TypeError: Cannot use 'in' operator to search for 'result' in xxx`，
 * 且这个错误会绕过调用方的 try/catch 语义变成「莫名其妙的报错」。
 * 现先判类型再用 in。
 */
export function unwrapResult<T = any>(resp: any): T {
  if (resp && typeof resp === 'object' && 'result' in resp) return resp.result
  return resp
}
