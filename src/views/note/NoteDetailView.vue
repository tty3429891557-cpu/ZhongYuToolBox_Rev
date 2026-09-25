<template>
  <div class="note-detail">
    <!-- 顶部返回栏（参考 Gblox 帖子详情 appbar） -->
    <div class="appbar">
      <el-icon class="back" @click="goBack"><ArrowLeft /></el-icon>
      <span class="appbar-title">{{ fileName || '笔记预览' }}</span>
      <!-- 桌面端：纯图标按钮 -->
      <template v-if="!isMobile">
        <el-button type="success" :loading="exporting" @click="exportPdf">
          <el-icon><Document /></el-icon>
        </el-button>
        <el-button type="info" :loading="downloading" @click="downloadZip">
          <el-icon><Download /></el-icon>
        </el-button>
        <el-popconfirm title="将该笔记移入回收站？可撤销" width="220" @confirm="onMoveToRecycle">
          <template #reference>
            <el-button type="danger" :icon="Delete" :loading="deleting" />
          </template>
        </el-popconfirm>
      </template>
      <!-- 移动端：三个点按钮 + 底部弹出面板（带遮罩，参考 Gblox） -->
      <template v-else>
        <button type="button" class="more-btn" @click="showSheet = true">
          <el-icon><MoreFilled /></el-icon>
        </button>
        <Teleport to="body">
          <div v-if="showSheet" class="actions-mask" @click="showSheet = false" />
          <div v-if="showSheet" class="actions-sheet">
            <div class="actions-item" @click="onActionCommand('pdf')">
              <el-icon><Document /></el-icon><span>导出为PDF</span>
            </div>
            <div class="actions-item" @click="onActionCommand('zip')">
              <el-icon><Download /></el-icon><span>下载笔记</span>
            </div>
            <div class="actions-cancel" @click="showSheet = false">取消</div>
          </div>
        </Teleport>
      </template>
    </div>

    <div v-loading="loading" class="preview-body">
      <el-empty v-if="!loading && pages.length === 0" description="该笔记没有可预览的内容" />
      <div v-else-if="currentPageData" class="page-content">
        <!-- 页面总览（笔记截图） -->
        <div v-if="currentPageData.thumbnail" class="thumb-wrap">
          <el-image
            :src="currentPageData.thumbnail.imgSrc"
            :preview-src-list="[currentPageData.thumbnail.imgSrc]"
            :initial-index="0"
            fit="contain"
            class="thumb-img"
            preview-teleported
            hide-on-click-modal
          >
            <template #error>
              <div class="img-error">
                <el-icon><PictureFilled /></el-icon>
                <span>总览图加载失败</span>
              </div>
            </template>
          </el-image>
        </div>

        <!-- 页内插入的图片（水平滚动） -->
        <div v-if="currentPageData.originals.length" class="originals-block">
          <div class="originals-label">页内图片（{{ currentPageData.originals.length }}）</div>
          <div class="originals-row">
            <el-image
              v-for="(orig, i) in currentPageData.originals"
              :key="orig.imgSrc"
              :src="orig.imgSrc"
              :preview-src-list="originalPreviewList"
              :initial-index="i"
              fit="contain"
              class="orig-img"
              preview-teleported
              hide-on-click-modal
            >
              <template #error>
                <div class="img-error small">
                  <el-icon><PictureFilled /></el-icon>
                </div>
              </template>
            </el-image>
          </div>
        </div>
      </div>
    </div>

    <div v-if="pages.length" class="pager-bar">
      <el-button :disabled="currentPage <= 1" @click="currentPage--">
        <el-icon><ArrowLeft /></el-icon>
        <span v-if="!isMobile">上一页</span>
      </el-button>
      <el-input-number
        v-model="currentPage"
        :min="1"
        :max="pages.length"
        controls-position="right"
        class="page-input"
      />
      <span class="page-info">
        / {{ pages.length }} 页（第 {{ pages[currentPage - 1] }} 页）
      </span>
      <el-button :disabled="currentPage >= pages.length" @click="currentPage++">
        <span v-if="!isMobile">下一页</span>
        <el-icon><ArrowRight /></el-icon>
      </el-button>
    </div>

    <el-dialog
      v-model="progressVisible"
      title="处理中"
      width="360px"
      :close-on-click-modal="false"
      :show-close="false"
    >
      <div class="progress-text">{{ progressText }}</div>
      <el-progress :percentage="progressPercent" :stroke-width="16" />
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { ArrowLeft, ArrowRight, Document, Download, PictureFilled, MoreFilled, Delete } from '@element-plus/icons-vue'
import JSZip from 'jszip'
import { jsPDF } from 'jspdf'
import { getNoteResources, getNoteResourcesForZip, moveNoteToRecycleBin, restoreNote, type NoteResource } from '@/api/note'
import { bumpNoteDataVersion } from '@/utils/noteEvents'
import { proxyImgSrc } from '@/utils/proxy'
import { downloadBlob } from '@/utils/download'
import { useIsMobile } from '@/composables/useIsMobile'

