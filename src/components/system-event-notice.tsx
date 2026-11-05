'use client'

import { AlertCircle, AlertTriangle, Info } from 'lucide-react'
import type { SystemEvent, SystemEventSeverity } from '@/lib/system-events'

const SEVERITY_ORDER: Record<SystemEventSeverity, number> = { info: 0, warn: 1, error: 2 }

function highestSeverity(events: SystemEvent[]): SystemEventSeverity {
  return events.reduce<SystemEventSeverity>(
    (max, event) => (SEVERITY_ORDER[event.severity] > SEVERITY_ORDER[max] ? event.severity : max),
    'info',
  )
}

export function SystemEventNotice({
  events,
  onOpen,
}: {
  events: SystemEvent[]
  onOpen: () => void
}) {
  if (events.length === 0) return null

  const severity = highestSeverity(events)
  const latest = events[events.length - 1]
  const hasHistorical = events.some(event => event.historical)
  const Icon = severity === 'error' ? AlertCircle : severity === 'warn' ? AlertTriangle : Info
  const tone = severity === 'error'
    ? 'border-red-200 bg-red-50 text-red-900 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-200'
    : severity === 'warn'
      ? 'border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-200'
      : 'border-gray-200 bg-gray-50 text-gray-700 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-300'
  const iconTone = severity === 'error'
    ? 'text-red-500'
    : severity === 'warn'
      ? 'text-amber-500'
      : 'text-gray-400'

  return (
    <div className="flex gap-2 max-w-[92%] sm:max-w-[86%]">
      <div className={`flex-1 min-w-0 rounded-lg border px-3 py-2 ${tone}`} role="status">
        <div className="flex items-center gap-2 min-w-0">
          <Icon className={`w-3.5 h-3.5 shrink-0 ${iconTone}`} />
          <span className="text-xs font-medium shrink-0">
            {events.length === 1 ? latest.title : `系统事件 · ${events.length} 条`}
          </span>
          {hasHistorical && (
            <span className="shrink-0 rounded bg-background/70 px-1.5 text-xs font-medium" title="该组包含旧规则生成的记录，详情已标注当前规则">
              含历史记录
            </span>
          )}
          {events.length > 1 && (
            <span className="text-xs opacity-70 shrink-0">{latest.title}</span>
          )}
          <span className="text-xs opacity-70 truncate min-w-0" title={latest.summary}>
            {latest.summary}
          </span>
          <button
            type="button"
            onClick={onOpen}
            className="ml-auto shrink-0 text-xs font-medium underline underline-offset-2 hover:opacity-70"
          >
            {events.length > 1 ? '查看全部' : '查看详情'}
          </button>
        </div>
      </div>
    </div>
  )
}
