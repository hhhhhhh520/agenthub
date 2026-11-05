'use client'

import { Download } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

export interface TraceEntry {
  ts?: string
  event?: string
  message?: string
  agent?: string
  attempt?: number
  duration_ms?: number
}

export const MAX_TRACE_ENTRIES = 120

function formatTime(ts?: string): string {
  if (!ts) return ''
  const date = new Date(ts)
  if (!Number.isFinite(date.getTime())) return ts
  return date.toLocaleTimeString('zh-CN', { hour12: false })
}

export function formatTraceEntry(entry: TraceEntry): string {
  const time = formatTime(entry.ts)
  const prefix = time ? `[${time}] ` : ''
  const who = entry.agent ? `[${entry.agent}] ` : ''
  const meta = [
    typeof entry.attempt === 'number' ? `#${entry.attempt}` : '',
    typeof entry.duration_ms === 'number' ? `${entry.duration_ms}ms` : '',
  ].filter(Boolean).join(' ')
  const suffix = meta ? ` ${meta}` : ''
  const message = entry.message || ''

  switch (entry.event) {
    case 'start': return `${prefix}▶ ${who}开始执行`
    case 'success': return `${prefix}✓ ${who}完成${suffix}`
    case 'error': return `${prefix}✗ ${who}失败: ${message || '未知错误'}`
    case 'retry': return `${prefix}↻ ${who}重试${suffix}: ${message}`
    case 'correction': return `${prefix}↻ ${who}纠偏${suffix}: ${message}`
    case 'blocked': return `${prefix}⏸ ${who}阻塞: ${message}`
    case 'monitor': return `${prefix}🔍 ${who}监控: ${message}`
    case 'preflight': return `${prefix}🚦 ${who}预检: ${message}`
    case 'audit_unavailable': return `${prefix}⚠ ${who}审计不可用: ${message}`
    default: return `${prefix}${who}${entry.event || 'event'}: ${message}`
  }
}

export function TaskTraceDialog({
  open,
  onOpenChange,
  taskId,
  title,
  entries,
  raw,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  taskId?: string
  title?: string
  entries: TraceEntry[]
  raw?: string
}) {
  const visible = entries.slice(0, MAX_TRACE_ENTRIES)

  const handleDownload = () => {
    const content = raw || JSON.stringify(entries, null, 2)
    const blob = new Blob([content], { type: 'application/json;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `task-${(taskId || 'trace').slice(0, 8)}-trace.json`
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
    setTimeout(() => URL.revokeObjectURL(url), 0)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>任务轨迹</DialogTitle>
          <DialogDescription>
            <span className="block truncate" title={title}>{title || '未命名任务'}</span>
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span>{entries.length} 条事件</span>
          <Button variant="outline" size="xs" onClick={handleDownload} disabled={entries.length === 0}>
            <Download className="w-3 h-3 mr-1" />
            下载 JSON
          </Button>
        </div>

        <div className="max-h-[55vh] overflow-auto rounded border bg-muted/40 p-3 font-mono text-xs leading-relaxed">
          {entries.length === 0 ? (
            <div className="text-muted-foreground">暂无轨迹</div>
          ) : (
            <div className="space-y-1">
              {visible.map((entry, index) => (
                <div key={index} className="whitespace-pre-wrap break-words">
                  {formatTraceEntry(entry)}
                </div>
              ))}
              {entries.length > MAX_TRACE_ENTRIES && (
                <div className="pt-2 text-amber-600 dark:text-amber-400">
                  仅显示前 {MAX_TRACE_ENTRIES} 条，完整轨迹请下载 JSON（共 {entries.length} 条）
                </div>
              )}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>关闭</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