const { isMobile } = useIsMobile()

const OSS_BASE = 'http://friday-note.oss-cn-hangzhou.aliyuncs.com/'
const PDF_FOOTER = 'https://gl.zytb.loshop.com.cn'
/** 仅图片资源可渲染，模板 .bin 等需过滤 */
const IMG_EXT_RE = /\.(jpg|jpeg|png|webp|gif|bmp)$/i

interface ResEntry {
  url: string
  imgSrc: string
  ext: string
}
interface PageData {
  thumbnail?: ResEntry
  originals: ResEntry[]
}

const route = useRoute()
const router = useRouter()

const fileId = computed(() => String(route.params.fileId || ''))
const fileName = computed(() => String(route.query.name || ''))

const loading = ref(false)
const exporting = ref(false)
const downloading = ref(false)
const deleting = ref(false)

/**
 * 移入回收站（官方 CloudNotes 接口 MoveToRecycleBin）。
 * 站点没有「回收站浏览」页面，因此操作后立即给出「撤销」入口；
 * 撤销用接口返回的真实 parentId 恢复，可放回原目录。
 */
async function onMoveToRecycle() {
  if (!fileId.value) return
  deleting.value = true
  try {
    const res = await moveNoteToRecycleBin([fileId.value])
    // 通知列表页数据已变更：/note 有 keepAlive + 已加载缓存，
    // 不通知的话返回列表后这条笔记仍会显示（「删了不消失」）。
    bumpNoteDataVersion()
    // 注意：MoveToRecycleBin 对根目录下的笔记会返回 parentId "-1"，
    // 而 Restore 只接受 "0" 表示根目录（实测确认），故此处做一次归一化。
    const raw = String(res?.[0]?.parentId ?? '0')
    const parentId = raw === '-1' ? '0' : raw
    await router.push('/note')
    // 站点没有回收站浏览页，因此立刻给出撤销入口（用返回的真实 parentId 恢复）
    ElMessageBox.confirm('笔记已移入回收站。是否撤销（放回原目录）？', '已移入回收站', {
      confirmButtonText: '撤销',
      cancelButtonText: '不用了',
      type: 'info',
      closeOnClickModal: false
    })
      .then(async () => {
        try {
          await restoreNote(parentId, fileId.value)
          bumpNoteDataVersion()
          ElMessage.success('已恢复到原目录')
        } catch (e: any) {
          ElMessage.error('恢复失败：' + (e?.message || e))
        }
      })
      .catch(() => {
        /* 用户选择不撤销 */
      })
  } catch (e: any) {
    ElMessage.error('移入回收站失败：' + (e?.message || e))
  } finally {
    deleting.value = false
  }
}
const showSheet = ref(false)
const progressVisible = ref(false)
const progressPercent = ref(0)
const progressText = ref('')

const pageMap = ref<Record<number, PageData>>({})
const pages = ref<number[]>([])
const currentPage = ref(1)

const currentPageData = computed(() => pageMap.value[pages.value[currentPage.value - 1]])

/** 当前页所有插入图片的地址，供大图预览切换 */
const originalPreviewList = computed(() =>
  (currentPageData.value?.originals || []).map((o) => o.imgSrc)
)

function goBack() {
  if (window.history.state?.back) router.back()
  else router.push('/note')
}

/** 移动端底部面板命令分发 */
function onActionCommand(cmd: string) {
  showSheet.value = false
  if (cmd === 'pdf') exportPdf()
  else if (cmd === 'zip') downloadZip()
}

/** 资源地址转换（复刻 noteDownload 中 ossImageUrl 处理） */
function toEntry(item: NoteResource): ResEntry {
  const full = item.ossImageUrl.startsWith('http') ? item.ossImageUrl : OSS_BASE + item.ossImageUrl
  // 修复：`url`（导出 PDF / 打包下载时 fetch 的地址）原本走 proxyUrl()，
  // 远端代理已下线 → 导出与打包全部失败。改为与预览一致的直连策略。
  // 导出 PDF 需要 canvas 可读像素，跨域直连若不带 CORS 头会污染画布，
  // 因此这里保留一个「直连优先、必要时回落代理」的策略由 proxyImgSrc 统一决定。
  return {
    url: proxyImgSrc(full),
    imgSrc: proxyImgSrc(full),
    ext: item.ossImageUrl.split('.').pop() || ''
  }
}

