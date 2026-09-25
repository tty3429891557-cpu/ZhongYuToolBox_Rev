/**
 * 资源代理工具（复刻旧 index.js window.proxyUrl / proxyImgSrc / detectLocalProxy）
 * 中育资源默认走远端代理 zytbdownloadagent.loshop.com.cn，
 * 若本机运行 tbHelper 加速插件（127.0.0.1:5005）则切换到本地代理。
 *
 * 同时提供全局轮询 startProxyPolling / stopProxyPolling / getProxyBaseUrl（供 AppLayout 使用）。
 */

import { PROXY_REMOTE, PROXY_LOCAL, PROXY_LOCAL_PING } from '@/config'

/** 当前生效的代理基地址（被 proxyUrl / proxyImgSrc / getProxyBaseUrl 共用） */
let proxyBaseUrl: string = PROXY_REMOTE

/* ============================================================
 * 同源转发代理（解决「需要 CORS 的抓取」）
 * ------------------------------------------------------------
 * 背景：中育 CDN（*.zyai.cc / *alicdn* / OSS）的 PDF 等二进制资源**不返回
 * Access-Control-Allow-Origin**，因此 `<img>` 能显示（图片不需要 CORS），
 * 但 pdfjs.getDocument(url) 这类**用 fetch 读取字节**的场景会被浏览器直接拦截：
 *   "blocked by CORS policy: No 'Access-Control-Allow-Origin' header"
 * → 在线专栏/课程的 PDF 就表现为「点开一直转圈 / Failed to fetch」。
 *
 * 站点宿主程序（中育ToolBox.exe）本身在 **同源** 暴露了转发端点：
 *   GET /proxy/<目标URL>   或   GET /proxy?u=<URL编码目标>
 * 转发响应天然带 CORS 头，且同源请求根本不涉及跨域限制。
 * 因此这里优先用「当前页面同源 /proxy/」，其次回落本机 tbHelper(5005)，
 * 最后才直连（直连在无代理环境下仍可能被 CORS 拦截，属最佳努力）。
 * ============================================================ */

/** 同源转发地址前缀（相对路径，随页面 origin 自动生效） */
const SAME_ORIGIN_PROXY = '/proxy/'

/** 同源 /proxy/ 是否可用（null=未探测） */
let sameOriginOk: boolean | null = null
/** 正在进行中的同源探测，避免并发重复探测 */
let sameOriginProbe: Promise<boolean> | null = null

/** 探测同源 /proxy/ 是否可用（带超时，失败即视为不可用） */
async function pingSameOriginProxy(): Promise<boolean> {
  if (sameOriginProbe) return sameOriginProbe
  sameOriginProbe = (async () => {
    const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null
    const timer = ctl ? window.setTimeout(() => ctl.abort(), 2500) : 0
    try {
      const resp = await fetch(SAME_ORIGIN_PROXY + 'ping', {
        method: 'GET',
        signal: ctl ? ctl.signal : undefined
      })
      // 静态站点（如 dev / 纯静态托管）对不存在的 /proxy/ 可能返回 404/HTML，
      // 因此必须校验响应体为约定的 'pong'，否则会把 404 误判成可用。
      if (!resp.ok) return false
      const txt = await resp.text()
      return txt.trim() === 'pong'
    } catch {
      return false
    } finally {
      if (timer) window.clearTimeout(timer)
    }
  })()
  try {
    return await sameOriginProbe
  } finally {
    sameOriginProbe = null
  }
}

/** 拼接转发地址（绝对 URL 走 path 形式，避免 query 形式里 encodeURIComponent 的坑） */
function joinProxy(base: string, url: string): string {
  // 目标 URL 里可能带 // 与 ?，直接拼在 path 后会被部分服务器/浏览器改写，
  // 因此对整段做一次 encodeURIComponent 放进 query 更稳妥；但宿主两种都支持，
  // 这里用 path 形式并对 :// 做保护（宿主按 {**target} 捕获，保留原样）。
  return base.endsWith('/') ? base + url : base + '/' + url
}

/**
 * 需要 CORS 的抓取地址（pdfjs / arraybuffer / blob 下载等）。
 *
 * 与 proxyImgSrc 的区别：proxyImgSrc 追求「图片能显示」，已知 CDN 直连即可；
 * 本函数追求「能读到字节」，因此**已知无 CORS 头的 CDN 也必须走转发**。
 *
 * @param url 原始资源地址
 * @returns 可直接交给 fetch / pdfjs.getDocument 的地址
 */
export async function proxyCorsUrl(url: string): Promise<string> {
  if (!url || typeof url !== 'string') return url
  // 已经是同源 / 本地转发地址，直接返回
  if (url.startsWith(SAME_ORIGIN_PROXY) || url.startsWith(PROXY_LOCAL)) return url
  // 相对路径（如 '/xxx.pdf'）本身就是同源，无需转发
  if (url.startsWith('/') && !url.startsWith('//')) return url
  // 绝对 URL 但与本页面同源：也无需转发（同源无跨域限制）
  try {
    const abs = new URL(url, location.href)
    if (abs.origin === location.origin) return url
  } catch {
    /* 非标准 URL，继续走转发 */
  }

  // ① 同源 /proxy/（宿主程序自带，最稳，且无跨域限制）
  if (sameOriginOk === null) sameOriginOk = await pingSameOriginProxy()
  if (sameOriginOk) return joinProxy(SAME_ORIGIN_PROXY, url)

  // ② 本机 tbHelper(5005)
  if (await pingLocalProxy()) return joinProxy(PROXY_LOCAL, url)

  // ③ 直连（尽力而为；无 CORS 头的源仍可能被拦截）
  return url
}

