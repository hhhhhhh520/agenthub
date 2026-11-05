'use client'

import { AlertCircle, AlertTriangle, Info } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { ScrollArea } from '@/components/ui/scroll-area'
import { EmptyState } from '@/components/empty-state'
import {
  SYSTEM_EVENT_KIND_LABELS,
  SYSTEM_EVENT_SEVERITY_LABELS,
  type SystemEvent,
  type SystemEventSeverity,
} from '@/lib/system-events'

function formatTime(ts: string): string {
  const date = new Date(ts)
  if (!Number.isFinite(date.getTime())) return ts || '—'
  return date.toLocaleString('zh-CN', {
    hour12: false,
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

const SEVERITY_TONE: Record<SystemEventSeverity, string> = {
  error: 'text-red-600 dark:text-red-400',
  warn: 'text-amber-600 dark:text-amber-400',
  info: 'text-gray-500 dark:text-gray-400',
}

function SeverityIcon({ severity }: { severity: SystemEventSeverity }) {
  if (severity === 'error') return <AlertCircle className="w-4 h-4 text-red-500 shrink-0" />
  if (severity === 'warn') return <AlertTriangle className="w-4 h-4 text-amber-500 shrink-0" />
  return <Info className="w-4 h-4 text-gray-400 shrink-0" />
}

function EventCard({ event }: { event: SystemEvent }) {
  return (
    <div className="rounded-lg border bg-card p-3 space-y-1.5">
      <div className="flex items-center gap-2 flex-wrap text-xs text-muted-foreground">
        <SeverityIcon severity={event.severity} />
        {event.kind !== 'error' && event.kind !== 'info' && (
          <Badge variant="outline" className="text-xs px-1.5">
            {SYSTEM_EVENT_KIND_LABELS[event.kind]}
          </Badge>
        )}
        {event.historical && (
          <Badge variant="outline" className="text-xs px-1.5 border-amber-300 text-amber-700">
            历史记录 · 规则已更新
          </Badge>
        )}
        <span className={SEVERITY_TONE[event.severity]}>
          {SYSTEM_EVENT_SEVERITY_LABELS[event.severity]}
        </span>
        <span>{formatTime(event.ts)}</span>
        {event.agent && <span>{event.agent}</span>}
        {event.taskId && (
          <span className="font-mono" title={event.taskId}>
            任务 {event.taskId.slice(0, 8)}
          </span>
        )}
      </div>

      <div className="text-sm font-medium">{event.title}</div>
      <div className="text-xs text-muted-foreground whitespace-pre-wrap break-words">
        {event.detail}
      </div>

      <details className="text-xs">
        <summary className="cursor-pointer text-muted-foreground select-none">原始内容</summary>
        <pre className="mt-1 max-h-48 overflow-auto rounded bg-muted p-2 whitespace-pre-wrap break-words">
          {event.raw}
        </pre>
      </details>
    </div>
  )
}

export function SystemEventDrawer({
  open,
  onOpenChange,
  events,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  events: SystemEvent[]
}) {
  const sorted = [...events].sort((a, b) => {
    const at = new Date(a.ts).getTime()
    const bt = new Date(b.ts).getTime()
    return (Number.isFinite(bt) ? bt : 0) - (Number.isFinite(at) ? at : 0)
  })
  const errors = events.filter(e => e.severity === 'error').length
  const warnings = events.filter(e => e.severity === 'warn').length

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full sm:max-w-xl p-0 gap-0">
        <SheetHeader className="border-b pr-10">
          <SheetTitle>系统事件</SheetTitle>
          <SheetDescription>
            编排层产生的告警、审计、校验与纠偏；不阻塞主对话。
          </SheetDescription>
          <div className="text-xs text-muted-foreground pt-1">
            共 {events.length} 条
            {errors > 0 && <span className="text-red-500"> · 错误 {errors}</span>}
            {warnings > 0 && <span className="text-amber-600"> · 警告 {warnings}</span>}
          </div>
        </SheetHeader>

        <ScrollArea className="flex-1 min-h-0">
          <div className="p-4 space-y-3">
            {sorted.length === 0 ? (
              <EmptyState compact title="暂无系统事件" description="运行任务后，告警、审计和校验记录会显示在这里。" />
            ) : (
              sorted.map(event => <EventCard key={`${event.source}-${event.id}`} event={event} />)
            )}
          </div>
        </ScrollArea>
      </SheetContent>
    </Sheet>
  )
}