async function loadResources() {
  if (!fileId.value) return
  loading.value = true
  pageMap.value = {}
  pages.value = []
  currentPage.value = 1
  try {
    const list = await getNoteResources(fileId.value)
    const map: Record<number, PageData> = {}
    for (const item of list) {
      // 过滤模板 bin 等非图片资源
      if (!IMG_EXT_RE.test(item.ossImageUrl)) continue
      const page = item.pageIndex + 1
      if (!map[page]) map[page] = { originals: [] }
      if (item.resourceType === 2) {
        // resourceType 2 为页面总览截图
        map[page].thumbnail = toEntry(item)
      } else {
        // 其余为页内插入的图片
        map[page].originals.push(toEntry(item))
      }
    }
    pageMap.value = map
    pages.value = Object.keys(map)
      .map(Number)
      .sort((a, b) => a - b)
  } catch (e: any) {
    ElMessage.error(e.message || '加载笔记失败')
  } finally {
    loading.value = false
  }
}

/**
 * 图片转 DataURL，并返回其真实 MIME（复刻 loadImageAsDataURL）
 *
 * 修复（原实现三处会导致「导出 PDF 时彻底卡死」）：
 *  1. fetch 不检查 resp.ok：代理/源站返回 404/403 的 HTML 也会被当成图片；
 *  2. FileReader 只挂 onloadend 不挂 onerror：失败时 Promise 永不 settle；
 *  3. 调用方 await 的 `new Promise(r => imgObj.onload = r)` 完全没有 onerror 分支，
 *     图片解码失败（非图片内容/损坏）时**永远挂起**，而进度弹窗 show-close=false、
 *     close-on-click-modal=false，用户无法关闭 → 整页锁死。
 */
async function loadImageAsDataURL(url: string): Promise<{ dataUrl: string; mime: string }> {
  // cache:'no-store'：学校 OSS 不带 Vary: Origin，<img> 预览的 no-cors 响应（无 ACAO）
  // 会污染缓存，导出时 fetch(cors) 命中同一缓存必被 CORS 拒绝（Failed to fetch），必须绕开
  const res = await fetch(url, { cache: 'no-store' })
  if (!res.ok) throw new Error(`图片下载失败（HTTP ${res.status}）`)
  const blob = await res.blob()
  if (!blob || blob.size === 0) throw new Error('图片内容为空')
  const mime = (blob.type || '').toLowerCase()
  if (mime && !mime.startsWith('image/')) {
    throw new Error(`返回的不是图片（Content-Type: ${mime}）`)
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onloadend = () => resolve({ dataUrl: reader.result as string, mime })
    reader.onerror = () => reject(new Error('图片读取失败'))
    reader.readAsDataURL(blob)
  })
}

/** 等待 <img> 解码完成；失败或超时一律 reject，避免永久挂起 */
function decodeImage(img: HTMLImageElement, timeoutMs = 30000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      cleanup()
      reject(new Error('图片解码超时'))
    }, timeoutMs)
    function cleanup() {
      window.clearTimeout(timer)
      img.onload = null
      img.onerror = null
    }
    img.onload = () => { cleanup(); resolve() }
    img.onerror = () => { cleanup(); reject(new Error('图片解码失败')) }
  })
}

