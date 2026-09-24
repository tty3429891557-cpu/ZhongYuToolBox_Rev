/**
 * 统一配置中心
 * 集中管理 API 基地址、代理地址、学校/学科常量、AES 密钥生成等。
 * 所有模块从此处读取，便于后续统一修改。
 */

const ls = window.localStorage

/* ============================================================
 * 关于「不使用 loshop」
 * ------------------------------------------------------------
 * 2026-09-23：作者的中育Toolbox 站点已停止运营，其 loshop.com.cn 系列服务随时可能下线。
 * 官方 App 与学校本身使用的其实是**学校原生域名** `{schoolCode}.api.zykj.org`
 * （如 sxzsyxx.api.zykj.org），实测与 loshop 代理**能力完全一致**
 * （登录 + 网站用到的 12 个业务接口逐一返回相同结果）。
 *
 * 因此本程序改为**优先使用学校原生域名**，loshop 仅作为最后的兜底候选。
 * 注意：原生域名是 http；本程序运行在 http://127.0.0.1，不受混合内容限制。
 * 若日后把站点挂到 https 上，需要改回 https 源。
 * ============================================================ */

/** 由学校代码推导学校原生 API 地址 */
export function nativeApiBase(code: string): string {
  return `http://${code}.api.zykj.org`
}

/** 由学校代码推导学校原生 web 服务地址（承载 navPage.html 等） */
export function nativeWebBase(code: string): string {
  return `http://${code}.school.zykj.org`
}

/** 预置学校 → 学校原生 API 地址（均为实测可用的地址） */
export const PRESET_API_BASE: Record<string, string> = {
  sxz: 'http://sxz.api.zykj.org',
  sxzsyxx: 'http://sxzsyxx.api.zykj.org',
  bjbsz: 'http://bjbsz.api2.zykj.org'
}

/** 预置学校 → 学校原生 web 地址 */
export const PRESET_WEB_BASE: Record<string, string> = {
  sxz: 'http://sxz.school.zykj.org',
  sxzsyxx: 'http://sxzsyxx.school.zykj.org',
  bjbsz: 'http://bjbsz.school.zykj.org'
}

/** 默认学校代码（登录页默认选中项） */
export const DEFAULT_SCHOOL_CODE = 'sxz'

/** 登录前的兜底 API 地址（登录成功后会被真实学校地址覆盖） */
export const DEFAULT_API_BASE = PRESET_API_BASE[DEFAULT_SCHOOL_CODE]

export const API_BASE_URL: string = ls.getItem('apiBaseUrl') || DEFAULT_API_BASE

export const API_BASE_BASE_URL: string = ls.getItem('apiBaseOrigin') || DEFAULT_API_BASE

/** 站点自建分享服务（作者的 zytbshareapi.loshop.com.cn 已下线，见 api/share.ts 的处理） */
export const SHARE_SERVER: string = ls.getItem('shareServer') || ''

/** 远端代理（作者服务器，仍在但会返回非图片内容；图片等资源已改为直连，此处仅作兜底） */
export const PROXY_REMOTE = 'https://zytbdownloadagent.loshop.com.cn/download/'
/** 本地加速代理（检测到时使用） */
export const PROXY_LOCAL = 'http://127.0.0.1:5005/proxy/'
/** 本地代理探测地址 */
export const PROXY_LOCAL_PING = 'http://127.0.0.1:5005/proxy/ping'

/** 领创接口配置（复刻 linspirer.js；该服务为作者自建，非学校接口） */
export const LINSPIRER = {
  KEY: '1191ADF18489D8DA',
  IV: '5E9B755A8B674394',
  API_BASE: 'https://zytb-linspirer-api.loshop.com.cn',
  API: 'https://zytb-linspirer-api.loshop.com.cn/public-interface.php',
  CLIENT_VERSION: 'zhongyukejiao_hem_6.10.004.6',
  FIXED_UUID: '40E06F51-30D0-D6AD-7F7D-008AD0ADC570'
}

/** 中育 AES 密钥（复刻 index.js generateAesKey） */
export function generateAesKey(): string {
  const e = ':F0wKU!Qg3}UkbW+w[:9|D3-5h=:T;7t#_GZ4#G;~ZNSq{8;}QIP>\'{q.lje'
  const t = new Date()
  const n = t.getFullYear()
  const r = t.getMonth() + 1
  const o = t.getDate()
  const i = 33 + o * r * 33
  const a = String.fromCharCode((i % 94) + 33)
  const s = e[o + r]
  const c = (n * r * o) % e.length
  const u = e.substring(c)
  const l = e.substring(0, c)
  const f = (u + l).substring(0, 14)
  return a + f + s
}

