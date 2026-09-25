<template>
  <div class="lesson-viewer-page">
    <div class="appbar">
      <el-icon class="back" @click="goBack"><ArrowLeft /></el-icon>
      <span class="appbar-title">{{ name || '附件查看' }}</span>
      <el-button
        v-if="kind"
        class="appbar-download"
        type="primary"
        plain
        size="small"
        :icon="Download"
        :loading="downloading"
        @click="download"
      >下载</el-button>
    </div>

    <div class="viewer-body">
      <!-- 视频（DPlayer） -->
      <div v-if="kind === 'video'" ref="videoRef" class="video-box"></div>

      <!-- PDF（pdfjs 按视口懒渲染） -->
      <div v-else-if="kind === 'pdf'" class="pdf-body">
        <div ref="pdfRef" class="pdf-box" v-loading="pdfLoading"></div>
        <div v-if="pdfTotal > 0" class="pdf-tip muted">
          共 {{ pdfTotal }} 页 · 已渲染 {{ pdfRendered }}/{{ pdfTotal }} 页（滚动自动加载，避免一次性渲染导致卡死）
        </div>
      </div>

      <!-- PPT / Word / Excel（@vue-office 组件渲染，失败回落下载） -->
      <div v-else-if="isOfficeKind" class="pptx-box">
        <component
          :is="officeComponent"
          v-if="!officeError && officeSrc"
          :src="officeSrc"
          class="pptx-el"
          @error="onOfficeError"
        />
        <el-result
          v-else-if="officeError"
          icon="error"
          :title="officeLabel + '预览失败'"
          sub-title="当前环境无法渲染该文件，请改用下载后本地打开"
        >
          <template #extra>
            <el-button type="primary" @click="download">下载文件</el-button>
          </template>
        </el-result>
      </div>

      <el-empty v-else description="不支持的附件类型" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ArrowLeft, Download } from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'
import DPlayer from 'dplayer'
import VueOfficePptx from '@vue-office/pptx'
import VueOfficeDocx from '@vue-office/docx'
import VueOfficeExcel from '@vue-office/excel'
import '@vue-office/docx/lib/index.css'
import '@vue-office/excel/lib/index.css'
import { proxyImgSrc, proxyCorsUrl } from '@/utils/proxy'
import { downloadBlob, downloadUrl } from '@/utils/download'

const route = useRoute()
const router = useRouter()

const kind = String(route.query.kind || '')
const url = String(route.query.url || '')
const name = String(route.query.name || '')

/* ---------- Office（pptx / docx / xlsx）统一处理 ---------- */
/** 是否走 @vue-office 组件渲染 */
const isOfficeKind = computed(() => kind === 'pptx' || kind === 'docx' || kind === 'xlsx')
/** 依据 kind 选择具体渲染组件 */
const officeComponent = computed(() => {
  if (kind === 'docx') return VueOfficeDocx
  if (kind === 'xlsx') return VueOfficeExcel
  return VueOfficePptx
})
const officeLabel = computed(() => {
  if (kind === 'docx') return 'Word 文档'
  if (kind === 'xlsx') return 'Excel 表格'
  return 'PPT'
})
/** Office 组件实际取数地址（需经 CORS 转发，否则跨域被拦截） */
const officeSrc = ref('')
const officeError = ref(false)

const pdfRef = ref<HTMLElement | null>(null)
const videoRef = ref<HTMLElement | null>(null)
const pdfLoading = ref(false)
const pdfTotal = ref(0)
const pdfRendered = ref(0)
const downloading = ref(false)
let dp: DPlayer | null = null

function goBack() {
  if (window.history.state?.back) router.back()
  else router.push('/lesson')
}

/* 通过 blob 方式下载（避免直接打开/跨域限制） */
async function download() {
  if (!url || downloading.value) return
  downloading.value = true
  try {
    // 用 URL 中的文件名，兜底用传入的 name
    const fromUrl = decodeURIComponent(url.split('?')[0].split('/').pop() || '')
    await downloadUrl(proxyImgSrc(url), fromUrl || name || 'download')
  } catch (e: any) {
    ElMessage.error('下载失败：' + (e?.message || e))
  } finally {
    downloading.value = false
  }
}

function onOfficeError(e: any) {
  console.warn('office 渲染失败', e)
  officeError.value = true
}

/** 解析 Office 组件的取数地址（走 CORS 转发，失败则回落直连） */
async function prepareOfficeSrc() {
  if (!isOfficeKind.value || !url) return
  try {
    officeSrc.value = await proxyCorsUrl(url)
  } catch {
    officeSrc.value = url
  }
}

/* ---------- PDF 渲染（pdfjs-dist） ---------- */
type PdfDoc = { numPages: number; getPage: (n: number) => Promise<any>; destroy: () => Promise<void> }
let pdfDoc: PdfDoc | null = null
let pageObserver: IntersectionObserver | null = null
let destroyed = false

/** 渲染单页到占位容器 */
async function renderPage(doc: PdfDoc, host: HTMLElement, pageNo: number) {
  if (destroyed) return
  try {
    const page = await doc.getPage(pageNo)
    if (destroyed) return
    const viewport = page.getViewport({ scale: 1.4 })
    const canvas = document.createElement('canvas')
    canvas.width = viewport.width
    canvas.height = viewport.height
    canvas.style.width = '100%'
    canvas.style.marginBottom = '8px'
    host.innerHTML = ''
    host.style.minHeight = ''
    host.appendChild(canvas)
    const task = page.render({ canvasContext: canvas.getContext('2d')!, viewport })
    await task.promise
    pdfRendered.value++
  } catch (e) {
    host.innerHTML = ''
    host.textContent = `第 ${pageNo} 页渲染失败`
  }
}

