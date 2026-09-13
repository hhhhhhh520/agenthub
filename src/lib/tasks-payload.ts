/**
 * 任务板载荷形状守卫（ISSUE-002 后续）。
 *
 * 前端轮询 `/api/sessions/[id]/tasks` 期望拿到 Task 数组，
 * 脏数据（{} / [null] / 缺字段）若直接进 setTasks 会在渲染层抛错、
 * 一路冒到 app 级 error 边界导致整页接管。这里只做最小窄化：
 * 数组 + 每项有 string id/status，其余字段放行（向前兼容）。
 */

export interface TaskLike {
  id: string
  status: string
  trace?: unknown
}

export function isTaskList(data: unknown): boolean {
  if (!Array.isArray(data)) return false
  return data.every(
    (t) =>
      !!t &&
      typeof t === 'object' &&
      typeof (t as { id?: unknown }).id === 'string' &&
      typeof (t as { status?: unknown }).status === 'string',
  )
}
