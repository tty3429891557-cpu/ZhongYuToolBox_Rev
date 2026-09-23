/**
 * 领创 (Linspirer) 模块接口（复刻 linspirer.js）
 * 独立于中育功能，仅共享用户名。所有请求经 AES-CBC 加密，响应为加密或明文。
 *
 * 2026-09-23 调整：不再依赖作者服务器中转。
 * 实测领创云真实接口是 https://cloud.linspirer.com:883/public-interface.php，
 * 作者的 public-interface.php 只是对它的转发。但领创服务端不返回 CORS 头，
 * 浏览器无法直连，因此按以下顺序尝试（任一成功即止）：
 *   1) 本地代理  http://127.0.0.1:5005/proxy/<目标>   （作者的"下载加速插件"，已支持 POST）
 *   2) 源站直连  https://cloud.linspirer.com:883/...  （浏览器会被 CORS 拦截，保留给非浏览器环境）
 *   3) 作者中转  zytb-linspirer-api.loshop.com.cn     （随站点停运，最后兜底）
 * 本地代理脚本随程序附带（local-proxy.ps1 / 启动本地代理.bat），零依赖、Windows 自带 PowerShell 即可运行。
 */
import { LINSPIRER, PROXY_LOCAL } from '@/config'
import { linspirerEncrypt, linspirerDecrypt, md5 } from '@/utils/crypto'

/** 领创云源站（真实接口） */
export const LINSPIRER_ORIGIN = 'https://cloud.linspirer.com:883/public-interface.php'

/** 实际生效的调用端点（诊断用） */
export let lastLinspirerEndpoint: string = ''

export interface LinspirerApp {
  id?: string
  appid?: string
  name?: string
  appname?: string
  packagename?: string
  pkg?: string
  iconpath?: string
  icon?: string
  appicon?: string
  path?: string
  version?: string
  appversion?: string
  description?: string
  desc?: string
  _source?: string
  [key: string]: any
}

export interface LinspirerSession {
  swdid: string
  account: string
  model: string
}

