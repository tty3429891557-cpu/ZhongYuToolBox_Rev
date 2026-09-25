/**
 * PDF 工具（复刻 pdf-upload.js 的核心能力）
 * - convertPdfToImages: pdfjs-dist 本地逐页渲染为图片（不再依赖外部转图服务）
 * - convertBlobToWebp / blobToMd5: 图片格式转换与 MD5
 * - zipBlobs: 打包为 zip（用于下载）
 *
 * 修复：原实现调用外部服务 pdf2img.zyai.cc 转图，返回图片存放在
 * ezy-word2html-imgs.oss-cn-hangzhou.aliyuncs.com 桶，该桶没有 CORS 头，
 * 浏览器 fetch 图片必然报 "Failed to fetch"（所有学校均受影响）。
 * 且该服务随 loshop 停运随时可能下线。改为项目自带的 pdfjs-dist 在本地
 * 直接渲染，与课程 PDF 预览（LessonViewerView）同一技术栈，零外部依赖。
 */
import CryptoJS from 'crypto-js'
import JSZip from 'jszip'

export interface PdfPageImage {
  pageNum: number
  blob: Blob
  url: string
  /** 页图像素宽（渲染后实际尺寸，用于云笔记画板按 PDF 页比例自适应） */
  width: number
  /** 页图像素高 */
  height: number
}

/** 将图片 blob 转 webp（不支持则原样返回） */
export function convertBlobToWebp(blob: Blob): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    const url = URL.createObjectURL(blob)
    img.onload = () => {
      const canvas = document.createElement('canvas')
      canvas.width = img.width
      canvas.height = img.height
      const ctx = canvas.getContext('2d')
      if (!ctx) {
        URL.revokeObjectURL(url)
        resolve(blob)
        return
      }
      ctx.drawImage(img, 0, 0)
      canvas.toBlob(
        (webpBlob) => {
          URL.revokeObjectURL(url)
          if (webpBlob && webpBlob.type === 'image/webp') resolve(webpBlob)
          else resolve(blob)
        },
        'image/webp',
        0.85
      )
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('图片解码失败'))
    }
    img.src = url
  })
}

/** 计算 blob 的 MD5（大写） */
export async function blobToMd5(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer()
  const wordArray = CryptoJS.lib.WordArray.create(buffer as any)
  return CryptoJS.MD5(wordArray).toString().toUpperCase()
}

type PdfDoc = {
  numPages: number
  getPage: (n: number) => Promise<any>
  destroy: () => Promise<void>
}

/** canvas 导出为 blob：优先 webp 0.85，浏览器不支持 webp 编码时回落 png */
function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise((resolve) => {
    canvas.toBlob(
      (b) => {
        if (b && b.type === 'image/webp') {
          resolve(b)
        } else {
          canvas.toBlob((b2) => resolve(b2), 'image/png')
        }
      },
      'image/webp',
      0.85
    )
  })
}

/**
 * PDF 转图片（pdfjs-dist 本地逐页渲染）。
 *
 * 后缀一致性由 pdfNote.ts 的 imageExtOf 按 blob.type 决定（webp/png/jpeg），
 * 因此这里无需强行转 webp——canvas 直接编码即可。
 *
 * 渲染分辨率策略（修复「横版 PDF 上传后在 App 里发糊」）：
 * App 云笔记画板的显示高度基准是 1039（见 pdfNote.ts 的 BOARD_BASE_H），
 * 页图在 App 内会**按画板尺寸等比缩放**。若渲染出的页图高度小于 1039，
 * App 就得把它**放大**显示 → 模糊。
 * 旧实现以「宽约 1100px」为基准且 scale 上限仅 2：
 *   - 竖版 A4（595×842pt）→ 渲染 1100×1556，App 内缩小到 1039 高，清晰；
 *   - 横版 16:9（1280×720pt）→ 渲染仅 1100×618，App 内要放大到 1039 高（1.68 倍）→ 糊。
 * 现改为**按目标显示高度反推缩放**：以「渲染高度 ≈ 显示高度 × 清晰度系数」为准，
 * 横竖版都能得到足够的像素密度，App 内只会缩小、不会放大。
 */