/** 导出 PDF（复刻 exportPdfBtn 逻辑） */
async function exportPdf() {
  if (pages.value.length === 0) return
  exporting.value = true
  progressVisible.value = true
  progressText.value = '正在导出 PDF...'
  progressPercent.value = 0
  try {
    const pdf = new jsPDF('p', 'pt', 'a4')
    let added = 0
    let skipped = 0
    for (let i = 0; i < pages.value.length; i++) {
      const pageData = pageMap.value[pages.value[i]]
      if (!pageData?.thumbnail) continue

      try {
        const { dataUrl: img, mime } = await loadImageAsDataURL(pageData.thumbnail.url)
        const imgObj = new Image()
        imgObj.src = img
        await decodeImage(imgObj)

        const natW = imgObj.naturalWidth || imgObj.width
        const natH = imgObj.naturalHeight || imgObj.height
        // 宽高为 0 时 ratio 会变成 Infinity/NaN，jsPDF 会画出不可见内容
        if (!natW || !natH) throw new Error(`图片尺寸无效（${natW}x${natH}）`)

        const pageWidth = pdf.internal.pageSize.getWidth()
        const pageHeight = pdf.internal.pageSize.getHeight()
        const ratio = Math.min(pageWidth / natW, pageHeight / natH)
        const imgWidth = natW * ratio
        const imgHeight = natH * ratio
        const x = (pageWidth - imgWidth) / 2
        const y = (pageHeight - imgHeight) / 2

        // 按真实 MIME 选择格式：png 数据硬写成 JPEG 会让部分阅读器无法渲染
        const format = mime.includes('png') ? 'PNG' : 'JPEG'

        if (added > 0) pdf.addPage()
        pdf.addImage(img, format, x, y, imgWidth, imgHeight)
        added++

        pdf.setFontSize(8)
        pdf.setTextColor(100)
        const textWidth = pdf.getTextWidth(PDF_FOOTER)
        pdf.text(PDF_FOOTER, pageWidth - textWidth - 20, pageHeight - 20)
      } catch (e) {
        // 单页取图失败（坏链/缓存污染残留）只跳过该页，不让整个 PDF 报废
        console.warn(`跳过第 ${i + 1} 页：`, e)
        skipped++
      }

      progressPercent.value = Math.round(((i + 1) / pages.value.length) * 100)
    }
    if (added === 0) throw new Error('没有可用的页面图片，导出中止')
    if (skipped > 0) ElMessage.warning(`${skipped} 页获取失败已跳过`)
    pdf.save(fileName.value + '.pdf')
    ElMessage.success('PDF 导出完成')
  } catch (e: any) {
    ElMessage.error(e.message || '导出 PDF 失败')
  } finally {
    progressVisible.value = false
    exporting.value = false
  }
}

/** 打包下载 zip（复刻 noteDownload2） */
async function downloadZip() {
  if (!fileId.value) {
    ElMessage.warning('笔记 ID 为空，无法下载')
    return
  }
  downloading.value = true
  progressVisible.value = true
  progressText.value = '正在获取笔记图片...'
  progressPercent.value = 0
  try {
    const list = await getNoteResourcesForZip(fileId.value)
    const zip = new JSZip()
    const count: Record<number, number> = {}

    for (let i = 0; i < list.length; i++) {
      const item = list[i]
      const url = proxyImgSrc(
        item.ossImageUrl.startsWith('http') ? item.ossImageUrl : OSS_BASE + item.ossImageUrl
      )
      progressPercent.value = Math.round(((i + 1) / list.length) * 100)
      if (!/\.(jpg|jpeg|png|webp)$/i.test(url)) continue
      try {
        // cache:'no-store'：绕过被 <img> 预览污染的 HTTP 缓存（无 ACAO 头会导致 CORS 拒绝）
        const resp = await fetch(url, { cache: 'no-store' })
        if (!resp.ok) {
          console.warn('跳过下载失败的图片', url, resp.status)
          continue
        }
        const image = await resp.blob()
        if (!image.size) continue
        if (!count[item.pageIndex]) count[item.pageIndex] = 1
        const suffix = item.resourceType === 2 ? 'thumbnail' : count[item.pageIndex]++
        zip.file(`${item.pageIndex + 1}-${suffix}.jpg`, image)
      } catch (e) {
        // 单个资源网络/CORS 失败只跳过该项，不能让整包下载全部报废
        console.warn('跳过获取失败的图片', url, e)
      }
    }

    progressText.value = '正在打包...'
    const content = await zip.generateAsync({ type: 'blob' })
    downloadBlob(content, (fileName.value || 'note') + '.zip')
    ElMessage.success('下载已启动')
  } catch (e: any) {
    ElMessage.error(e.message || '下载失败')
  } finally {
    progressVisible.value = false
    downloading.value = false
  }
}

onMounted(loadResources)
// keep-alive 会复用同一组件实例，切换不同笔记文件时需重新加载
watch(
  () => [route.params.fileId, route.query.name],
  () => loadResources()
)
</script>

