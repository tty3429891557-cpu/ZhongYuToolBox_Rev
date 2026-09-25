/**
 * 优客畅学内容渲染（复刻旧 index.js change_all / change_object / change_video / change_div）
 * 把章节内容 HTML 中的 <object>/<video>/<div data-type> 标签改写为
 * 「在线查看 / 点击下载」的交互链接。
 *
 * 用法：在父组件用 v-html 注入内容后，调用 render(container) 进行改写。
 */

import { proxyImgSrc } from '@/utils/proxy'

/**
 * 附件 / 媒体地址处理。
 * 修复：原先统一走 proxyUrl()，而远端下载代理（zytbdownloadagent.loshop.com.cn）
 * 已随作者站点停运，导致章节里的 object / video / pdf 附件**全部打不开**。
 * 改用 proxyImgSrc()：OSS 与中育自有 CDN 直连，只有确实需要中转的地址才回落代理。
 */
const proxyUrl = proxyImgSrc

export interface AttachmentHandlers {
  /** object / video 在线查看（视频播放） */
  onViewObject: (url: string, name: string) => void
  /** ppt 在线查看（Office Online） */
  onViewPpt: (url: string, name: string) => void
  /** pdf 在线查看（pdf.js） */
  onViewPdf: (url: string, name: string) => void
  /**
   * 通用 Office 文档在线查看（word/excel 等）。
   * 新增：此前非 pdf/ppt/video 的附件（doc/docx/xls/xlsx…）只给「点击下载」，
   * 用户反馈「docs 以及所有除 pdf 以外的文件」都看不了。现统一走此通道，
   * 由查看器按扩展名分派 docx/xlsx 渲染，渲染不了再回落「下载」。
   */
  onViewOffice: (url: string, name: string) => void
  /** 下载任意附件 */
  onDownload: (url: string, name: string) => void
}

/** 按扩展名判断 Office 文档类型（用于决定在线查看走的渲染器） */
function officeKindOf(url: string, name: string): 'docx' | 'xlsx' | 'pptx' | 'pdf' | '' {
  const src = (name || url || '').toLowerCase().split('?')[0].split('#')[0]
  if (/\.(docx?|rtf)$/.test(src)) return 'docx'
  if (/\.(xlsx?|csv)$/.test(src)) return 'xlsx'
  if (/\.(pptx?)$/.test(src)) return 'pptx'
  if (/\.pdf$/.test(src)) return 'pdf'
  return ''
}

const DOWNLOAD_PROXY_HOST = 'https://zytbdownloadagent.loshop.com.cn/download/'

function makeLinkRow(
  name: string,
  view: (() => void) | null,
  download: () => void
): HTMLParagraphElement {
  const p = document.createElement('p')
  p.style.margin = '6px 0'
  p.append('附件：' + (name || '未命名') + ' ')
  if (view) {
    const a1 = document.createElement('a')
    a1.textContent = '在线查看'
    a1.href = 'javascript:void(0)'
    a1.className = 'lesson-link'
    a1.addEventListener('click', view)
    p.appendChild(a1)
    p.append(' ')
  }
  const a2 = document.createElement('a')
  a2.textContent = '点击下载'
  a2.href = 'javascript:void(0)'
  a2.className = 'lesson-link'
  a2.addEventListener('click', download)
  p.appendChild(a2)
  return p
}

/**
 * easy-editor 富文本上传附件（系统公告正文实测格式）：
 *   <div class="easy-editor-upload pdf-wrapper" data-url=http://...pdf>
 *     <div class="easy-editor-upload__wrapper">
 *       <i class="easy-editor-icon ic_pdf"></i>
 *       <div class="easy-editor-upload__name"><a onclick="...open_file('url')">名称</a></div>
 *     </div>
 *     <div class="easy-editor-upload__see" onclick="..."></div>
 *   </div>
 * 原始 <a>/<div> 的点击全靠内联 onclick（调 App 的 JsToJava.open_file），
 * 净化时被剥掉后就成了死链接——附件「看得见点不开」。这里按 wrapper 类型改写为
 * 在线查看 / 点击下载链接；word/excel/zip 等浏览器无法直接预览的只保留下载。
 */
function editorNameFromUrl(url: string): string {
  try {
    const last = new URL(url, location.href).pathname.split('/').pop() || ''
    return decodeURIComponent(last) || '附件'
  } catch {
    return '附件'
  }
}