const BOARD_BASE_H = 1039
/** 清晰度系数：渲染高度不低于 App 显示高度 × 该值（2 ≈ 2 倍超采样，兼顾清晰与体积） */
const RENDER_HEIGHT_FACTOR = 2
/** 渲染后的最短边下限（避免极端长条页某一边像素过少而糊） */
const MIN_RENDER_SIDE = 900
/** 渲染像素总数上限（防止单页占内存过大导致 canvas 撑爆） */
const MAX_PIXELS = 16 * 1024 * 1024

export async function convertPdfToImages(
  pdfFile: File,
  onProgress?: (percent: number, current: number, total: number) => void
): Promise<PdfPageImage[]> {
  // 与 LessonViewerView 相同的 worker 初始化：优先 module Worker，老 WebView 回退 workerSrc
  const pdfjs = await import('pdfjs-dist/build/pdf.mjs')
  if (!pdfjs.GlobalWorkerOptions.workerPort && !pdfjs.GlobalWorkerOptions.workerSrc) {
    const workerUrl = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default
    try {
      pdfjs.GlobalWorkerOptions.workerPort = new Worker(workerUrl, { type: 'module' })
    } catch {
      pdfjs.GlobalWorkerOptions.workerSrc = workerUrl
    }
  }

  onProgress?.(0.02, 0, 1)

  const data = new Uint8Array(await pdfFile.arrayBuffer())
  const doc = (await pdfjs.getDocument({ data }).promise) as PdfDoc
  const total = doc.numPages
  const images: PdfPageImage[] = []

  try {
    for (let i = 1; i <= total; i++) {
      const page = await doc.getPage(i)

      // 以「目标高度 ≥ BOARD_BASE_H × RENDER_HEIGHT_FACTOR」为基准反推缩放，
      // 同时保证最短边不低于 MIN_RENDER_SIDE；最后按像素上限收敛。
      const base = page.getViewport({ scale: 1 })
      const byHeight = (BOARD_BASE_H * RENDER_HEIGHT_FACTOR) / base.height
      const byShortSide = MIN_RENDER_SIDE / Math.min(base.width, base.height)
      let scale = Math.max(byHeight, byShortSide)
      const pixels = base.width * scale * base.height * scale
      if (pixels > MAX_PIXELS) scale *= Math.sqrt(MAX_PIXELS / pixels)

      const viewport = page.getViewport({ scale })
      const canvas = document.createElement('canvas')
      canvas.width = Math.max(1, Math.floor(viewport.width))
      canvas.height = Math.max(1, Math.floor(viewport.height))
      const ctx = canvas.getContext('2d')!
      // PDF 可能有透明背景，先铺白底，避免笔记页透明区域显示异常
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(0, 0, canvas.width, canvas.height)
      await page.render({ canvasContext: ctx, viewport }).promise

      const blob = await canvasToBlob(canvas)
      if (!blob) throw new Error('第 ' + i + ' 页图片编码失败')
      images.push({
        pageNum: i,
        blob,
        url: 'local://pdf/page-' + i,
        width: canvas.width,
        height: canvas.height
      })

      onProgress?.(Math.min(0.98, i / total), i, total)
    }
  } finally {
    try {
      void doc.destroy()
    } catch {
      /* ignore */
    }
  }

  onProgress?.(1.0, total, total)
  return images
}

/** 将多张图片打包为 zip 下载 */
export async function zipBlobs(
  files: Array<{ name: string; blob: Blob }>
): Promise<Blob> {
  const zip = new JSZip()
  for (const f of files) {
    zip.file(f.name, f.blob)
  }
  return await zip.generateAsync({ type: 'blob' })
}