/** 拼接资源代理地址 */
export function proxyUrl(url: string): string {
  if (!url) return url
  return proxyBaseUrl.endsWith('/') ? proxyBaseUrl + url : proxyBaseUrl + '/' + url
}

/**
 * 图片代理：可选直连的源直接换域名/升 https，其余走代理
 *
 * 说明（2026-09-23 实测）：远端下载代理 `zytbdownloadagent.loshop.com.cn` 随站点关停，
 * 对部分图片会返回非图片内容，浏览器以 ERR_BLOCKED_BY_ORB 拦截。
 * 而 OSS / 中育自有 CDN 本身可以直连（实测 HTTP 200），
 * 因此对以下主机改为**直连**，不再经代理中转，避免因代理失效导致图片加载不出来。
 */
export function proxyImgSrc(url: string): string {
  if (!url || typeof url !== 'string') return url
  if (url.startsWith('http://sxz.alicdn.zykj.org/')) {
    return url.replace('http://sxz.alicdn.zykj.org/', 'https://ezy-sxz.oss-cn-hangzhou.aliyuncs.com/')
  }
  // OSS / 中育 CDN 直连（并尽量升级为 https）
  if (/^https?:\/\/[^/]*\.(aliyuncs\.com|zyai\.cc|zykj\.org)\//i.test(url)) {
    return url.replace(/^http:\/\//i, 'https://')
  }
  return proxyUrl(url)
}

/** 返回当前代理基地址 */
export function getProxyBaseUrl(): string {
  return proxyBaseUrl
}

type ProxyChangeCb = (localOk: boolean, isWindows: boolean) => void

let pollingTimer: number | null = null
let lastLocalOk: boolean | null = null

function isWin(): boolean {
  return navigator.userAgent.indexOf('Windows') !== -1
}

/**
 * 探测本地加速插件。
 * 修复：原实现没有超时。若 5005 端口被防火墙「静默丢包」（不返回 RST），
 * fetch 会一直挂着；而 startProxyPolling 每 15s 触发一次 tick，
 * 挂起的请求会不断堆积（连接数与内存持续增长），长时间运行后明显变卡。
 */
async function pingLocalProxy(): Promise<boolean> {
  const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null
  const timer = ctl ? window.setTimeout(() => ctl.abort(), 2500) : 0
  try {
    const resp = await fetch(PROXY_LOCAL_PING, {
      method: 'GET',
      mode: 'cors',
      signal: ctl ? ctl.signal : undefined
    })
    return resp.ok
  } catch {
    return false
  } finally {
    if (timer) window.clearTimeout(timer)
  }
}

/** 全局轮询探测本地加速插件（供 AppLayout 在启动时调用） */
export function startProxyPolling(onChange: ProxyChangeCb): void {
  stopProxyPolling()
  let inFlight = false
  const tick = async () => {
    // 上一次探测还没返回就跳过本轮，避免慢/丢包环境下并发堆积
    if (inFlight) return
    inFlight = true
    try {
      const localOk = await pingLocalProxy()
      proxyBaseUrl = localOk ? PROXY_LOCAL : PROXY_REMOTE
      if (lastLocalOk !== localOk) {
        lastLocalOk = localOk
        onChange(localOk, isWin())
      }
    } finally {
      inFlight = false
    }
  }
  void tick()
  pollingTimer = window.setInterval(() => void tick(), 15000)
}

export function stopProxyPolling(): void {
  if (pollingTimer !== null) {
    clearInterval(pollingTimer)
    pollingTimer = null
  }
}

/** 一次性探测本地加速插件（供页面级使用），含 toast 提示，并更新 proxyBaseUrl */
export async function detectLocalProxy(): Promise<void> {
  const localOk = await pingLocalProxy()
  proxyBaseUrl = localOk ? PROXY_LOCAL : PROXY_REMOTE
  if (lastLocalOk === localOk) return
  lastLocalOk = localOk
  const windows = isWin()
  if (localOk) {
    toast('本地加速服务已启用', '', 3000)
  } else if (windows) {
    toast(
      '加速插件未检测到',
      '检测到您使用的是 Windows 系统，建议下载并运行加速插件以提升资源加载速度。不使用加速插件不会影响使用。',
      0,
      '<a href="https://wumama.lanzouw.com/iG92334tbeeb" target="_blank" rel="noopener" style="color:#fff;text-decoration:none;background:#007bff;padding:6px 12px;border-radius:4px;">下载 tbHelperInstaller.exe</a>'
    )
  }
}

function toast(title: string, message: string, autoCloseMs: number, btnHtml = '') {
  const id = 'proxyToast'
  if (document.getElementById(id)) return
  const div = document.createElement('div')
  div.id = id
  div.style.cssText =
    'position:fixed;bottom:32px;right:32px;z-index:9999;max-width:400px;background:#333;color:#fff;padding:16px 24px;border-radius:8px;box-shadow:0 4px 12px rgba(0,0,0,0.5);opacity:0.95;font-size:14px;line-height:1.4;'
  div.innerHTML = `
    <div style="font-weight:bold;margin-bottom:8px;">${title}</div>
    ${message ? `<div style="margin-bottom:12px;">${message}</div>` : ''}
    <div style="display:flex;gap:8px;flex-wrap:wrap;">
      ${btnHtml}
      <button style="padding:6px 12px;border:none;border-radius:4px;background:#555;color:#fff;cursor:pointer;">关闭</button>
    </div>`
  div.querySelector('button')!.addEventListener('click', () => div.remove())
  document.body.appendChild(div)
  if (autoCloseMs > 0) {
    setTimeout(() => {
      const t = document.getElementById(id)
      if (t) t.remove()
    }, autoCloseMs)
  }
}
