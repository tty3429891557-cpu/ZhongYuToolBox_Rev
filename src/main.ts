import { createApp } from 'vue'
import { createPinia } from 'pinia'
import ElementPlus from 'element-plus'
import 'element-plus/dist/index.css'
import './styles/mobile.css'
import zhCn from 'element-plus/es/locale/lang/zh-cn'
import * as ElementPlusIconsVue from '@element-plus/icons-vue'

import App from './App.vue'
import router from './router'

const app = createApp(App)

/**
 * 全局错误兜底。
 * 原实现没有任何全局处理器：组件里的未捕获异常/未处理的 Promise rejection
 * 只会打进控制台，界面表现为「点了没反应」或白屏，无法定位。
 */
app.config.errorHandler = (err, _instance, info) => {
  console.error('[全局错误]', info, err)
}
window.addEventListener('unhandledrejection', (e) => {
  console.error('[未处理的 Promise 拒绝]', e.reason)
})
window.addEventListener('error', (e) => {
  if (e.message) console.error('[未捕获错误]', e.message, e.filename, e.lineno)
})

for (const [key, component] of Object.entries(ElementPlusIconsVue)) {
  app.component(key, component)
}

app.use(createPinia())
app.use(router)
app.use(ElementPlus, { locale: zhCn })
app.mount('#app')
