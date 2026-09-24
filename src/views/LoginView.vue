<template>
  <div class="login-page">
    <el-card class="login-card" shadow="always">
      <template #header>
        <div class="card-title">用户中心</div>
      </template>

      <div v-if="!auth.isLoggedIn">
        <el-form label-position="top" autocomplete="on" @submit.prevent="onLogin">
          <el-form-item label="学校">
            <!-- 选项来自 config 的 SCHOOLS（单一数据源）。
                 已收录的学校（省锡中 / 省锡中双语学校 / 北京市第八十中学）直接选即可，
                 只有列表里没有的学校才需要选「其它学校」手填代码。 -->
            <el-select v-model="schoolSelect" @change="onSchoolChange" style="width: 100%">
              <el-option v-for="s in SCHOOLS" :key="s.value" :label="s.label" :value="s.value" />
            </el-select>
            <div class="school-hint">
              学校须与账号所属学校一致：两校后端不同、数据不互通，选错学校即使能登录也取不到数据。
            </div>
          </el-form-item>

          <el-form-item v-if="schoolSelect === 'other'" label="学校代码">
            <el-input v-model="schoolCode" name="schoolCode" autocomplete="off" placeholder="输入学校代码" />
          </el-form-item>

          <el-form-item label="用户名">
            <el-input v-model="account" name="username" autocomplete="username" placeholder="输入用户名" autofocus />
          </el-form-item>

          <el-form-item label="密码">
            <el-input v-model="password" name="password" autocomplete="current-password" type="password" placeholder="输入密码" show-password @keyup.enter="onLogin" />
          </el-form-item>

          <el-form-item>
            <el-checkbox v-model="rememberPassword">
              记住密码（用于登录过期后自动重新登录）
            </el-checkbox>
            <div class="school-hint">
              默认不保存。勾选后密码会以混淆形式仅保存在本机浏览器，注销即清除；
              共用电脑或使用公共设备时请不要勾选。
            </div>
          </el-form-item>

          <el-button
            type="primary"
            style="width: 100%"
            :loading="loading"
            @click="onLogin"
          >
            {{ auth.token ? '重新登录' : '登录' }}
          </el-button>
        </el-form>

        <el-alert type="info" :closable="false" class="mt">
          <template #title>说明</template>
          本工具用于快捷查看中育账号资源，与中育智慧（无锡）数字技术有限公司及其关联公司无关。
          开发：Loshop。如遇问题请及时联系，QQ群：1067807011
        </el-alert>
      </div>

      <div v-else>
        <h2 class="welcome">
          <el-avatar :size="48" :src="auth.photo" />
          <span style="margin-left: 10px">{{ auth.userName }}</span>
        </h2>
        <el-button type="primary" plain style="width: 100%" @click="onLogout">注销</el-button>

        <el-alert type="info" :closable="false" class="mt">
          <template #title>说明</template>
          本工具用于快捷查看中育账号资源，与中育智慧（无锡）数字技术有限公司及其关联公司无关。
          开发：Loshop。如遇问题请及时联系，QQ群：1067807011
        </el-alert>
      </div>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { useAuthStore } from '@/stores/auth'
import { loadObfuscatedPassword } from '@/utils/secretStore'
import { SCHOOLS } from '@/config'

const router = useRouter()
const auth = useAuthStore()

const schoolSelect = ref('sxz')
const schoolCode = ref('')
const account = ref('')
const password = ref('')
const rememberPassword = ref(false)
const loading = ref(false)

function onSchoolChange() {
  if (schoolSelect.value !== 'other') schoolCode.value = ''
}

/**
 * 回填上次成功登录的账号与学校，方便重新登录。
 * 注意：密码**不回填到输入框**（只在真正需要自动重登时由 auth.autoRelogin 内部读取），
 * 避免打开登录页就把密码显示在 DOM/内存里。
 */
function restoreLastLogin() {
  const savedAccount = localStorage.getItem('loginAccount')
  if (savedAccount) account.value = savedAccount
  const savedSelect = localStorage.getItem('loginSchoolSelect')
  if (savedSelect && SCHOOLS.some((s) => s.value === savedSelect)) {
    schoolSelect.value = savedSelect
  }
  if (schoolSelect.value === 'other') {
    schoolCode.value = localStorage.getItem('loginSchoolCode') || ''
  }
  rememberPassword.value = !!loadObfuscatedPassword()
}

async function onLogin() {
  loading.value = true
  try {
    const info = await auth.login(
      account.value,
      password.value,
      schoolSelect.value,
      schoolCode.value,
      rememberPassword.value
    )
    if (account.value[0] !== '2') {
      ElMessage.warning('你的账号为非学生账号，功能受限(没适配)，仅可查看随身答和下载应用')
    }
    ElMessage.success(`你好，${info.realName || auth.userName}`)
    router.push('/note')
  } catch (e: any) {
    ElMessage.error(e.message || '登录失败')
  } finally {
    loading.value = false
  }
}

function onLogout() {
  auth.logout()
  ElMessage.info('已注销')
}

onMounted(() => {
  if (auth.isLoggedIn) auth.startRefresh()
  else restoreLastLogin()
})
</script>

<style scoped>
.login-page {
  min-height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
}
.login-card {
  width: 100%;
  max-width: 440px;
}
.card-title {
  font-size: 18px;
  font-weight: 600;
}
.welcome {
  display: flex;
  align-items: center;
  margin-bottom: 16px;
  color: #303133;
}
.mt {
  margin-top: 16px;
}
.school-hint {
  margin-top: 6px;
  font-size: 12px;
  line-height: 1.5;
  color: var(--el-text-color-secondary);
}
</style>
