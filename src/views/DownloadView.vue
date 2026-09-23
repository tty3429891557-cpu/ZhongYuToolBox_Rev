<template>
  <div class="download-page">
    <el-card class="block">
      <template #header>
        <div class="head">
          <span>中育 APP 下载</span>
          <el-button :icon="Refresh" size="small" :loading="loading" @click="loadAll">刷新全部</el-button>
        </div>
      </template>
      <el-alert type="warning" :closable="false" show-icon class="tip"
        title="本页仅提供官方安装包下载，不保证可在你的设备上运行。安装包地址来自学校接口，可能随官方更新变化。" />

      <div class="grid">
        <div v-for="item in items" :key="item.key" class="cell">
          <div class="icon">
            <el-image v-if="item.info?.icon" :src="proxyImgSrc(item.info.icon)" fit="contain" class="img">
              <template #error><el-icon class="ph"><Cellphone /></el-icon></template>
            </el-image>
            <el-icon v-else class="ph"><Cellphone /></el-icon>
          </div>
          <div class="meta">
            <div class="name">
              {{ item.info?.name || item.label }}
              <el-tag v-if="item.info?.versionName" size="small" type="info">v{{ item.info.versionName }}</el-tag>
            </div>
            <div class="pkg">{{ item.packageName }}</div>
            <div class="sub">
              <span>{{ item.info ? formatSize(item.info.size) : item.error ? '查询失败' : '查询中…' }}</span>
              <span v-if="item.info?.lastModificationTime" class="t">{{ item.info.lastModificationTime.slice(0, 10) }}</span>
            </div>
            <div v-if="item.note" class="note">{{ item.note }}</div>
          </div>
          <div class="act">
            <el-button type="primary" :icon="DownloadIcon" size="small" :disabled="!item.info?.fileUrl" @click="download(item)">
              下载
            </el-button>
          </div>
        </div>
      </div>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { ElMessage } from 'element-plus'
import { Refresh, Download as DownloadIcon, Cellphone } from '@element-plus/icons-vue'
import {
  DOWNLOAD_APPS,
  checkUpdateWithFallback,
  formatSize,
  type AppEntry,
  type AppInfo
} from '@/api/appstore'
import { proxyImgSrc } from '@/utils/proxy'

interface Row {
  key: string
  label: string
  packageName: string
  note?: string
  info: AppInfo | null
  error?: string
}

const items = ref<Row[]>(DOWNLOAD_APPS.map((a: AppEntry) => ({ ...a, info: null })))
const loading = ref(false)

async function loadAll() {
  loading.value = true
  try {
    await Promise.all(
      items.value.map(async (row) => {
        row.info = null
        row.error = undefined
        try {
          row.info = await checkUpdateWithFallback(row.packageName)
        } catch (e: any) {
          row.error = e?.message || String(e)
        }
      })
    )
  } finally {
    loading.value = false
  }
}

function download(row: Row) {
  const url = row.info?.fileUrl
  if (!url) {
    ElMessage.warning('未获取到安装包地址，请先刷新')
    return
  }
  // 安装包在 CDN 上，直接新窗口打开即可触发下载
  window.open(url, '_blank')
}

onMounted(loadAll)
</script>

<style scoped>
.download-page {
  max-width: 960px;
  margin: 0 auto;
}
.block {
  margin-bottom: 16px;
}
.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.tip {
  margin-bottom: 12px;
}
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  gap: 12px;
}
.cell {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 10px;
  background: var(--el-fill-color-blank);
}
.icon {
  width: 46px;
  height: 46px;
  flex: 0 0 46px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 10px;
  background: var(--el-fill-color-light);
  overflow: hidden;
}
.img {
  width: 100%;
  height: 100%;
}
.ph {
  font-size: 24px;
  color: var(--el-text-color-placeholder);
}
.meta {
  flex: 1;
  min-width: 0;
}
.name {
  font-weight: 600;
  display: flex;
  align-items: center;
  gap: 6px;
}
.pkg {
  font-size: 12px;
  color: var(--el-text-color-secondary);
  word-break: break-all;
}
.sub {
  font-size: 12px;
  color: var(--el-text-color-secondary);
  display: flex;
  gap: 10px;
}
.note {
  font-size: 12px;
  color: var(--el-color-warning);
}
.act {
  flex: 0 0 auto;
}
@media (max-width: 767px) {
  .grid {
    grid-template-columns: 1fr;
  }
}
</style>
