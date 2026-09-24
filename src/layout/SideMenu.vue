<template>
  <el-menu
    :default-active="activeIndex"
    class="side-menu"
    :collapse="collapse"
    :collapse-transition="false"
    @select="onSelect"
    background-color="#1f2937"
    text-color="#cbd5e1"
    active-text-color="#ffffff"
  >
    <!--
      修复：原先同时绑定了 el-menu 的 @select 和 el-menu-item 的 @click，
      一次点击会触发两次 router.push —— 第二次是重复导航，vue-router 返回
      rejected promise（Avoided redundant navigation），控制台报未处理的 rejection，
      且 emit('select') 也发了两遍。改为只保留 @select。
    -->
    <el-menu-item v-for="item in items" :key="item.index" :index="item.index">
      <el-icon><component :is="item.icon" /></el-icon>
      <template #title>{{ item.title }}</template>
    </el-menu-item>
  </el-menu>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { MENU_ITEMS } from './menuItems'

const props = defineProps<{ collapse: boolean }>()
const emit = defineEmits<{ (e: 'select'): void }>()
const router = useRouter()
const route = useRoute()

const items = MENU_ITEMS
const activeIndex = computed(() => route.path)

function onSelect(index: string) {
  // 已在该页面时不再 push，避免 vue-router 抛「重复导航」的 rejection
  if (route.path !== index) {
    router.push(index)
  }
  emit('select')
}
void props
</script>

<style scoped>
.side-menu {
  border-right: none;
  height: 100%;
  width: 100%;
  scrollbar-width: none;
}
.side-menu::-webkit-scrollbar {
  display: none;
}
.side-menu {
  -ms-overflow-style: none;
}
</style>
