/**
 * 任务板轮询状态机（ISSUE-002 后续：定时器/abort 生命周期的可测抽离）。
 *
 * 与 `agent-panel.tsx` 内联 effect 逐行同语义，只是把 React 换成回调注入，
 * 以便在 node 单测里用 fake timers 钉住 9 处接线逻辑：
 * 定时调度 / 失败计数 / 空闲降频 / redo 快档 / 脏载荷按失败记 / 卸载刹车。
 * 正常路径行为与原内联版完全一致（含 redo 切换时重建循环、清空任务板）。
 */

import { computePollInterval } from './poll-interval'
import { isTaskList } from './tasks-payload'

export interface TaskSnapshot {
  id: string
  status: string
  trace?: string
}

export interface TaskPollerDeps {
  fetchTasks: (signal: AbortSignal) => Promise<unknown>
  setTasks: (updater: (prev: TaskSnapshot[]) => TaskSnapshot[]) => void
  setLoading: (loading: boolean) => void
  redoFast: boolean
}

export interface TaskPoller {
  stop: () => void
}

export function createTaskPoller({ fetchTasks, setTasks, setLoading, redoFast }: TaskPollerDeps): TaskPoller {
  let errorCount = 0
  let firstFetch = true
  let changedSinceLastPoll = true // 首轮按活跃节奏
  let lastSig: string | null = null // 哨兵：首轮必视为有变化，空板不提前降频
  let timer: ReturnType<typeof setTimeout> | undefined
  const controller = new AbortController()
  const schedule = () => {
    timer = setTimeout(run, computePollInterval({ errorCount, changedSinceLastPoll, redoFast }))
  }
  const run = () => {
    fetchTasks(controller.signal)
      .then((data) => {
        if (!isTaskList(data)) throw new Error('tasks payload bad-shape')
        const list = data as TaskSnapshot[]
        setTasks((prev) => {
          if (list.length !== prev.length) return list
          const changed = list.some((t, i) => t.status !== prev[i].status || t.trace !== prev[i].trace)
          return changed ? list : prev
        })
        // 节奏判定用的轻量签名（id+status+trace长度），与渲染层 diff 解耦
        const sig = list.map((t) => `${t.id}:${t.status}:${t.trace?.length ?? 0}`).join('|')
        changedSinceLastPoll = sig !== lastSig
        lastSig = sig
        errorCount = 0
        if (firstFetch) {
          setLoading(false)
          firstFetch = false
        }
      })
      .catch((err) => {
        if (err?.name === 'AbortError') return
        errorCount++
        if (firstFetch) {
          setLoading(false)
          firstFetch = false
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) schedule() // 失败≥阈值转低频探测，成功一次即恢复，不永久停摆
      })
  }
  setLoading(true)
  setTasks(() => [])
  run()
  return {
    stop: () => {
      clearTimeout(timer)
      controller.abort()
    },
  }
}
