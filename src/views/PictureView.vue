<template>
  <div class="picture-page">
    <el-tabs v-model="activeTab" class="picture-tabs">
      <!-- 正常图库 -->
      <el-tab-pane label="图库" name="normal">
        <div class="section-bar">
          <el-upload
            :show-file-list="false"
            accept="image/*"
            :before-upload="beforeUpload"
            :disabled="uploading"
          >
            <el-button type="primary" :icon="Upload" :loading="uploading">
              {{ uploading ? '上传中...' : '上传图片' }}
            </el-button>
          </el-upload>
        </div>

        <el-empty v-if="!loading.normal && !normal.loadingMore && normal.items.length === 0" description="暂无图片" />
        <div v-else class="grid-scroll">
          <div class="pic-grid">
            <div
              v-for="item in normal.items"
              :key="item.id"
              class="pic-cell"
              @click="openDetail(item)"
            >
              <el-image :src="proxyImgSrc(item.picture)" fit="cover" class="pic-img" lazy>
                <template #error>
                  <div class="pic-ph"><el-icon><Picture /></el-icon></div>
                </template>
              </el-image>
              <div class="cell-act">
                <el-popconfirm title="移入回收站？" @confirm="onMoveToRecycle(item)">
                  <template #reference>
                    <el-button class="mini" size="small" type="danger" :icon="Delete" :loading="acting" @click.stop />
                  </template>
                </el-popconfirm>
              </div>
            </div>
          </div>
          <div class="load-more">
            <el-icon v-if="normal.loadingMore" class="rotating"><Loading /></el-icon>
            <span v-else-if="!normal.finished">加载更多...</span>
            <span v-else class="muted">没有更多了</span>
          </div>
        </div>
      </el-tab-pane>

      <!-- 回收站 -->
      <el-tab-pane label="回收站" name="recycle">
        <div class="section-bar">
          <el-popconfirm title="确定清空回收站？此操作不可恢复" @confirm="onEmptyRecycle">
            <template #reference>
              <el-button type="danger" plain :icon="Delete" :loading="acting">清空回收站</el-button>
            </template>
          </el-popconfirm>
        </div>

        <el-empty v-if="!loading.recycle && !recycle.loadingMore && recycle.items.length === 0" description="回收站为空" />
        <div v-else class="grid-scroll">
          <div class="pic-grid">
            <div
              v-for="item in recycle.items"
              :key="item.id"
              class="pic-cell"
              @click="openDetail(item)"
            >
              <el-image :src="proxyImgSrc(item.picture)" fit="cover" class="pic-img" lazy>
                <template #error>
                  <div class="pic-ph"><el-icon><Picture /></el-icon></div>
                </template>
              </el-image>
              <div class="cell-act">
                <el-button class="mini" size="small" type="primary" :icon="RefreshLeft" :loading="acting"
                  @click.stop="onRecover(item)" />
                <el-popconfirm title="彻底删除？不可恢复" @confirm="onDeleteForever(item)">
                  <template #reference>
                    <el-button class="mini" size="small" type="danger" :icon="Delete" :loading="acting" @click.stop />
                  </template>
                </el-popconfirm>
              </div>
            </div>
          </div>
          <div class="load-more">
            <el-icon v-if="recycle.loadingMore" class="rotating"><Loading /></el-icon>
            <span v-else-if="!recycle.finished">加载更多...</span>
            <span v-else class="muted">没有更多了</span>
          </div>
        </div>
      </el-tab-pane>
    </el-tabs>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, onMounted, onBeforeUnmount, onActivated, onDeactivated, watch, nextTick } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { Upload, Picture, Loading, Delete, RefreshLeft } from '@element-plus/icons-vue'
import { getPictures, addPicture, recordPictures, formatFileSize, moveToRecycleBin, recoverPictures, deletePictures, emptyRecycleBin, type PictureItem } from '@/api/picture'
import { uploadGalleryImage, fetchUserId } from '@/utils/oss'
import { proxyImgSrc } from '@/utils/proxy'

const router = useRouter()
const PAGE_SIZE = 12

const activeTab = ref<'normal' | 'recycle'>('normal')
const uploading = ref(false)

