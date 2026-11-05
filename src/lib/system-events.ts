import { stripProtocolMarkers } from './message-parser'

export type SystemEventKind =
  | 'audit'
  | 'schema'
  | 'correction'
  | 'replan'
  | 'timeout'
  | 'error'
  | 'info'

export type SystemEventSeverity = 'info' | 'warn' | 'error'

export interface SystemEvent {
  id: string
  source: 'message' | 'task'
  ts: string
  kind: SystemEventKind
  severity: SystemEventSeverity
  title: string
  summary: string
  detail: string
  raw: string
  agent?: string
  taskId?: string
  /** 旧规则下生成、展示时已改写为当前规则的记录。raw 仍保留原文。 */
  historical?: boolean
}

export interface SystemMessageLike {
  id: string
  role: string
  rawContent: string
  createdAt: string
  agentId?: string | null
  taskId?: string | null
}

export interface TaskTraceLike {
  id: string
  trace?: string | null
  createdAt?: string
  updatedAt?: string
}

export const SYSTEM_EVENT_KIND_LABELS: Record<SystemEventKind, string> = {
  audit: '边界审计',
  schema: '产物校验',
  correction: '执行纠偏',
  replan: '任务拆解',
  timeout: '超时',
  error: '错误',
  info: '提示',
}

export const SYSTEM_EVENT_SEVERITY_LABELS: Record<SystemEventSeverity, string> = {
  info: '提示',
  warn: '警告',
  error: '错误',
}

interface ClassifyRule {
  test: (raw: string, clean: string) => boolean
  kind: SystemEventKind
  severity: SystemEventSeverity
  title: string
}

/**
 * 只识别「编排层自己产生的系统事件」；普通完成报告、讨论摘要、Agent 长文不在此列。
 * 顺序有讲究：REPLAN-EXHAUSTED 必须先于 REPLAN。
 */
const CLASSIFY_RULES: ClassifyRule[] = [
  {
    test: raw => raw.startsWith('[REPLAN-EXHAUSTED]'),
    kind: 'replan', severity: 'error', title: '任务拆解硬停',
  },
  {
    test: raw => raw.startsWith('[REPLAN]'),
    kind: 'replan', severity: 'warn', title: '任务拆解失败',
  },
  {
    test: (_raw, clean) => clean.startsWith('[审计不可用]'),
    kind: 'audit', severity: 'error', title: '审计不可用',
  },
  {
    test: (_raw, clean) => clean.startsWith('[敏感路径越界]'),
    kind: 'audit', severity: 'error', title: '敏感路径越界',
  },
  {
    test: (_raw, clean) => clean.startsWith('[越界警告]'),
    kind: 'audit', severity: 'warn', title: '文件边界告警',
  },
  {
    test: (_raw, clean) => clean.startsWith('[schema 警告]'),
    kind: 'schema', severity: 'warn', title: '产物校验告警',
  },
  {
    test: (_raw, clean) => clean.startsWith('Orchestrator 纠偏'),
    kind: 'correction', severity: 'warn', title: '执行纠偏',
  },
  {
    test: (_raw, clean) => clean.startsWith('执行阶段超时'),
    kind: 'timeout', severity: 'error', title: '执行超时',
  },
  {
    test: (_raw, clean) => clean.startsWith('没有待执行的任务'),
    kind: 'error', severity: 'error', title: '执行失败',
  },
  {
    test: (_raw, clean) => /^任务 .+ 失败:/.test(clean),
    kind: 'error', severity: 'error', title: '任务执行失败',
  },
  {
    test: (_raw, clean) => clean.startsWith('任务 ') && clean.includes('纠偏失败'),
    kind: 'correction', severity: 'error', title: '纠偏熔断',
  },
  {
    test: (_raw, clean) => clean.startsWith('执行循环迭代超限'),
    kind: 'error', severity: 'error', title: '执行循环超限',
  },
]

const TRACE_RULES: Record<string, { kind: SystemEventKind; severity: SystemEventSeverity; title: string }> = {
  error: { kind: 'error', severity: 'error', title: '任务执行错误' },
  retry: { kind: 'info', severity: 'info', title: '自动重试' },
  correction: { kind: 'correction', severity: 'warn', title: '执行纠偏' },
  monitor: { kind: 'correction', severity: 'warn', title: '结构化监控' },
  preflight: { kind: 'info', severity: 'info', title: 'Preflight 检查' },
  blocked: { kind: 'error', severity: 'error', title: '任务阻塞' },
  audit_unavailable: { kind: 'audit', severity: 'error', title: '审计不可用' },
}

function summarize(text: string, max = 140): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, max)
}

/**
 * 展示用正文去掉内部标签；原始标签仍保留在 raw 里供抽屉展开。
 * 例：`[越界警告] 本批...` → `本批...`；`Orchestrator 纠偏：...` → `...`。
 */
