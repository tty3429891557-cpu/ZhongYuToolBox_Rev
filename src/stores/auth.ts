/**
 * 登录态 store（替代旧代码 localStorage 散存与 window 全局变量）
 */
import { defineStore } from 'pinia'
import { loginApi, getUserInfo, refreshTokenApi, discoverSchool, buildApiBaseCandidates, type LoginResult } from '@/api/auth'
import { PRESET_API_BASE, PRESET_WEB_BASE, DEFAULT_API_BASE, nativeWebBase } from '@/config'

/** 从 API 地址推导对应的学校原生 web 地址（承载 navPage.html） */
function webBaseFor(apiBase: string, schoolSelect: string, schoolCode: string): string {
  if (schoolSelect !== 'other' && PRESET_WEB_BASE[schoolSelect]) return PRESET_WEB_BASE[schoolSelect]
  const m = /^https?:\/\/([^.]+)\.[^/]*/i.exec(apiBase || '')
  if (m) return nativeWebBase(m[1])
  if (schoolCode) return nativeWebBase(schoolCode)
  return PRESET_WEB_BASE.sxz
}

function parseJwt(token: string): any {
  try {
    const payload = atob(token.split('.')[1])
    return JSON.parse(payload)
  } catch {
    return null
  }
}

export function isTokenExpired(token: string): boolean {
  const payload = parseJwt(token)
  if (!payload || !payload.exp) return true
  return payload.exp <= Date.now() / 1000
}

interface AuthState {
  token: string
  refreshToken: string
  realName: string
  photo: string
  schoolCode: string
  userId: string
  apiBaseUrl: string
  refreshTimer: number | null
}

