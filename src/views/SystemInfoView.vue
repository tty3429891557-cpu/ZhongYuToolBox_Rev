<template>
  <div class="sys-page">
    <!-- 待办 -->
    <el-card class="block" v-loading="loading.todo">
      <template #header>
        <div class="head">
          <span>待办事项</span>
          <el-button :icon="Refresh" size="small" :loading="loading.todo" @click="loadTodo">刷新</el-button>
        </div>
      </template>
      <div class="todo-grid">
        <div v-for="t in todoCards" :key="t.key" class="todo-cell">
          <div class="num">{{ t.value }}</div>
          <div class="lab">{{ t.label }}</div>
        </div>
      </div>
    </el-card>

    <!-- 能力许可 -->
    <el-card class="block" v-loading="loading.ability">
      <template #header>
        <div class="head">
          <span>功能许可（相机 / 相册 / 截屏）</span>
          <el-button :icon="Refresh" size="small" :loading="loading.ability" @click="loadAbility">刷新</el-button>
        </div>
      </template>
      <p class="muted">该开关由学校管控平台下发，查询包名 <code>{{ abilityPkg }}</code>。</p>
      <div class="ability-row">
        <div v-for="a in abilityList" :key="a.kind" class="ability-cell">
          <span class="lab">{{ a.label }}</span>
          <el-tag :type="a.allowed ? 'success' : 'danger'" size="small">
            {{ a.allowed ? '允许' : '禁止' }}
          </el-tag>
        </div>
      </div>
    </el-card>

    <!-- 未读 + 系统消息 -->
    <el-card class="block" v-loading="loading.msg">
      <template #header>
        <div class="head">
          <span>系统消息</span>
          <div>
            <el-tag v-for="u in unread" :key="u.type" size="small" class="tag" :type="u.count > 0 ? 'warning' : 'info'">
              {{ unreadLabel(u.type) }} {{ u.count }}
            </el-tag>
            <el-button :icon="Refresh" size="small" :loading="loading.msg" @click="loadMessages">刷新</el-button>
          </div>
        </div>
      </template>
      <el-empty v-if="!messages.length" description="暂无系统消息" />
      <div v-else class="msg-list">
        <div v-for="(m, i) in messages" :key="i" class="msg-item">
          <div class="msg-title">
            <el-tag v-if="!m.isRead" type="danger" size="small">未读</el-tag>
            {{ m.title || '(无标题)' }}
          </div>
          <div class="msg-sub">
            <span v-if="m.senderInfo?.fullName">{{ m.senderInfo.fullName }}</span>
            <span class="t">{{ m.creationTime }}</span>
            <el-button v-if="m.parameter?.id" link type="primary" size="small" @click="openNotice(m.parameter.id)">
              查看公告
            </el-button>
          </div>
        </div>
      </div>
    </el-card>

    <!-- 我的话题 -->
    <el-card class="block" v-loading="loading.topic">
      <template #header>
        <div class="head">
          <span>我的话题（学科）</span>
          <el-button :icon="Refresh" size="small" :loading="loading.topic" @click="loadTopics">刷新</el-button>
        </div>
      </template>
      <el-empty v-if="!topics.length" description="暂无话题" />
      <div v-else class="topic-row">
        <el-tag v-for="t in topics" :key="t.id" size="large" :color="t.color" effect="dark" class="topic">
          {{ t.content || t.name }}
        </el-tag>
      </div>
    </el-card>

    <!-- 学校与系统设置 -->
    <el-card class="block" v-loading="loading.setting">
      <template #header>
        <div class="head">
          <span>学校与系统设置</span>
          <el-button :icon="Refresh" size="small" :loading="loading.setting" @click="loadSettings">刷新</el-button>
        </div>
      </template>
      <el-tabs>
        <el-tab-pane label="学校设置 (GetAllSettings)">
          <el-descriptions :column="2" border size="small">
            <el-descriptions-item v-for="(v, k) in settings" :key="k" :label="String(k)">
              <span class="val">{{ fmt(v) }}</span>
            </el-descriptions-item>
          </el-descriptions>
        </el-tab-pane>
        <el-tab-pane label="系统开关 (GetSystemSettingsAsync)">
          <el-descriptions :column="2" border size="small">
            <el-descriptions-item v-for="(v, k) in sysSettings" :key="k" :label="String(k)">
              <span class="val">{{ fmt(v) }}</span>
            </el-descriptions-item>
          </el-descriptions>
        </el-tab-pane>
        <el-tab-pane label="网址白名单">
          <p class="muted">服务端返回的是加密串，此处原样展示（长度 {{ whiteUrls.length }}）。</p>
          <el-input type="textarea" :rows="5" :model-value="whiteUrls" readonly />
          <p v-if="commonSites.length" class="muted">常用网站：{{ commonSites.length }} 条</p>
          <p v-else class="muted">常用网站：无</p>
        </el-tab-pane>
      </el-tabs>
    </el-card>

    <!-- 公告 -->
    <el-dialog v-model="noticeVisible" :title="notice?.title || '公告'" width="640px">
      <div v-if="notice" class="notice">
        <div class="muted">{{ notice.creationTime }}</div>
        <div class="notice-body" v-html="safeNoticeHtml"></div>
      </div>
      <el-empty v-else description="公告不存在" />
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, computed, onMounted } from 'vue'
import { ElMessage } from 'element-plus'
import { Refresh } from '@element-plus/icons-vue'
import {
  getTodoSummary,
  getAllSettings,
  getSystemSettings,
  getUnreadCounts,
  getSystemMessages,
  canIOpen,
  getMyTopics,
  getWhiteUrls,
  getCommonWebSites,
  getNotice,
  ABILITY_LABEL,
  type AbilityKind,
  type SystemMessage,
  type Topic,
  type UnreadItem,
  type NoticeInfo
} from '@/api/system'
import { safeHtml } from '@/utils/sanitize'

