export interface TaskTraceLike {
  ts?: string
  event?: string
}

export interface TaskTimingLike {
  createdAt?: string
  trace?: string | null
}

export function parseTaskTrace(trace: string | null | undefined): TaskTraceLike[] {
  if (!trace) return []
  try {
    const parsed: unknown = JSON.parse(trace)
    return Array.isArray(parsed) ? parsed as TaskTraceLike[] : []
  } catch {
    return []
  }
}

export function getLastTraceEvent(trace: string | null | undefined): string | null {
  const entries = parseTaskTrace(trace)
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i]?.event) return entries[i].event ?? null
  }
  return null
}

/** 任务真实开始时间：取最后一次 start trace；没有 trace 时回退到 createdAt。 */
export function getTaskStartedAt(task: TaskTimingLike): string | null {
  const entries = parseTaskTrace(task.trace)
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]
    if (entry?.event !== 'start' || !entry.ts) continue
    if (Number.isFinite(new Date(entry.ts).getTime())) return entry.ts
  }
  if (task.createdAt && Number.isFinite(new Date(task.createdAt).getTime())) return task.createdAt
  return null
}
