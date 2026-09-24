import { onMounted, onBeforeUnmount } from 'vue'

/**
 * 在同源 iframe 内持续注入样式 / 移除元素的 composable。
 * 复刻旧 index.js 中针对选课(CK) iframe#ck_iframe 的 MutationObserver 逻辑：
 *  - 每 intervalMs 轮询直到 iframe 文档可访问
 *  - 注入带 !important 的 CSS（去重，已存在则覆盖）
 *  - 安装 MutationObserver 在 DOM 变动时持续重应用
 *  - 监听 iframe load 事件，重载后重新应用并重建 observer
 *
 * 注意：仅对同源 iframe 有效（跨域 iframe 无法访问 contentDocument）。
 */
export interface IframeInjectOptions {
  /** 目标 iframe 的 id */
  iframeId: string
  /** 需要移除的类名（如 'header-box'），传空则不移除 */
  removeClass?: string
  /** 需要强制设置高度的容器 id（如 'actScrollList'），传空则不处理 */
  targetId?: string
  /** 注入的 CSS 文本（如 '#actScrollList { height: 70vh !important; ... }'） */
  cssText?: string
  /** 注入 style 元素的 id，便于去重 */
  styleId?: string
  /** 轮询间隔（ms），默认 100 */
  intervalMs?: number
}

export function useIframeInject(options: IframeInjectOptions) {
  const {
    iframeId,
    removeClass = '',
    targetId = '',
    cssText = '',
    styleId = 'injected-iframe-style',
    intervalMs = 100
  } = options

  let intervalHandle: number | null = null
  let observerInstalled = false

  const TARGET_H = '71vh'

  /**
   * 幂等写入内联高度。
   * 修复：原实现无条件 `style.setProperty(...)`。即便值完全相同，浏览器也会派发
   * attributes 变更记录；而 MutationObserver 的 attributeFilter 恰好包含 'style'，
   * 于是形成「改样式 → 触发观察 → 再改样式 → 再触发」的**自激循环**，
   * 选课页 CPU 长期 100%、页面越用越卡（即用户反馈的「用着用着卡死」）。
   */
  function setHeightOnce(el: HTMLElement, prop: string, value: string): boolean {
    const el2 = el as any
    if (el2.style.getPropertyValue(prop) === value && el2.style.getPropertyPriority(prop) === 'important') {
      return false
    }
    el2.style.setProperty(prop, value, 'important')
    return true
  }

  function applyOnce(doc: Document): boolean {
    let changed = false
    // 1) 移除目标类
    if (removeClass) {
      const header = doc.querySelector('.' + removeClass)
      if (header) {
        header.remove()
        changed = true
      }
    }
    // 2) 注入 CSS（去重）
    if (cssText) {
      let styleEl = doc.getElementById(styleId)
      if (!styleEl) {
        const s = doc.createElement('style')
        s.id = styleId
        s.type = 'text/css'
        s.appendChild(doc.createTextNode(cssText))
        styleEl = s
        const head = doc.head || doc.getElementsByTagName('head')[0] || doc.documentElement
        head.appendChild(styleEl)
        changed = true
      } else if (styleEl.textContent !== cssText) {
        styleEl.textContent = cssText
        changed = true
      }
    }
    // 3) 直接设置元素内联高度（额外保险，幂等）
    if (targetId) {
      const act = doc.getElementById(targetId)
      if (act) {
        const c = (act as any)
        if (
          setHeightOnce(c as HTMLElement, 'height', TARGET_H) ||
          setHeightOnce(c as HTMLElement, 'max-height', TARGET_H) ||
          setHeightOnce(c as HTMLElement, 'min-height', TARGET_H)
        ) {
          changed = true
        }
      }
    }
    return changed
  }

  function installObserver(doc: Document) {
    if (observerInstalled) return
    try {
      const root = doc.body || doc.documentElement
      if (!root) return
      const mo = new MutationObserver((mutations) => {
        let need = false
        for (const m of mutations) {
          if (m.addedNodes && m.addedNodes.length) {
            need = true
            break
          }
          if (m.type === 'attributes') {
            need = true
            break
          }
        }
        if (need) {
          try {
            applyOnce(doc)
          } catch (e) {
            console.warn('[useIframeInject] observer applyOnce 出错:', e)
          }
        }
      })
      mo.observe(root, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['class', 'id', 'style']
      })
      ;(doc as any)._injectedMutationObserver = mo
      observerInstalled = true
    } catch (e) {
      console.warn('[useIframeInject] 安装 MutationObserver 失败:', e)
    }
  }

  /** 停止轮询：注入成功并装好 MutationObserver 后就没必要每 100ms 再跑一次了 */
  function stopPolling() {
    if (intervalHandle !== null) {
      clearInterval(intervalHandle)
      intervalHandle = null
    }
  }

  function start() {
    let stableCount = 0
    const tick = () => {
      try {
        const node = document.getElementById(iframeId) as HTMLIFrameElement | null
        if (!node) return
        const doc = node.contentDocument || (node.contentWindow && node.contentWindow.document)
        if (!doc) return
        const ready = doc.readyState
        if (ready !== 'complete' && ready !== 'interactive') return

        const changed = applyOnce(doc)
        installObserver(doc)

        // 连续两次轮询都没有产生任何改动，说明已稳定 —— 关掉定时器，交由 MutationObserver 兜底
        if (changed) stableCount = 0
        else if (++stableCount >= 2) stopPolling()

        if (!(node as any)._listenerAttached) {
          node.addEventListener('load', () => {
            try {
              const d = node.contentDocument
              if (d) {
                applyOnce(d)
                if ((d as any)._injectedMutationObserver) {
                  try {
                    ;(d as any)._injectedMutationObserver.disconnect()
                  } catch (e) {
                    /* noop */
                  }
                }
                observerInstalled = false
                installObserver(d)
              }
            } catch (e) {
              console.warn('[useIframeInject] iframe load 处理失败:', e)
            }
          })
          ;(node as any)._listenerAttached = true
        }
      } catch (err) {
        console.error('[useIframeInject] 访问/修改 iframe 出错:', err)
      }
    }
    stopPolling() // 避免重复 start 时旧定时器泄漏
    intervalHandle = window.setInterval(tick, intervalMs)
  }

  function stop() {
    if (intervalHandle !== null) {
      clearInterval(intervalHandle)
      intervalHandle = null
    }
    try {
      const node = document.getElementById(iframeId) as HTMLIFrameElement | null
      const doc = node && (node.contentDocument || (node.contentWindow && node.contentWindow.document))
      if (doc && (doc as any)._injectedMutationObserver) {
        try {
          ;(doc as any)._injectedMutationObserver.disconnect()
        } catch (e) {
          /* noop */
        }
      }
    } catch (e) {
      /* noop */
    }
    observerInstalled = false
  }

  onMounted(start)
  onBeforeUnmount(stop)

  return { start, stop }
}

export default useIframeInject