export const useAuthStore = defineStore('auth', {
  state: (): AuthState => ({
    token: localStorage.getItem('token') || '',
    refreshToken: localStorage.getItem('refreshToken') || '',
    realName: localStorage.getItem('realName') || '',
    photo: localStorage.getItem('photo') || 'https://s4.anilist.co/file/anilistcdn/user/avatar/large/default.png',
    schoolCode: localStorage.getItem('schoolCode') || 'sxz',
    userId: localStorage.getItem('userId') || '',
    apiBaseUrl: localStorage.getItem('apiBaseUrl') || '',
    refreshTimer: null
  }),
  getters: {
    isLoggedIn: (s) => !!s.token && !isTokenExpired(s.token),
    userName: (s) => s.realName || '未录入'
  },
  actions: {
    setTokenInfo(result: { accessToken: string; refreshToken: string; expireInSeconds: number; refreshExpireInSeconds: number }) {
      this.token = result.accessToken
      this.refreshToken = result.refreshToken
      localStorage.setItem('token', result.accessToken)
      localStorage.setItem('refreshToken', result.refreshToken)
      localStorage.setItem('tokenExpire', String(Date.now() + result.expireInSeconds * 1000))
      localStorage.setItem('refreshTokenExpire', String(Date.now() + result.refreshExpireInSeconds * 1000))
    },
    setUserInfo(info: Record<string, any>, apiBaseUrl: string) {
      this.realName = info.realName || ''
      this.photo = info.photo || 'https://s4.anilist.co/file/anilistcdn/user/avatar/large/default.png'
      this.userId = info.userId || info.sub || info.nameid || ''
      this.schoolCode = info.schoolCode || this.schoolCode
      this.apiBaseUrl = apiBaseUrl
      localStorage.setItem('realName', this.realName)
      localStorage.setItem('photo', this.photo)
      localStorage.setItem('userId', this.userId)
      localStorage.setItem('schoolCode', this.schoolCode)
      localStorage.setItem('apiBaseUrl', apiBaseUrl)
      localStorage.setItem('apiBaseOrigin', apiBaseUrl)
    },
    async login(account: string, password: string, schoolSelect: string, schoolCode: string) {
      let apiBaseUrl = this.apiBaseUrl || DEFAULT_API_BASE
      let preResult: LoginResult | null = null

      if (schoolSelect === 'other') {
        if (!schoolCode) throw new Error('请输入学校代码')
        const info = await discoverSchool(schoolCode)
        // 按候选顺序逐个尝试（作者代理域名 → discovery 的服务器），取第一个能登录成功的。
        // 旧站只特判了 sxzsyxx / bjbsz 两所且拒绝一切 http 服务器，
        // 本程序在 http://127.0.0.1 运行，无混合内容限制，故 http 学校接口也能直接用。
        const candidates = buildApiBaseCandidates(schoolCode, info.server)
        let lastErr: unknown = null
        for (const base of candidates) {
          try {
            preResult = await loginApi(account, password, base)
            apiBaseUrl = base
            break
          } catch (e) {
            lastErr = e
          }
        }
        if (!preResult) {
          const msg = (lastErr as any)?.message || '网络不可达或账号密码错误'
          throw new Error(`学校「${info.name}」登录失败：${msg}`)
        }
      } else {
        // 预置学校：按学校代码精确对应各自的后端，避免用错学校取不到数据。
        // （省锡中 sxz 与省锡中双语 sxzsyxx 是两所不同学校，后端不同、数据不互通）
        const preset = PRESET_API_BASE[schoolSelect]
        if (preset) apiBaseUrl = preset
      }

      const result = preResult ?? (await loginApi(account, password, apiBaseUrl))
      this.setTokenInfo(result)
      let userInfo: any
      try {
        userInfo = await getUserInfo(apiBaseUrl, result.accessToken)
      } catch (e) {
        // 认证通过了但拿不到账号信息，通常是「学校」选错——各校后端彼此独立、账号不互通。
        const msg = (e as any)?.message || '未知错误'
        if (schoolSelect !== 'other') {
          throw new Error(
            `已通过账号认证，但所选学校后端不认可该账号（${msg}）。` +
              `请确认「学校」是否选对：不同学校后端独立、数据不互通，` +
              `例如省锡中双语学校的账号应选「省锡中双语学校」。`
          )
        }
        throw new Error(`获取账号信息失败：${msg}`)
      }
      this.setUserInfo(userInfo, apiBaseUrl)
      // 同步「嵌套 iframe 基地址」为该校原生 web 地址（专栏 navPage.html 用），
      // 不再依赖作者服务器 zyapi.loshop.com.cn
      localStorage.setItem('iframeBase', webBaseFor(apiBaseUrl, schoolSelect, schoolCode))
      // 记录凭据，供 401 后自动重新登录（需求：登录时记录用户名密码学校）
      localStorage.setItem('loginAccount', account)
      localStorage.setItem('loginPassword', password)
      localStorage.setItem('loginSchoolSelect', schoolSelect)
      localStorage.setItem('loginSchoolCode', schoolCode)
      this.startRefresh()
      return userInfo
    },
    /** 用记录的凭据自动重新登录（401 刷新失败后的兜底） */
    async autoRelogin() {
      const account = localStorage.getItem('loginAccount')
      const password = localStorage.getItem('loginPassword')
      const schoolSelect = localStorage.getItem('loginSchoolSelect') || 'sxz'
      const schoolCode = localStorage.getItem('loginSchoolCode') || ''
      if (!account || !password) throw new Error('无可用登录凭据')
      await this.login(account, password, schoolSelect, schoolCode)
    },
    async doRefresh(): Promise<boolean> {
      if (!this.token || !this.refreshToken) return false
      try {
        const result = await refreshTokenApi(this.apiBaseUrl, this.refreshToken, this.token)
        if (result) {
          this.setTokenInfo(result)
          return true
        }
        return false
      } catch (e) {
        console.error('刷新 token 失败:', e)
        return false
      }
    },
    startRefresh() {
      this.stopRefresh()
      // 每 60s 检查一次（复刻 1s 检查，但改为 60s 以降低开销）
      this.refreshTimer = window.setInterval(() => {
        const expire = parseInt(localStorage.getItem('tokenExpire') || '0')
        const refreshExpire = parseInt(localStorage.getItem('refreshTokenExpire') || '0')
        const now = Date.now()
        if (expire - now <= 10000 && now < refreshExpire) {
          this.doRefresh()
        }
      }, 60000)
    },
    stopRefresh() {
      if (this.refreshTimer !== null) {
        clearInterval(this.refreshTimer)
        this.refreshTimer = null
      }
    },
    logout() {
      this.token = ''
      this.refreshToken = ''
      this.realName = ''
      this.photo = ''
      this.userId = ''
      this.schoolCode = 'sxz'
      localStorage.removeItem('token')
      localStorage.removeItem('refreshToken')
      localStorage.removeItem('tokenExpire')
      localStorage.removeItem('refreshTokenExpire')
      localStorage.removeItem('realName')
      localStorage.removeItem('photo')
      localStorage.removeItem('userId')
      localStorage.removeItem('schoolCode')
      // 清除自动重登凭据
      localStorage.removeItem('loginAccount')
      localStorage.removeItem('loginPassword')
      localStorage.removeItem('loginSchoolSelect')
      localStorage.removeItem('loginSchoolCode')
      this.stopRefresh()
    }
  }
})