/**
 * 学校选项（登录页下拉）。
 * 原先只有「省锡中」和「其它学校」，其它学校必须手填代码；
 * 现在把已确认可用的学校直接列出来，选中即用预设后端，不需要再输代码。
 *
 * 注意：必须与 PRESET_API_BASE / PRESET_WEB_BASE 的键保持一致，
 * 否则选中后 `login()` 里的 `PRESET_API_BASE[schoolSelect]` 取不到值。
 */
export interface SchoolOption {
  value: string
  label: string
}

export const SCHOOLS: SchoolOption[] = [
  { value: 'sxz', label: '省锡中' },
  { value: 'sxzsyxx', label: '省锡中双语学校' },
  { value: 'bjbsz', label: '北京市第八十中学' },
  { value: 'other', label: '其它学校' }
]

/** 学科常量（复刻 index.js 数组 a） */
export const SUBJECTS: Array<[number, string]> = [
  [4, '语文'],
  [5, '数学'],
  [6, '外语'],
  [7, '物理'],
  [8, '化学'],
  [9, '生物'],
  [10, '政治'],
  [11, '历史'],
  [12, '地理'],
  [13, '全科专用（级部发布）'],
  [14, '信息技术'],
  [15, '通用技术'],
  [24, '体育与健康'],
  [34, '技术'],
  [35, '艺术'],
  [41, '研创大任务'],
  [42, '级部管理'],
  [53, '家务劳动'],
  [66, '调查问卷']
]

/**
 * 嵌套 iframe 模块基地址（在线专栏 navPage.html）
 * 原为作者服务器 `https://zyapi.loshop.com.cn/navPage.html?apiHost=<API_BASE_URL>&apiToken=<token>`；
 * 实测学校原生 web 服务 `{code}.school.zykj.org/navPage.html` **同样可用**，故改为学校原生地址。
 * 登录成功后由 stores/auth.ts 写入 `iframeBase`（学校原生 web 地址）。
 * 选课用的 ezyRawContent.html 是本工程自带的同源文件，直接放在 public/ 下。
 */
export const IFRAME_BASE: string =
  ls.getItem('iframeBase') || PRESET_WEB_BASE[DEFAULT_SCHOOL_CODE]

/** OSS 上传类型前缀（复刻 index.html #selectFc 选项） */
export const OSS_PREFIXES: string[] = [
  'note_v2',
  'eval_v2',
  'quora_v2',
  'mistake_v2',
  'study_v2',
  'column_v2',
  'paper_v2',
  'revise_v2',
  'selection_v2',
  'manage_v2'
]

/**
 * 由当前 API 基地址推导「嵌套 iframe」基地址。
 * 不能使用 localStorage 里残留的旧值：学校不匹配时专栏页会 502 打不开。
 * 规则：
 *   http(s)://<code>.api*.zykj.org        → http://<code>.school.zykj.org
 *   https://zyapi-<code>.loshop.com.cn    → https://zyapi-<code>.loshop.com.cn
 *   https://zyapi.loshop.com.cn           → https://zyapi.loshop.com.cn
 */
export function resolveIframeBase(apiBaseUrl: string): string {
  const m1 = /^https?:\/\/([^.]+)\.api\d*\.zykj\.org/i.exec(apiBaseUrl || '')
  if (m1) return `http://${m1[1]}.school.zykj.org`
  const m2 = /^https:\/\/zyapi-([^.]+)\.loshop\.com\.cn\/?$/i.exec(apiBaseUrl || '')
  if (m2) return `https://zyapi-${m2[1]}.loshop.com.cn`
  if (/^https:\/\/zyapi\.loshop\.com\.cn/i.test(apiBaseUrl || '')) return 'https://zyapi.loshop.com.cn'
  // 兜底：优先按当前登录学校代码推导，避免沿用 localStorage 里其他学校的残留值
  const code = ls.getItem('schoolCode') || DEFAULT_SCHOOL_CODE
  return PRESET_WEB_BASE[code] || nativeWebBase(code)
}