function displayDetail(clean: string): string {
  const withoutLabel = clean
    .replace(/\[(?:越界警告|敏感路径越界|审计不可用|schema\s*警告)\]/g, ' ')
    .replace(/^Orchestrator 纠偏[：:]\s*/, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
  return withoutLabel || clean
}

/**
 * U12：旧版本系统提示的展示层改写。
 *
 * 数据库 rawContent 不动（审计/回放依赖原文），只在渲染时把已经过时的规则说明
 * 标成「历史记录，规则已更新」，并补上当前规则，避免用户按旧文案理解当前行为。
 */
export function rewriteHistoricalSystemCopy(text: string): { text: string; historical: boolean } {
  if (!text.includes('已自动清理')) return { text, historical: false }

  const base = text
    .replace(/[，,]?\s*已自动清理[。.]?/g, '')
    .replace(/[，,。.\s]+$/, '')
    .trim()

  return {
    text: `${base}${base ? '。' : ''}历史记录，规则已更新：当时提示会自动清理，当前规则为「共享项目目录不自动删除，请人工确认」。`,
    historical: true,
  }
}

export function classifySystemMessage(message: SystemMessageLike): SystemEvent | null {
  if (message.role !== 'orchestrator') return null

  const raw = (message.rawContent || '').trim()
  if (!raw) return null

  const clean = stripProtocolMarkers(raw).trim()
  const rule = CLASSIFY_RULES.find(r => r.test(raw, clean))
  if (!rule) return null

  const detail = rewriteHistoricalSystemCopy(displayDetail(clean || raw))
  return {
    id: message.id,
    source: 'message',
    ts: message.createdAt,
    kind: rule.kind,
    severity: rule.severity,
    title: rule.title,
    summary: summarize(detail.text),
    detail: detail.text,
    raw: message.rawContent,
    agent: message.agentId || 'Orchestrator',
    taskId: message.taskId || undefined,
    historical: detail.historical || undefined,
  }
}

function normalizeForDedupe(text: string): string {
  return text.replace(/\s+/g, '').slice(0, 240)
}

function taskTraceEvents(task: TaskTraceLike, existing: SystemEvent[]): SystemEvent[] {
  if (!task.trace) return []

  let entries: Array<Record<string, unknown>>
  try {
    const parsed: unknown = JSON.parse(task.trace)
    if (!Array.isArray(parsed)) return []
    entries = parsed.filter((e): e is Record<string, unknown> => !!e && typeof e === 'object')
  } catch {
    return []
  }

  const out: SystemEvent[] = []
  const seen = new Set(existing.map(e => normalizeForDedupe(e.detail)))

  entries.forEach((entry, index) => {
    const event = String(entry.event || '')
    const rule = TRACE_RULES[event]
    if (!rule) return

    const message = typeof entry.message === 'string' ? entry.message.trim() : ''
    const attempt = typeof entry.attempt === 'number' ? ` #${entry.attempt}` : ''
    const duration = typeof entry.duration_ms === 'number' ? ` (${entry.duration_ms}ms)` : ''
    const detail = rewriteHistoricalSystemCopy(displayDetail(message || `${rule.title}${attempt}${duration}`))
    const normalized = normalizeForDedupe(detail.text)

    // 同一件事通常既写 Message 又写 Task.trace；抽屉里只保留一份。
    if (seen.has(normalized)) return
    seen.add(normalized)

    out.push({
      id: `task-${task.id}-${index}`,
      source: 'task',
      ts: (typeof entry.ts === 'string' && entry.ts) || task.updatedAt || task.createdAt || new Date(0).toISOString(),
      kind: rule.kind,
      severity: rule.severity,
      title: rule.title,
      summary: summarize(detail.text),
      detail: detail.text,
      raw: JSON.stringify(entry, null, 2),
      agent: typeof entry.agent === 'string' ? entry.agent : undefined,
      taskId: task.id,
      historical: detail.historical || undefined,
    })
  })

  return out
}

/**
 * 汇总「消息里的系统告警」+「任务轨迹里的异常事件」，按时间升序。
 * 任务轨迹只取异常/重试/纠偏/监控，不把 start/success 全塞进来。
 */
export function collectSystemEvents(
  messages: SystemMessageLike[],
  tasks: TaskTraceLike[] = [],
): SystemEvent[] {
  const events = messages
    .map(classifySystemMessage)
    .filter((e): e is SystemEvent => e !== null)

  for (const task of tasks) {
    events.push(...taskTraceEvents(task, events))
  }

  return events.sort((a, b) => {
    const at = new Date(a.ts).getTime()
    const bt = new Date(b.ts).getTime()
    return (Number.isFinite(at) ? at : 0) - (Number.isFinite(bt) ? bt : 0)
  })
}

export type ChatItem<T> =
  | { type: 'message'; message: T }
  | { type: 'system'; events: SystemEvent[] }

/**
 * 把连续的系统事件合并成一行，避免 4 条警告各占一个大气泡。
 * 事件与正常消息交错时按原顺序分组，不改变对话时间线。
 */
export function groupMessagesForChat<T extends SystemMessageLike>(messages: T[]): ChatItem<T>[] {
  const items: ChatItem<T>[] = []
  let pending: SystemEvent[] = []

  const flush = () => {
    if (pending.length === 0) return
    items.push({ type: 'system', events: pending })
    pending = []
  }

  for (const message of messages) {
    const event = classifySystemMessage(message)
    if (event) {
      pending.push(event)
    } else {
      flush()
      items.push({ type: 'message', message })
    }
  }
  flush()

  return items
}