function changeEditorUpload(container: HTMLElement, h: AttachmentHandlers): number {
  let changed = 0
  const divs = Array.from(container.getElementsByTagName('div'))
  divs.forEach((d) => {
    if (!d.classList.contains('easy-editor-upload')) return
    const url = d.getAttribute('data-url') || ''
    if (!url) return
    const name =
      d.querySelector('.easy-editor-upload__name')?.textContent?.trim() || editorNameFromUrl(url)
    const link = proxyUrl(url)
    // 按图标/wrapper 类型决定在线查看方式；识别不了的类型再按扩展名兜底，
    // 仍识别不了才只提供下载（例如 zip / 未知二进制，浏览器无法预览）。
    let view: (() => void) | null = null
    if (d.classList.contains('pdf-wrapper')) view = () => h.onViewPdf(link, name)
    else if (d.classList.contains('ppt-wrapper')) view = () => h.onViewPpt(link, name)
    else if (d.classList.contains('video-wrapper') || d.classList.contains('audio-wrapper'))
      view = () => h.onViewObject(link, name)
    else {
      // 修复：doc/docx/xls/xlsx 等此前没有「在线查看」入口，用户反馈看不了。
      switch (officeKindOf(url, name)) {
        case 'pdf':
          view = () => h.onViewPdf(link, name)
          break
        case 'pptx':
          view = () => h.onViewPpt(link, name)
          break
        case 'docx':
        case 'xlsx':
          view = () => h.onViewOffice(link, name)
          break
        default:
          view = null
      }
    }
    const p = makeLinkRow(name, view, () => h.onDownload(link, name))
    container.insertBefore(p, d)
    d.remove()
    changed++
  })
  return changed
}

function changeObject(container: HTMLElement, h: AttachmentHandlers): number {
  const objs = Array.from(container.getElementsByTagName('object'))
  objs.forEach((ob) => {
    const name = ob.getAttribute('name') || '附件'
    const link = proxyUrl(ob.getAttribute('data') || '')
    const p = makeLinkRow(
      name,
      () => h.onViewObject(link, name),
      () => h.onDownload(link, name)
    )
    container.insertBefore(p, ob)
    ob.remove()
  })
  return objs.length
}

function changeVideo(container: HTMLElement, h: AttachmentHandlers): number {
  const vids = Array.from(container.getElementsByTagName('video'))
  vids.forEach((v) => {
    if (v.hasAttribute('controls')) return // 已是可控播放器，跳过
    const name = v.getAttribute('src') || '视频'
    const link = proxyUrl(v.getAttribute('src') || '')
    const p = makeLinkRow(
      name,
      () => h.onViewObject(link, name),
      () => h.onDownload(link, name)
    )
    container.insertBefore(p, v)
    v.remove()
  })
  return vids.length
}

function changeDiv(container: HTMLElement, h: AttachmentHandlers): number {
  let changed = 0
  const divs = Array.from(container.getElementsByTagName('div'))
  divs.forEach((d) => {
    if (d.hasAttribute('data-type')) {
      const type = d.getAttribute('data-type')
      if (type === 'ppt') {
        const name = d.getAttribute('data-name') || 'PPT'
        const url = d.getAttribute('data-url') || ''
        const p = makeLinkRow(
          name,
          () => h.onViewPpt(url, name),
          () => h.onDownload(proxyUrl(url), name)
        )
        container.insertBefore(p, d)
        d.remove()
        changed++
      } else if (type === 'pdf') {
        const name = d.getAttribute('data-name') || 'PDF'
        const link = proxyUrl(d.getAttribute('data-url') || '')
        const p = makeLinkRow(
          name,
          () => h.onViewPdf(link, name),
          () => h.onDownload(link, name)
        )
        container.insertBefore(p, d)
        d.remove()
        changed++
      } else if (type === 'image-block') {
        const img = d.querySelector('img')
        if (img) {
          img.setAttribute('width', '100%')
          img.setAttribute('src', proxyImgSrc(img.getAttribute('src') || ''))
        }
        d.setAttribute('data-type', 'image-block-changed')
        changed++
      }
    } else if (d.hasAttribute('data-id')) {
      // 习题类：旧逻辑仅提示「无法查看习题」
      const name = d.getAttribute('data-title') || '习题'
      const p = document.createElement('p')
      p.className = 'lesson-exercise'
      p.textContent = '无法查看习题：' + name
      container.insertBefore(p, d)
      d.remove()
      changed++
    }
  })
  return changed
}

/** 对容器内容做完整改写（复刻 change_all，另加 easy-editor 公告附件改写） */
export function renderLessonContent(container: HTMLElement, handlers: AttachmentHandlers): void {
  let guard = 0
  while (changeEditorUpload(container, handlers) !== 0 && guard++ < 50) { /* loop */ }
  guard = 0
  while (changeObject(container, handlers) !== 0 && guard++ < 50) { /* loop */ }
  guard = 0
  while (changeVideo(container, handlers) !== 0 && guard++ < 50) { /* loop */ }
  guard = 0
  while (changeDiv(container, handlers) !== 0 && guard++ < 50) { /* loop */ }
  void DOWNLOAD_PROXY_HOST
}

/** 是否含有尚未改写的附件标签（用于「手动渲染」按钮判断） */
export function hasRawAttachments(container: HTMLElement): boolean {
  return (
    container.getElementsByTagName('object').length > 0 ||
    Array.from(container.getElementsByTagName('div')).some(
      (d) => d.classList.contains('easy-editor-upload') && d.getAttribute('data-url')
    ) ||
    Array.from(container.getElementsByTagName('video')).some((v) => !v.hasAttribute('controls')) ||
    Array.from(container.getElementsByTagName('div')).some(
      (d) => d.hasAttribute('data-type') || d.hasAttribute('data-id')
    )
  )
}
