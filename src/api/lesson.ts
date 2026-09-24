/**
 * 优客畅学（SelfStudy）接口（复刻旧 index.js show_lesson / show_class / show_page）
 * 所有请求自动附带 Authorization: Bearer <token>（见 utils/request）
 */

import { request } from '@/utils/request'
import { unwrapResult } from '@/utils/request'

/** 课程摘要 */
export interface LessonCourse {
  id: number
  title: string
  status: number // 0 = 已下架
  cover: string
  progress: number
  userName: string
  subjectName: string
  [key: string]: any
}

/** 章节节点（树） */
export interface LessonCatalog {
  id: string
  title: string
  isLeaf: boolean
  children?: LessonCatalog[]
  [key: string]: any
}

/**
 * 分页拉取全部在学课程（复刻 show_lesson 的 while 分页）
 *
 * 修复：原实现是 `while(true)`，仅以「返回空数组」作为终止条件。
 * 一旦服务端忽略 page 参数（始终返回第一页）、或分页字段改名导致 list 恒非空，
 * 就会变成**无限请求循环**，页面彻底卡死（打开章节页必现，因为每进一次章节都调它）。
 * 现加三重保险：最大页数、首条 id 去重、空列表终止。
 */
const MAX_COURSE_PAGES = 50

export async function getLearningCourses(): Promise<LessonCourse[]> {
  const all: LessonCourse[] = []
  const seenFirstIds = new Set<string>()
  let page = 1
  while (page <= MAX_COURSE_PAGES) {
    const res = await request<{ data: LessonCourse[] }>(
      `/SelfStudy/api/Learn/LearningCourses?page=${page}`
    )
    const list = res.data || []
    if (list.length === 0) break

    const firstKey = String((list[0] as any)?.id ?? '')
    if (firstKey && seenFirstIds.has(firstKey)) break // 服务端反复返回同一页
    if (firstKey) seenFirstIds.add(firstKey)

    all.push(...list)
    page++
  }
  return all
}

/** 课程章节目录（复刻 show_class） */
export async function getCourseDetail(courseId: number | string): Promise<LessonCatalog[]> {
  const res = await request<{ data: { catalogs: LessonCatalog[] } }>(
    `/SelfStudy/api/Learn/CourseDetail?id=${courseId}`
  )
  return res.data?.catalogs || []
}

/** 读取章节内容（HTML 字符串）复刻 show_page */
export async function readContent(
  catalogId: string,
  courseId: number | string
): Promise<string> {
  const res = await request<{ data: { content: string } }>(
    `/SelfStudy/api/learn/readContent?catalogId=${catalogId}&courseId=${courseId}`
  )
  return res.data?.content || ''
}

/** 兼容 ABP 包装：部分接口 data 在 result 下 */
export { unwrapResult }
