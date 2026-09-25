/**
 * 云笔记数据变更信号。
 *
 * 背景：`/note`（列表）与 `/note/:fileId`（详情）都标了 `keepAlive`，
 * 从详情页返回列表时组件实例被复用、`onMounted` 不再触发，
 * 而列表又自带「已加载则复用缓存」的优化 —— 结果在详情页把笔记移入回收站后，
 * 返回列表仍显示那条笔记（表现为「删了不消失」）。
 *
 * 这里用一个极轻量的版本号 + 订阅：详情页改动数据后 `bumpNoteDataVersion()`，
 * 列表页在 `onActivated` 里比对版本号，不一致就强制重新拉取。
 * 不用 Pinia、不用 mitt，避免为一个小场景引入额外依赖。
 */

let version = 0
const listeners = new Set<() => void>()

/** 标记云笔记数据已变更（新增/删除/恢复/重命名等写操作后调用） */
export function bumpNoteDataVersion(): void {
  version += 1
  listeners.forEach((fn) => {
    try {
      fn()
    } catch {
      /* 单个订阅者异常不影响其他订阅者 */
    }
  })
}

/** 读取当前版本号 */
export function noteDataVersion(): number {
  return version
}

/** 订阅变更（返回取消订阅函数） */
export function onNoteDataChange(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}