interface SectionState {
  items: PictureItem[]
  total: number
  skip: number
  loadingMore: boolean
  finished: boolean
  /** 加载是否失败过：失败后不再自动续加载，避免无限重试打爆服务端并刷屏报错 */
  failed: boolean
}
const loading = reactive({ normal: false, recycle: false })
const normal = reactive<SectionState>({ items: [], total: 0, skip: 0, loadingMore: false, finished: false, failed: false })
const recycle = reactive<SectionState>({ items: [], total: 0, skip: 0, loadingMore: false, finished: false, failed: false })

function sectionOf(key: 'normal' | 'recycle'): SectionState {
  return key === 'normal' ? normal : recycle
}

function getScrollEl(): HTMLElement | null {
  return document.querySelector('.content') as HTMLElement | null
}

function onScroll() {
  const key = activeTab.value
  const s = sectionOf(key)
  if (s.loadingMore || s.finished || s.failed) return
  const el = getScrollEl()
  if (!el) return
  const scrollTop = el.scrollTop
  const clientH = el.clientHeight
  const scrollH = el.scrollHeight
  if (scrollTop + clientH >= scrollH - 240) {
    loadMore(key).then(fillViewport)
  }
}

/** 若内容未填满可视区（无滚动条），自动续加载，直到填满或结束 */
function fillViewport() {
  const key = activeTab.value
  const s = sectionOf(key)
  if (s.loadingMore || s.finished || s.failed) return
  const el = getScrollEl()
  if (!el) return
  if (el.scrollHeight <= el.clientHeight + 120) {
    loadMore(key).then(() => requestAnimationFrame(fillViewport))
  }
}

function openDetail(item: PictureItem) {
  router.push({
    path: '/picture/detail',
    query: {
      picture: item.picture,
      name: item.name,
      size: item.size,
      createTime: item.createTime,
      id: item.id
    }
  })
}

/** 回收站操作（依据官方 APK PictureLibrary 接口） */
const acting = ref(false)

async function afterChange() {
  await loadFirst('normal')
  await loadFirst('recycle')
}

async function onMoveToRecycle(item: PictureItem) {
  if (!item.id) return
  acting.value = true
  try {
    await moveToRecycleBin([Number(item.id)])
    ElMessage.success('已移入回收站')
    await afterChange()
  } catch (e: any) {
    ElMessage.error('移入回收站失败：' + (e?.message || e))
  } finally {
    acting.value = false
  }
}

async function onRecover(item: PictureItem) {
  if (!item.id) return
  acting.value = true
  try {
    await recoverPictures([Number(item.id)])
    ElMessage.success('已恢复')
    await afterChange()
  } catch (e: any) {
    ElMessage.error('恢复失败：' + (e?.message || e))
  } finally {
    acting.value = false
  }
}

async function onDeleteForever(item: PictureItem) {
  if (!item.id) return
  acting.value = true
  try {
    await deletePictures([Number(item.id)])
    ElMessage.success('已彻底删除')
    await afterChange()
  } catch (e: any) {
    ElMessage.error('删除失败：' + (e?.message || e))
  } finally {
    acting.value = false
  }
}

async function onEmptyRecycle() {
  acting.value = true
  try {
    await emptyRecycleBin()
    ElMessage.success('回收站已清空')
    await afterChange()
  } catch (e: any) {
    ElMessage.error('清空失败：' + (e?.message || e))
  } finally {
    acting.value = false
  }
}

async function loadMore(key: 'normal' | 'recycle') {
  const s = sectionOf(key)
  if (s.loadingMore || s.finished) return
  s.loadingMore = true
  const isRecycle = key === 'recycle'
  try {
    const res = await getPictures(isRecycle, s.skip, PAGE_SIZE)
    const items = res.items || []
    const total = res.totalCount || 0
    s.items.push(...items)
    s.total = total
    s.skip += items.length
    if (s.items.length >= total) s.finished = true
  } catch (e: any) {
    s.failed = true
    ElMessage.error('加载失败：' + (e.message || e))
  } finally {
    s.loadingMore = false
  }
}

async function loadFirst(key: 'normal' | 'recycle') {
  loading[key] = true
  const s = sectionOf(key)
  s.items = []
  s.skip = 0
  s.finished = false
  s.failed = false
  await loadMore(key)
  loading[key] = false
  await nextTick()
  fillViewport()
}

