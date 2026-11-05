import { stripProtocolMarkers } from './message-parser'

export const SYSTEM_TASK_PREFIX = '[系统验证任务]'

export interface TaskBoardTask {
  id: string
  description: string
  status: string
  assignedAgentId?: string | null
  dependencies?: string | null
  declaredFiles?: string | null
  trace?: string | null
  createdAt?: string
  updatedAt?: string
}

export interface TaskBatch<T> {
  batch: number
  tasks: T[]
}

export interface TaskBoardCounts {
  total: number
  done: number
  running: number
  pending: number
  failed: number
  blocked: number
  system: number
}

export function isSystemTask(description: string): boolean {
  return description.trimStart().startsWith(SYSTEM_TASK_PREFIX)
}

export function parseTaskDependencies(raw: string | null | undefined): string[] {
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((dep): dep is string => typeof dep === 'string')
  } catch {
    return []
  }
}

export function parseDeclaredFiles(raw: string | null | undefined): string[] {
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((file): file is string => typeof file === 'string')
  } catch {
    return []
  }
}

/** 任务卡标题：去协议标记、压平换行、截断；不把整段 prompt 塞进标题。 */
export function taskDisplayTitle(description: string, max = 88): string {
  const raw = stripProtocolMarkers(description).replace(/\s+/g, ' ').trim()
  if (!raw) return '未命名任务'
  if (raw.length <= max) return raw
  return `${raw.slice(0, max - 1)}…`
}

/** 系统校验任务不展示整段验证 prompt，只显示它能覆盖几项产出。 */
export function systemTaskTitle(description: string): string {
  const items = (description.match(/^-\s+/gm) || []).length
  return items > 0 ? `产出物验证 · ${items} 项` : '产出物验证'
}

/**
 * 按依赖推导批次；缺依赖/环依赖都 fail-open 到 batch 0，不阻塞任务板渲染。
 * 与 execution/scheduler 的拓扑分批语义一致：无依赖同批，有依赖等上游。
 */
export function deriveTaskBatches<T extends TaskBoardTask>(tasks: T[]): TaskBatch<T>[] {
  const byId = new Map(tasks.map(task => [task.id, task]))
  const memo = new Map<string, number>()
  const visiting = new Set<string>()

  const batchOf = (id: string): number => {
    const cached = memo.get(id)
    if (cached !== undefined) return cached
    if (visiting.has(id)) return 0

    const task = byId.get(id)
    if (!task) return 0

    visiting.add(id)
    const deps = parseTaskDependencies(task.dependencies).filter(dep => byId.has(dep))
    const batch = deps.length > 0 ? Math.max(...deps.map(batchOf)) + 1 : 0
    visiting.delete(id)
    memo.set(id, batch)
    return batch
  }

  const groups = new Map<number, T[]>()
  for (const task of tasks) {
    const batch = batchOf(task.id)
    const group = groups.get(batch) || []
    group.push(task)
    groups.set(batch, group)
  }

  return [...groups.entries()]
    .sort(([a], [b]) => a - b)
    .map(([batch, batchTasks]) => ({ batch, tasks: batchTasks }))
}

export function splitTaskBoard<T extends TaskBoardTask>(tasks: T[]): {
  batches: TaskBatch<T>[]
  systemTasks: T[]
} {
  return {
    batches: deriveTaskBatches(tasks.filter(task => !isSystemTask(task.description))),
    systemTasks: tasks.filter(task => isSystemTask(task.description)),
  }
}

function countStatuses(tasks: TaskBoardTask[]) {
  return {
    total: tasks.length,
    done: tasks.filter(task => task.status === 'completed').length,
    running: tasks.filter(task => task.status === 'in_progress').length,
    pending: tasks.filter(task => task.status === 'pending').length,
    failed: tasks.filter(task => task.status === 'failed').length,
    blocked: tasks.filter(task => task.status === 'blocked').length,
  }
}

export function summarizeTasks(tasks: TaskBoardTask[]) {
  return countStatuses(tasks)
}

/** 主进度只统计用户任务；系统校验单独一组，不稀释 3/3。 */
export function summarizeTaskBoard(tasks: TaskBoardTask[]): TaskBoardCounts {
  const userTasks = tasks.filter(task => !isSystemTask(task.description))
  return {
    ...countStatuses(userTasks),
    system: tasks.length - userTasks.length,
  }
}