const loading = reactive({ todo: false, ability: false, msg: false, topic: false, setting: false })

const todoCards = ref<{ key: string; label: string; value: number }[]>([])
const abilityPkg = ref('com.zykj.manage')
const abilityList = ref<{ kind: AbilityKind; label: string; allowed: boolean }[]>([])
const unread = ref<UnreadItem[]>([])
const messages = ref<SystemMessage[]>([])
const topics = ref<Topic[]>([])
const settings = ref<Record<string, any>>({})
const sysSettings = ref<Record<string, any>>({})
const whiteUrls = ref('')
const commonSites = ref<any[]>([])
const notice = ref<NoticeInfo | null>(null)
const noticeVisible = ref(false)

/** 公告正文是服务端富文本，走 v-html 前必须净化（防内联事件 XSS） */
const safeNoticeHtml = computed(() => safeHtml(notice.value?.content))

const TODO_LABELS: Record<string, string> = {
  homeworkCount: '作业',
  reviseCount: '订正',
  quoraCount: '随身答',
  unReadSpecialCount: '未读专题',
  unReplySpecialCount: '未回复专题'
}

const UNREAD_LABELS: Record<number, string> = { 1: '系统', 2: '专栏', 3: '其它' }
function unreadLabel(t: number) {
  return UNREAD_LABELS[t] || `类型${t}`
}

async function loadTodo() {
  loading.todo = true
  try {
    const d = await getTodoSummary()
    todoCards.value = Object.keys(TODO_LABELS).map((k) => ({
      key: k,
      label: TODO_LABELS[k],
      value: Number(d[k] ?? 0)
    }))
  } catch (e: any) {
    ElMessage.error('待办获取失败：' + (e?.message || e))
  } finally {
    loading.todo = false
  }
}

async function loadAbility() {
  loading.ability = true
  try {
    const kinds: AbilityKind[] = ['Camera', 'Album', 'ScreenShot']
    const rs = await Promise.all(kinds.map((k) => canIOpen(k, abilityPkg.value).catch(() => false)))
    abilityList.value = kinds.map((k, i) => ({ kind: k, label: ABILITY_LABEL[k], allowed: rs[i] }))
  } finally {
    loading.ability = false
  }
}

async function loadMessages() {
  loading.msg = true
  try {
    const [u, m] = await Promise.all([getUnreadCounts().catch(() => []), getSystemMessages(0, 20).catch(() => [])])
    unread.value = u
    messages.value = m
  } finally {
    loading.msg = false
  }
}

async function loadTopics() {
  loading.topic = true
  try {
    topics.value = await getMyTopics()
  } catch {
    /* ignore */
  } finally {
    loading.topic = false
  }
}

async function loadSettings() {
  loading.setting = true
  try {
    const [a, b, w, c] = await Promise.all([
      getAllSettings().catch(() => ({})),
      getSystemSettings().catch(() => ({})),
      getWhiteUrls().catch(() => ''),
      getCommonWebSites().catch(() => [])
    ])
    settings.value = a
    sysSettings.value = b
    whiteUrls.value = w
    commonSites.value = c
  } finally {
    loading.setting = false
  }
}

async function openNotice(id?: number) {
  if (!id) return
  notice.value = null
  noticeVisible.value = true
  try {
    notice.value = await getNotice(id)
  } catch (e: any) {
    ElMessage.error('公告获取失败：' + (e?.message || e))
  }
}

function fmt(v: any): string {
  if (v === null || v === undefined) return '—'
  if (typeof v === 'object') return JSON.stringify(v)
  const s = String(v)
  return s.length > 80 ? s.slice(0, 80) + '…' : s
}

onMounted(() => {
  loadTodo()
  loadAbility()
  loadMessages()
  loadTopics()
  loadSettings()
})
</script>

<style scoped>
.sys-page {
  max-width: 1000px;
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
.muted {
  color: var(--el-text-color-secondary);
  font-size: 13px;
}
.todo-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
  gap: 12px;
}
.todo-cell {
  text-align: center;
  padding: 10px;
  border-radius: 10px;
  background: var(--el-fill-color-light);
}
.todo-cell .num {
  font-size: 26px;
  font-weight: 700;
  color: var(--el-color-primary);
}
.todo-cell .lab {
  font-size: 13px;
  color: var(--el-text-color-secondary);
}
.ability-row {
  display: flex;
  gap: 24px;
  flex-wrap: wrap;
}
.ability-cell {
  display: flex;
  align-items: center;
  gap: 8px;
}
.tag {
  margin-right: 6px;
}
.msg-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.msg-item {
  padding: 8px 10px;
  border-radius: 8px;
  background: var(--el-fill-color-light);
}
.msg-title {
  font-weight: 600;
  display: flex;
  align-items: center;
  gap: 6px;
}
.msg-sub {
  font-size: 12px;
  color: var(--el-text-color-secondary);
  display: flex;
  align-items: center;
  gap: 10px;
}
.topic-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.topic {
  border: none;
  color: #fff;
}
.val {
  word-break: break-all;
}
.notice-body {
  margin-top: 8px;
  line-height: 1.7;
  max-height: 60vh;
  overflow: auto;
}
@media (max-width: 767px) {
  .todo-grid {
    grid-template-columns: repeat(2, 1fr);
  }
}
</style>
