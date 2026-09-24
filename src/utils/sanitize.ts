/**
 * 远程 HTML 净化（防 XSS）
 *
 * 背景：本程序会把学校服务器返回的富文本（题干 / 答案 / 解析 / 专栏正文 / 章节内容 /
 * 系统公告 / 分享内容）通过 v-html 直接插入 DOM。v-html 不会执行 <script>，
 * 但**会执行内联事件属性**（<img onerror=...>、<svg onload=...>），
 * 而这些内容对程序而言是不可信输入（教师/管理员可编辑，服务端也可能被劫持）。
 *
 * 因此所有 v-html 的内容必须先经 DOMPurify 净化再渲染。
 *
 * 注意：DOMPurify 默认白名单会**剥掉 <object> / <embed> / <iframe>**。
 * 优客畅学的章节附件正是用 <object data="..."> 承载的（见 useContentRenderer.changeObject），
 * 所以章节内容需要用 safeLessonHtml()（放开 object/embed，其 data 属性仍受
 * DOMPurify 的 URL 协议白名单校验，javascript: 之类不会被放过）。
 */
import DOMPurify from 'dompurify'

/** 自定义 data-* 属性：附件卡片靠它们传递 URL 与类型，必须放行 */
const EXTRA_DATA_ATTRS = [
  'data-file-url',
  'data-file-kind',
  'data-type',
  'data-url',
  'data-name',
  'data-id',
  'data-title'
]

/**
 * 净化普通富文本（题干 / 答案 / 解析 / 专栏正文 / 公告 / 分享内容）
 */
export function safeHtml(html: string | null | undefined): string {
  if (!html) return ''
  return DOMPurify.sanitize(html, {
    ADD_ATTR: EXTRA_DATA_ATTRS,
    // 保留 class / style：学校富文本大量依赖内联样式排版
    ALLOW_DATA_ATTR: true,
    // 禁止未知协议（data:text/html、javascript:、vbscript: 等）
    ALLOWED_URI_REGEXP: /^(?:(?:(?:f|ht)tps?|mailto|tel|callto|sms|cid|xmpp):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i
  })
}

/**
 * 净化章节内容（放行 object / embed，优客畅学附件依赖）
 */
export function safeLessonHtml(html: string | null | undefined): string {
  if (!html) return ''
  return DOMPurify.sanitize(html, {
    ADD_TAGS: ['object', 'embed'],
    ADD_ATTR: [...EXTRA_DATA_ATTRS, 'data', 'name', 'type'],
    ALLOW_DATA_ATTR: true,
    ALLOWED_URI_REGEXP: /^(?:(?:(?:f|ht)tps?|mailto|tel|callto|sms|cid|xmpp):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i
  })
}

/**
 * HTML 文本转义（用于把不可信字符串安全地拼进 HTML 模板，
 * 例如专栏 PDF 卡片的文件名来自被解析的 HTML，直接拼接会形成二次注入）
 */
export function escapeHtml(text: string | null | undefined): string {
  if (text == null) return ''
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}