/** JSON-RPC 信封调用（params 加密）。按候选端点顺序尝试，直到某个成功为止。 */
async function linspirerCall<T = any>(
  method: string,
  paramsObj: Record<string, any>
): Promise<T> {
  const paramsJson = JSON.stringify(paramsObj)
  const envelope = {
    id: 1,
    '!version': 6,
    jsonrpc: '2.0',
    is_encrypt: true,
    client_version: LINSPIRER.CLIENT_VERSION,
    method,
    params: linspirerEncrypt(paramsJson)
  }
  const body = JSON.stringify(envelope)

  const candidates: Array<{ url: string; label: string }> = [
    // ① 宿主程序内置代理（与站点同源，连 CORS 都不需要；程序开着就一定可用）
    { url: `${location.origin}/proxy?u=${encodeURIComponent(LINSPIRER_ORIGIN)}`, label: '内置代理' },
    // ② 作者"下载加速插件"式本地代理（若在 5005 端口运行）
    { url: `${PROXY_LOCAL}${LINSPIRER_ORIGIN}`, label: '本地代理(5005)' },
    // ③ 领创源站直连（浏览器会被 CORS 拦截，保留给非浏览器环境）
    { url: LINSPIRER_ORIGIN, label: '领创源站' },
    // ④ 作者中转（随站点停运，最后兜底）
    { url: LINSPIRER.API, label: '作者中转' }
  ]

  let lastErr: any = null
  for (const cand of candidates) {
    try {
      const resp = await fetch(cand.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body
      })
      if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${resp.statusText}`)
      const text = await resp.text()
      let result: any
      try {
        result = JSON.parse(linspirerDecrypt(text.trim()))
      } catch {
        result = JSON.parse(text)
      }
      lastLinspirerEndpoint = cand.label
      if (result.code !== 0) {
        throw new Error(result.msg || result.message || (result.data ?? JSON.stringify(result)))
      }
      return result as T
    } catch (e) {
      // 网络层失败（含 CORS 拦截的 TypeError: Failed to fetch）→ 尝试下一个端点；
      // 业务层错误（服务端已应答）直接抛出，不再换端点。
      const msg = String(e?.message || e)
      if (/^HTTP \d+/.test(msg) || msg.startsWith('{') || msg.includes('Device is not allow')) throw e
      lastErr = e
    }
  }
  throw new Error(
    `无法连接领创接口（浏览器直连被 CORS 拦截，且中转服务不可用）：${lastErr?.message || lastErr}`
  )
}

/** 绑定设备 */
export async function bindDevice(
  swdid: string,
  account: string,
  model: string
): Promise<any> {
  const deviceInfo = {
    brand: '',
    deviceid: '',
    email: account,
    isrooted: false,
    model,
    romavailablesize: 0,
    romtotalsize: 0,
    romversion: '',
    simserialnumber: 'unknown',
    swdid,
    systemversion: '',
    token: '',
    wifimacaddress: ''
  }
  return linspirerCall('com.linspirer.device.setdevice', deviceInfo)
}

/** 获取全部应用（策略应用 + 兴趣应用） */
export async function getAllApps(
  swdid: string,
  account: string,
  model: string
): Promise<LinspirerApp[]> {
  const inner = {
    swdid,
    email: account,
    model,
    launcher_version: LINSPIRER.CLIENT_VERSION
  }
  const result = await linspirerCall<any>('com.linspirer.tactics.gettactics', inner)
  const data = result.data || {}
  const apps1 = (data.app_tactics && data.app_tactics.applist) || []
  const apps2 = data.interest_applist || []
  apps1.forEach((a: LinspirerApp) => (a._source = '策略应用'))
  apps2.forEach((a: LinspirerApp) => (a._source = '兴趣应用'))
  return [...apps1, ...apps2]
}

/** 获取应用详情 */
export async function getAppDetail(
  swdid: string,
  account: string,
  model: string,
  appid: string
): Promise<any> {
  const inner = {
    swdid,
    email: account,
    model,
    launcher_version: LINSPIRER.CLIENT_VERSION,
    appid
  }
  return linspirerCall('com.linspirer.app.getdetail', inner)
}

/** 获取用户信息（用于密码计算中的 studentId） */
export async function getUserInfo(
  swdid: string,
  account: string,
  model: string
): Promise<any> {
  const inner = {
    swdid,
    email: account,
    model,
    launcher_version: LINSPIRER.CLIENT_VERSION
  }
  const result = await linspirerCall<any>('com.linspirer.user.getuserinfo', inner)
  return result.data
}

/**
 * 领创静态资源地址（图标 / APK）。
 * 原实现把 cloud.linspirer.com 换成作者服务器代理；实测源站资源经 <img>/<a> 直接可用
 * （这两类加载不受 CORS 限制），故改为**直连源站**，不再经过作者服务器。
 */
export function linspirerProxyUrl(url?: string): string {
  if (!url) return ''
  // http 源在 http 页面下可用；若站点日后挂 https，可把 880 换成 883
  return url
}

/**
 * 计算管理员密码（adminCode 算法，复刻 linspirer.js）。
 * **纯本地计算，不联网**：seed = yyyyMMdd + swdid + 固定UUID (+ studentId)。
 * studentId 可选——有它结果更精确；没有也能算出（部分设备两种结果一致）。
 */
export function calcAdminCode(swdid: string, studentId?: string | null): string {
  if (!swdid || swdid === 'unknown') return 'unknown'
  const now = new Date()
  const dateStr =
    now.getFullYear() +
    String(now.getMonth() + 1).padStart(2, '0') +
    String(now.getDate()).padStart(2, '0')
  let seed = dateStr + swdid + LINSPIRER.FIXED_UUID
  if (studentId) seed += studentId
  const md5Hex = md5(seed)
  const last8Hex = md5Hex.slice(-8)
  let decStr = String(parseInt(last8Hex, 16))
  if (decStr.length > 8) decStr = decStr.slice(-8)
  return decStr.length >= 6 ? decStr.slice(0, 6) : 'unknown'
}

/**
 * 计算密码（默认不联网）。
 * 传入 studentId 则用它计算；不传则不带 studentId 计算。
 * 只有在用户希望「自动取 studentId」时才需要联网（调用 getUserInfo）。
 */
export async function calcPassword(
  swdid: string,
  account: string,
  model: string,
  studentId?: string | null,
  opts: { fetchStudentId?: boolean } = {}
): Promise<string> {
  let sid = studentId
  if (!sid && opts.fetchStudentId) {
    try {
      const info = await getUserInfo(swdid, account, model)
      sid = String(info.id)
    } catch {
      sid = null
    }
  }
  return calcAdminCode(swdid, sid)
}