function setupObserver() {
  getScrollEl()?.addEventListener('scroll', onScroll, { passive: true })
}
function teardownObservers() {
  getScrollEl()?.removeEventListener('scroll', onScroll)
}

async function beforeUpload(file: File) {
  uploading.value = true
  try {
    let userId: string
    try {
      userId = await fetchUserId()
    } catch (e: any) {
      ElMessage.warning('无法获取用户ID：' + (e.message || e))
      return false
    }

    // 官方图库上传流程（复刻管控桌面 APK）：imagestore_v2 前缀 + fc=11 + ft=File + 扩展名
    // objectKey = imagestore_v2/res/{userId}/{yyyyMMdd}/{nonce}{ext}
    const { url, name } = await uploadGalleryImage(file, userId)
    const sizeStr = formatFileSize(file.size)

    // 登记到图库：body {name, picture, size, appName:"图库"}
    await addPicture(name, url, sizeStr, '图库')
    // 官方随后还会写一条应用记录；非必需，失败不影响图库登记
    try {
      await recordPictures([url], '图库')
    } catch {
      /* ignore */
    }

    ElMessage.success('上传成功')
    await loadFirst('normal')
  } catch (e: any) {
    ElMessage.error('上传失败：' + (e.message || e))
  } finally {
    uploading.value = false
  }
  return false
}

watch(activeTab, async (tab) => {
  const key = tab as 'normal' | 'recycle'
  if (sectionOf(key).items.length === 0) {
    await loadFirst(key)
  } else {
    await nextTick()
    fillViewport()
  }
})

/**
 * 本页在路由上标记了 keepAlive，因此：
 *  - onMounted 只在首次进入时执行一次；
 *  - onBeforeUnmount **永远不会触发**（页面被缓存而非销毁）。
 * 原实现把滚动监听放在 onMounted/onBeforeUnmount，导致离开图库后监听器仍挂在上，
 * 用户滚动其它页面时会继续触发本页的 loadMore（多余请求甚至报错刷屏）。
 * 改用 onActivated/onDeactivated 成对挂载与卸载。
 */
let initialised = false

onMounted(async () => {
  if (!initialised) {
    initialised = true
    await loadFirst('normal')
    await loadFirst('recycle')
  }
  await nextTick()
  setupObserver()
  fillViewport()
})

onActivated(() => {
  setupObserver()
})

onDeactivated(() => {
  teardownObservers()
})

onBeforeUnmount(() => {
  teardownObservers()
})
</script>

<style scoped>
.picture-page {
  max-width: 1100px;
  margin: 0 auto;
}
.picture-tabs {
  --el-tabs-header-height: 48px;
}
.section-bar {
  display: flex;
  justify-content: flex-end;
  margin-bottom: 12px;
}
.grid-scroll {
  min-height: 200px;
}
.pic-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(96px, 1fr));
  gap: 8px;
}
.pic-cell {
  position: relative;
  aspect-ratio: 1 / 1;
  border-radius: 8px;
  overflow: hidden;
  background: var(--el-fill-color-light);
  cursor: pointer;
  transition: transform 0.12s ease;
}
.pic-cell:hover {
  transform: scale(1.03);
}
/* 单元格右上角操作按钮 */
.cell-act {
  position: absolute;
  top: 2px;
  right: 2px;
  display: none;
  gap: 4px;
  align-items: center;
}
.pic-cell:hover .cell-act {
  display: flex;
}
.cell-act .mini {
  padding: 2px 6px;
  height: 24px;
  min-height: 24px;
}
.pic-img {
  width: 100%;
  height: 100%;
  display: block;
}
.pic-ph {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 28px;
  color: var(--el-text-color-placeholder);
}
.load-more {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 16px 0;
  color: var(--el-text-color-secondary);
  font-size: 13px;
}
.load-more .muted {
  color: var(--el-text-color-placeholder);
}
.rotating {
  animation: spin 0.9s linear infinite;
}
@keyframes spin {
  to { transform: rotate(360deg); }
}

/* 移动端适配 */
@media (max-width: 767px) {
  .picture-page {
    padding: 0 4px;
  }
  .pic-grid {
    grid-template-columns: repeat(auto-fill, minmax(72px, 1fr));
    gap: 6px;
  }
  .pic-cell {
    border-radius: 6px;
  }
}
</style>