async function renderPdf(src: string) {
  if (!pdfRef.value) return
  pdfLoading.value = true
  try {
    const pdfjs = await import('pdfjs-dist/build/pdf.mjs')
    if (!pdfjs.GlobalWorkerOptions.workerPort && !pdfjs.GlobalWorkerOptions.workerSrc) {
      // 老 WebView 不支持 module Worker，退回到 workerSrc（非 module）形式
      const workerUrl = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default
      try {
        pdfjs.GlobalWorkerOptions.workerPort = new Worker(workerUrl, { type: 'module' })
      } catch {
        pdfjs.GlobalWorkerOptions.workerSrc = workerUrl
      }
    }
    const container = pdfRef.value
    container.innerHTML = ''
    pdfRendered.value = 0

    // 修复一：原来用 proxyUrl()，默认前缀是已下线的 loshop 下载代理 → 所有 PDF 打不开。
    // 修复二（CORS）：中育 CDN（*.zyai.cc / *alicdn*）的 PDF **不返回 CORS 头**，
    //   浏览器对 pdfjs.getDocument(url) 的跨域读取会直接拦截：
    //   "blocked by CORS policy: No 'Access-Control-Allow-Origin' header"。
    //   `<img>` 之所以正常，是因为图片不需要 CORS。故改为走「同源 /proxy/ 转发」
    //   （站点宿主程序内置，带 CORS 头且同源无跨域），回落 tbHelper(5005)。
    const fetchUrl = await proxyCorsUrl(src)
    const doc = (await pdfjs.getDocument(fetchUrl).promise) as PdfDoc
    pdfDoc = doc
    pdfTotal.value = doc.numPages

    /**
     * 修复二：原实现一次性把所有页渲染成 canvas。
     * 100 页 PDF = 100 张 ~1400×2000 的 canvas，显存/内存暴涨直至标签页崩溃。
     * 改为先建占位块，再由 IntersectionObserver 在滚动到附近时才真正渲染。
     */
    const hosts: HTMLElement[] = []
    for (let i = 1; i <= doc.numPages; i++) {
      const host = document.createElement('div')
      host.className = 'pdf-page-host'
      host.dataset.page = String(i)
      host.style.width = '100%'
      host.style.minHeight = '500px'
      container.appendChild(host)
      hosts.push(host)
    }

    if (typeof IntersectionObserver !== 'undefined') {
      pageObserver = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (!entry.isIntersecting) continue
            const el = entry.target as HTMLElement
            pageObserver?.unobserve(el)
            void renderPage(doc, el, Number(el.dataset.page))
          }
        },
        { rootMargin: '700px 0px' }
      )
      hosts.forEach((h) => pageObserver!.observe(h))
    } else {
      // 极老浏览器没有 IO：退化为顺序渲染，但限制首屏页数避免一次性爆内存
      for (let i = 1; i <= Math.min(doc.numPages, 20); i++) {
        await renderPage(doc, hosts[i - 1], i)
      }
    }
  } catch (e: any) {
    ElMessage.error('PDF 加载失败：' + (e.message || e))
  } finally {
    pdfLoading.value = false
  }
}

function cleanupPdf() {
  destroyed = true
  pageObserver?.disconnect()
  pageObserver = null
  try {
    void pdfDoc?.destroy()
  } catch {
    /* ignore */
  }
  pdfDoc = null
}

function initDPlayer(src: string) {
  if (!videoRef.value) return
  // 修复：同样改用 proxyImgSrc()，否则视频也走已下线的 loshop 代理，一律加载失败
  dp = new DPlayer({
    container: videoRef.value,
    video: { url: proxyImgSrc(src) }
  })
}

onMounted(() => {
  if (kind === 'video') initDPlayer(url)
  else if (kind === 'pdf') renderPdf(url)
  else if (isOfficeKind.value) void prepareOfficeSrc()
})

onBeforeUnmount(() => {
  dp?.destroy()
  dp = null
  // 释放 PDF 文档与页面观察器（原实现没有，来回切附件会持续堆积内存）
  cleanupPdf()
})
</script>

<style scoped>
.lesson-viewer-page {
  display: flex;
  flex-direction: column;
  min-height: 100%;
  background: #1f1f1f;
}
.appbar {
  position: sticky;
  top: 0;
  z-index: 50;
  display: flex;
  align-items: center;
  gap: 8px;
  height: 52px;
  padding: 0 16px;
  background: var(--el-bg-color);
  border-bottom: 1px solid var(--el-border-color-light);
}
.appbar .back {
  font-size: 20px;
  cursor: pointer;
  flex-shrink: 0;
  color: var(--el-text-color-regular);
}
.appbar-title {
  flex: 1;
  min-width: 0;
  font-size: 17px;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.appbar-download {
  flex-shrink: 0;
  margin-left: 8px;
}
.viewer-body {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 16px;
}
.video-box {
  width: 100%;
  max-width: 1000px;
  max-height: calc(100vh - 84px);
  background: #000;
}
.video-box :deep(.dplayer) {
  width: 100%;
}
.pdf-body {
  width: 100%;
  max-width: 900px;
  display: flex;
  flex-direction: column;
  align-items: center;
}
.pdf-box {
  width: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  min-height: 300px;
  background: #fff;
  border-radius: 8px;
  padding: 12px;
}
.pdf-tip {
  padding: 8px 0 4px;
  font-size: 12px;
}
.pptx-box {
  width: 100%;
  max-width: 960px;
}
.pptx-el {
  width: 100%;
}
@media (max-width: 767px) {
  .appbar {
    padding: 0 10px;
  }
}
</style>
