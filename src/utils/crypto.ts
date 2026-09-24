/**
 * 加解密工具
 * - 中育 AES-ECB（密钥每日动态生成）
 * - 领创 AES-CBC（固定密钥/IV）
 * - MD5
 */
import CryptoJS from 'crypto-js'
import { generateAesKey, LINSPIRER } from '@/config'

/**
 * 中育 AES-ECB 加解密（复刻 window.aesEncrypt/aesDecrypt）
 *
 * 修复：密钥**按天变化**（generateAesKey 依赖年月日）。原实现在模块加载时算一次就固化，
 * 程序跨过零点后密钥与服务端不一致 → 所有云笔记请求解密失败（"Unexpected end of JSON input"），
 * 必须刷新页面才恢复。现改为按日期惰性重算。
 */
let zyKeyCache: { stamp: string; key: any } | null = null

function zyKey() {
  const d = new Date()
  const stamp = `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`
  if (!zyKeyCache || zyKeyCache.stamp !== stamp) {
    zyKeyCache = { stamp, key: CryptoJS.enc.Utf8.parse(generateAesKey()) }
  }
  return zyKeyCache.key
}

export function aesEncrypt(data: string): string {
  const encrypted = CryptoJS.AES.encrypt(data, zyKey(), {
    mode: CryptoJS.mode.ECB,
    padding: CryptoJS.pad.Pkcs7
  })
  return encrypted.toString()
}

export function aesDecrypt(encryptedBase64Str?: string): string {
  if (!encryptedBase64Str) return ''
  try {
    const decrypted = CryptoJS.AES.decrypt(encryptedBase64Str, zyKey(), {
      mode: CryptoJS.mode.ECB,
      padding: CryptoJS.pad.Pkcs7
    })
    return decrypted.toString(CryptoJS.enc.Utf8)
  } catch (e) {
    console.warn('[crypto] AES 解密失败（密钥可能已跨天，将自动重算）:', e)
    zyKeyCache = null
    return ''
  }
}

/** 领创 AES-CBC 加解密（复刻 linspirer.js） */
const linKey = CryptoJS.enc.Utf8.parse(LINSPIRER.KEY)
const linIv = CryptoJS.enc.Utf8.parse(LINSPIRER.IV)

export function linspirerEncrypt(text: string): string {
  const encrypted = CryptoJS.AES.encrypt(text, linKey, {
    iv: linIv,
    mode: CryptoJS.mode.CBC,
    padding: CryptoJS.pad.Pkcs7
  })
  return encrypted.toString()
}

export function linspirerDecrypt(b64text: string): string {
  const decrypted = CryptoJS.AES.decrypt(b64text, linKey, {
    iv: linIv,
    mode: CryptoJS.mode.CBC,
    padding: CryptoJS.pad.Pkcs7
  })
  return decrypted.toString(CryptoJS.enc.Utf8)
}

export function md5(text: string): string {
  return CryptoJS.MD5(text).toString()
}
