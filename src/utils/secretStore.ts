/**
 * 本地凭据的混淆存储
 *
 * 背景：401 之后要能自动重新登录，就必须在本机留一份密码。
 * 原实现是直接 `localStorage.setItem('loginPassword', password)` —— **明文**。
 * 任何 XSS、任何能读浏览器存储的程序、任何共用这台电脑的人都能一眼看到密码，
 * 而本工程历史上确实存在多个 v-html 注入点，风险是真实存在的。
 *
 * 现在的策略（三层）：
 *  1. **默认不保存**：只有用户在登录页显式勾选「记住密码」才写入；
 *  2. **混淆而非明文**：用每个浏览器首次生成的一次性密钥做 XOR + Base64，
 *     挡住「直接看 localStorage 就拿到密码」这种最常见的泄露；
 *  3. **可一键清除**：logout 与登录页取消勾选时立即删除。
 *
 * 必须说清楚：XOR+Base64 **不是加密**，只是混淆。
 * 能执行脚本的攻击者仍然可以还原。真正的安全边界是第 1 点（默认不保存）
 * 与消除 XSS 注入点，而不是这里的编码方式。
 */

const KEY_ITEM = 'zytb.obf.key'
const PWD_ITEM = 'zytb.obf.pwd'

/** 生成并持久化一个本机随机密钥（只做一次） */
function localKey(): string {
  let k = localStorage.getItem(KEY_ITEM)
  if (!k || k.length < 32) {
    const bytes = new Uint8Array(16)
    if (globalThis.crypto?.getRandomValues) {
      globalThis.crypto.getRandomValues(bytes)
    } else {
      for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256)
    }
    k = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
    try {
      localStorage.setItem(KEY_ITEM, k)
    } catch {
      /* 存储不可用时仍返回内存态密钥，只是下次刷新后旧密文解不开而已 */
    }
  }
  return k
}

function xor(text: string, key: string): string {
  let out = ''
  for (let i = 0; i < text.length; i++) {
    out += String.fromCharCode(text.charCodeAt(i) ^ key.charCodeAt(i % key.length))
  }
  return out
}

/** 保存混淆后的密码 */
export function saveObfuscatedPassword(password: string): void {
  try {
    if (!password) {
      clearObfuscatedPassword()
      return
    }
    const mixed = xor(password, localKey())
    localStorage.setItem(PWD_ITEM, btoa(unescape(encodeURIComponent(mixed))))
  } catch {
    /* 忽略：写不进去就退化为「不记住密码」，不影响登录本身 */
  }
}

/** 读取混淆后的密码；不存在或解不开时返回空串 */
export function loadObfuscatedPassword(): string {
  try {
    const raw = localStorage.getItem(PWD_ITEM)
    if (!raw) return ''
    const mixed = decodeURIComponent(escape(atob(raw)))
    return xor(mixed, localKey())
  } catch {
    return ''
  }
}

/** 立即删除已保存的密码 */
export function clearObfuscatedPassword(): void {
  try {
    localStorage.removeItem(PWD_ITEM)
  } catch {
    /* ignore */
  }
}