<style scoped>
.note-detail {
  padding: 0;
  display: flex;
  flex-direction: column;
  min-height: 100%;
}
/* 顶部 sticky 返回栏（参考 Gblox 帖子详情 appbar） */
.appbar {
  position: sticky;
  top: 0;
  z-index: 50;
  display: flex;
  align-items: center;
  gap: 8px;
  height: 52px;
  padding: 0 16px;
  margin-bottom: 12px;
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
/* 三个点按钮：无背景、黑色图标（参考 Gblox ContentActionsMenu） */
.more-btn {
  width: 36px;
  height: 36px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 20px;
  color: var(--el-text-color-primary);
  border: none;
  padding: 0;
  cursor: pointer;
  border-radius: 50%;
  background: transparent;
  transition: background 0.2s;
  flex-shrink: 0;
}
.more-btn:hover {
  background: var(--el-fill-color-light);
}
/* 移动端底部弹出面板（带遮罩） */
.actions-mask {
  position: fixed;
  inset: 0;
  z-index: 2000;
  background: rgba(0, 0, 0, 0.45);
}
.actions-sheet {
  position: fixed;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 2001;
  padding: 8px 0 calc(8px + env(safe-area-inset-bottom));
  background: var(--el-bg-color);
  border-top-left-radius: 14px;
  border-top-right-radius: 14px;
  box-shadow: 0 -4px 16px rgba(0, 0, 0, 0.12);
}
.actions-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 15px 20px;
  font-size: 16px;
  color: var(--el-text-color-primary);
  cursor: pointer;
}
.actions-item:active {
  background: var(--el-fill-color-light);
}
.actions-cancel {
  margin-top: 6px;
  padding: 15px 20px;
  text-align: center;
  font-size: 16px;
  color: var(--el-text-color-secondary);
  border-top: 1px solid var(--el-border-color-lighter);
  cursor: pointer;
}
.preview-body {
  flex: 1 1 auto;
  min-height: 60vh;
  display: flex;
  align-items: flex-start;
  justify-content: center;
  border-radius: 8px;
  padding: 16px;
  overflow: auto;
}
.page-content {
  width: 100%;
  display: flex;
  flex-direction: column;
}
/* 页面总览（笔记截图）：居中大图，完整显示不裁剪 */
.thumb-wrap {
  width: 100%;
  display: flex;
  justify-content: center;
  margin-bottom: 20px;
}
.thumb-img {
  max-width: 100%;
  box-shadow: 0 2px 8px #ccc;
  border-radius: 4px;
  cursor: zoom-in;
}
/* el-image 内部 img 需显式约束，否则会溢出容器 */
.thumb-img :deep(img) {
  display: block;
  width: auto;
  height: auto;
  object-fit: contain;
  max-width: 100%;
  max-height: calc(100vh - 300px);
  min-height: 320px;
}
/* 页内插入图片：水平滚动小图 */
.originals-block {
  width: 100%;
  border-top: 1px solid var(--el-border-color-lighter);
  padding-top: 12px;
}
.originals-label {
  font-size: 13px;
  color: var(--el-text-color-secondary);
  margin-bottom: 8px;
}
.originals-row {
  width: 100%;
  overflow-x: auto;
  white-space: nowrap;
  display: flex;
  gap: 16px;
  padding-bottom: 8px;
}
.orig-img {
  flex: 0 0 auto;
  height: 120px;
  max-width: 180px;
  border-radius: 4px;
  box-shadow: 0 1px 4px #bbb;
  cursor: zoom-in;
}
.img-error {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  height: 100%;
  min-height: 120px;
  color: var(--el-text-color-placeholder);
  background: var(--el-fill-color-light);
  border-radius: 6px;
}
.img-error.small {
  min-height: 120px;
  width: 120px;
}
.pager-bar {
  position: sticky;
  bottom: 0;
  z-index: 40;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  margin-top: 12px;
  background: var(--el-bg-color);
  border: 1px solid var(--el-border-color-light);
  border-radius: 8px;
  padding: 12px;
}
.page-input {
  width: 110px;
}
.page-info {
  color: var(--el-text-color-secondary);
}
.progress-text {
  margin-bottom: 12px;
}

/* ===== 移动端适配 ===== */
@media (max-width: 767px) {
  .note-detail {
    padding: 0;
  }
  /* 顶栏通栏（content 已 flush） */
  .appbar {
    margin-bottom: 8px;
    padding: 0 10px;
  }
  .preview-body {
    border-radius: 6px;
    padding: 8px;
  }
  .pager-bar {
    position: fixed;
    left: 0;
    right: 0;
    bottom: 0;
    z-index: 60;
    justify-content: space-around;
    border-radius: 0;
    padding: 8px 10px;
    gap: 6px;
    background: var(--el-bg-color);
    border-top: 1px solid var(--el-border-color-light);
    box-shadow: 0 -2px 8px rgba(0, 0, 0, 0.08);
    padding-bottom: calc(8px + env(safe-area-inset-bottom, 0px));
  }
  /* 预览区底部留出翻页栏高度，避免内容被遮挡 */
  .preview-body {
    margin-bottom: 60px;
  }
  .page-input {
    width: 90px;
  }
  .page-info {
    font-size: 12px;
  }
}
</style>
