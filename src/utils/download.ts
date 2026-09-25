/**
 * 下载与复制的统一工具
 *
 * 解决两类长期存在的兼容性问题：
 *
 * 1. **下载在 Firefox / 部分浏览器上不触发**
 *    常见写法是 `const a = document.createElement('a'); a.href = url; a.click()`。
 *    这有两个坑：
 *      - 元素没有 appendChild 到 DOM，Firefox 不会触发下载；
 *      - `URL.revokeObjectURL()` 紧跟在 `click()` 之后同步执行，
 *        部分浏览器会把还没开始的下载直接取消。
 *    正确做法：挂进 DOM → click → 延后（60s）再移除并 revoke。
 *
 * 2. **navigator.clipboard 在非安全上下文不可用**
 *    站点跑在 `http://192.168.x.x` 或 `http://公网IP` 时 Clipboard API 直接 reject，
 *    原实现一律提示「复制失败」。这里回退到 `execCommand('copy')` + 临时 textarea。
 */

/** 触发浏览器下载一个 Blob */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.style.display = 'none'
  a.rel = 'noopener'
  document.body.appendChild(a)
  a.click()
  // 延后回收：立即 revoke 会让部分浏览器取消尚未开始的下载
  window.setTimeout(() => {
    a.remove()
    URL.revokeObjectURL(url)
  }, 60000)
}

/** 下载一个 URL 对应的内容（先取成 blob，避免跨域时 download 属性被忽略） */
export async function downloadUrl(url: string, filename: string): Promise<void> {
  // cache:'no-store'：学校 OSS（ezy-sxz）不带 Vary: Origin，页面里 <img> 的
  // no-cors 响应（无 ACAO 头）会污染缓存，后续 fetch(cors) 命中同一缓存会被
  // CORS 检查拒绝 →「Failed to fetch」。下载必须绕过缓存直连网络。
  const resp = await fetch(url, { cache: 'no-store' })
  if (!resp.ok) throw new Error(`下载失败：HTTP ${resp.status}`)
  const blob = await resp.blob()
  if (!blob.size) throw new Error('下载内容为空')
  downloadBlob(blob, filename)
}

/**
 * 复制文本到剪贴板。
 * 优先 Clipboard API，不可用时回退 execCommand。
 * @returns 是否成功
 */
export async function copyText(text: string): Promise<boolean> {
  if (!text) return false
  try {
    if (navigator.clipboard?.writeText && window.isSecureContext) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    /* 继续走回退方案 */
  }
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.setAttribute('readonly', '')
    ta.style.position = 'fixed'
    ta.style.top = '-1000px'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    ta.setSelectionRange(0, ta.value.length)
    const ok = document.execCommand('copy')
    ta.remove()
    return ok
  } catch {
    return false
  }
}
