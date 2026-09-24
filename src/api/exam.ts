/**
 * 新测评模块接口层（复刻旧项目 index.js 测评相关函数）
 * 接口基地址：API_BASE_URL
 */
import { request, unwrapResult } from '@/utils/request'
import { API_BASE_URL } from '@/config'
import { safeHtml } from '@/utils/sanitize'

const PAGE_SIZE = 20

/** 测评任务列表项 */
export interface ExamTask {
  examId?: number
  testPagerId?: number
  id?: number
  examTaskId?: number
  examName?: string
  examState?: number
  [key: string]: any
}

/** 分页拉取学生测评任务列表（复刻 fetchExams） */
export async function getExamTasks(page: number): Promise<{ items: ExamTask[]; totalCount: number }> {
  const skipCount = (page - 1) * PAGE_SIZE
  const resp = await request<any>('/api/services/app/Task/GetStudentTaskListAsync', {
    method: 'POST',
    body: JSON.stringify({
      maxResultCount: PAGE_SIZE,
      skipCount,
      taskListType: 0
    })
  })
  const result = unwrapResult<any>(resp)
  return {
    items: result.items || [],
    totalCount: result.totalCount || 0
  }
}

/** 测评任务详情（含题目分组）（复刻 fetchExamTask） */
export async function getExamTask(examId: number): Promise<any> {
  const resp = await request<any>(`/api/services/app/Task/GetExamTaskAsync?id=${examId}`)
  return unwrapResult<any>(resp)
}

/**
 * 当前学校 API 基地址。
 * 修复：原实现用的是 config 里「模块加载时」固化的 `API_BASE_URL` 常量。
 * 登录到非默认学校后 localStorage 里的 apiBaseUrl 已变，而该常量仍是默认学校，
 * 导致单题 HTML 请求打到错误学校 → 404 / 取到别人的题。
 */
function currentApiBase(): string {
  return localStorage.getItem('apiBaseUrl') || API_BASE_URL
}

/** 单题 HTML（含解析）（复刻 fetchQstAnswerView） */
export async function getQstAnswerView(qstId: number): Promise<string> {
  if (!Number.isFinite(qstId)) throw new Error('题目 ID 无效')
  const resp = await request<Response>(
    `${currentApiBase()}/Question/View/${qstId}?showAnalysis=true`,
    { raw: true }
  )
  // raw 模式下 request 返回原始 Response，需自行读取文本
  if (resp instanceof Response) {
    return await resp.text()
  }
  return String(resp)
}

/** 考试概览（复刻 fetchExamOverview） */
export async function getExamOverview(examId: number): Promise<any> {
  const resp = await request<any>(
    `/api/services/app/LearningSituations/GetExamOverviewAsync?examId=${examId}`,
    {
      headers: {
        AppName: 'WebClient',
        AppVersion: '0'
      }
    }
  )
  return unwrapResult<any>(resp)
}

/** 题目分析（复刻 fetchQuestionAnalysis） */
export async function getQuestionAnalysis(examId: number): Promise<any> {
  const resp = await request<any>(
    `/api/services/app/LearningSituations/GetQuestionAnalysisAsync?examId=${examId}`,
    {
      headers: {
        AppName: 'WebClient',
        AppVersion: '0'
      }
    }
  )
  return unwrapResult<any>(resp)
}

/** 导出客观题答案 xlsx（复刻 exportObjectiveAnswers），返回 Blob */
export async function exportObjectiveAnswers(examId: number): Promise<Blob> {
  const resp = await request<Response>(
    `/api/services/app/Exam/ExportObjectiveAnswersAsync?examId=${examId}`,
    {
      headers: {
        AppName: 'WebClient',
        AppVersion: '0'
      },
      raw: true
    }
  )
  return await (resp as Response).blob()
}

/** 解析单题 HTML，提取题干/答案/解析/知识点（复刻 showExamQuestions 内解析） */
export interface ParsedQuestion {
  number: number
  stem: string
  answer: string
  explanation: string
  knowledge: string
}

export async function parseExamQuestions(
  exam: any,
  getHtml: (qstId: number) => Promise<string>
): Promise<ParsedQuestion[]> {
  const questions: ParsedQuestion[] = []
  // getExamTask 已 unwrapResult，传入的是 resp.result（含 groups）；兼容仍带 .result 的写法
  const groups = exam?.groups || exam?.result?.groups || []

  // 先按出现顺序摊平题目，保证 number 与答题顺序一致
  type Slot = { q: any; number: number }
  const slots: Slot[] = []
  let idx = 1
  for (const group of groups) {
    for (const q of group.questions || []) {
      slots.push({ q, number: idx })
      idx++
    }
  }

  /**
   * 并发拉取（限流 6）。
   * 修复：原实现是**串行** await，一场 60 题的考试就是 60 次往返，
   * 学校服务器慢的时候界面会长时间停在 loading，表现为「点开试题就卡死」。
   */
  const CONCURRENCY = 6
  const results: ParsedQuestion[] = new Array(slots.length)
  let cursor = 0
  async function worker() {
    for (;;) {
      const i = cursor++
      if (i >= slots.length) return
      const { q, number } = slots[i]
      let content = ''
      try {
        content = await getHtml(q.id)
      } catch {
        content = ''
      }
      const parser = new DOMParser()
      const doc = parser.parseFromString(content, 'text/html')
      doc.querySelectorAll('.toolBar').forEach((el) => el.remove())

      // 题干/答案/解析来自服务端 HTML，最终会走 v-html 渲染 —— 必须先净化，
      // 否则 <img onerror=...> 这类内联事件会被浏览器直接执行（XSS）
      const stem = safeHtml(doc.querySelector('.stem')?.innerHTML || '')

      let answer = ''
      const answerEl = doc.querySelector('.answers')
      if (answerEl) {
        answerEl.querySelectorAll('h3').forEach((h) => h.remove())
        answer = safeHtml(answerEl.innerHTML.trim())
      }

      let explanation = ''
      let knowledge = ''
      const analysisEls = doc.querySelectorAll('.analysis')
      if (analysisEls.length > 0) {
        const first = analysisEls[0]
        first.querySelectorAll('h3').forEach((h) => h.remove())
        explanation = safeHtml(first.innerHTML.trim())
        if (analysisEls[1]) {
          const second = analysisEls[1]
          second.querySelectorAll('h3').forEach((h) => h.remove())
          knowledge = safeHtml(second.innerHTML.trim())
        }
      }

      results[i] = { number, stem, answer, explanation, knowledge }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, slots.length) }, worker))

  // 过滤掉拉取失败的空位（原实现会把失败页当题干塞进去）
  return results.filter((r) => r && (r.stem || r.answer || r.explanation || r.knowledge))
}

export { PAGE_SIZE }
