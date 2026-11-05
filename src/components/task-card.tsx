'use client'

import { useEffect, useState } from 'react'
import { ChevronDown, ChevronUp } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import {
  isSystemTask,
  parseDeclaredFiles,
  parseTaskDependencies,
  systemTaskTitle,
  taskDisplayTitle,
  type TaskBoardTask,
} from '@/lib/task-board'
import { formatElapsed } from '@/lib/elapsed'
import { getTaskStartedAt } from '@/lib/task-timing'
import { stripProtocolMarkers } from '@/lib/message-parser'

const TASK_STATUS_ICONS: Record<string, string> = {
  pending: '⬜',
  in_progress: '🔄',
  completed: '✅',
  failed: '❌',
  blocked: '⏸',
}

const TASK_STATUS_LABELS: Record<string, string> = {
  pending: '待执行',
  in_progress: '执行中',
  completed: '已完成',
  failed: '失败',
  blocked: '阻塞',
}

const STATUS_TONE: Record<string, string> = {
  pending: 'text-gray-400',
  in_progress: 'text-blue-500',
  completed: 'text-emerald-600',
  failed: 'text-red-500',
  blocked: 'text-amber-600',
}

function shortId(id: string): string {
  return id.slice(0, 8)
}

function TaskDuration({ task }: { task: TaskBoardTask }) {
  const live = task.status === 'in_progress'
  const start = getTaskStartedAt(task)
  const [now, setNow] = useState<number | null>(null)

  useEffect(() => {
    if (!live || !start) {
      setNow(null)
      return
    }
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [live, start])

  if (task.status === 'pending' || !start) return null
  const startMs = new Date(start).getTime()
  if (!Number.isFinite(startMs)) return null

  const endMs = live ? (now ?? startMs) : new Date(task.updatedAt || '').getTime()
  if (!Number.isFinite(endMs)) return null

  return (
    <span title={`开始于 ${new Date(start).toLocaleString('zh-CN')}`}>
      {live ? '已运行' : '耗时'} {formatElapsed(startMs, endMs)}
    </span>
  )
}

export interface TaskCardProps {
  task: TaskBoardTask
  agentName?: string
  traceCount: number
  expanded: boolean
  onToggle: () => void
  onOpenTrace: () => void
  onRedo?: () => void
}

export function TaskCard({
  task,
  agentName,
  traceCount,
  expanded,
  onToggle,
  onOpenTrace,
  onRedo,
}: TaskCardProps) {
  const system = isSystemTask(task.description)
  const title = system ? systemTaskTitle(task.description) : taskDisplayTitle(task.description)
  const files = parseDeclaredFiles(task.declaredFiles)
  const deps = parseTaskDependencies(task.dependencies)
  const canRedo = !system && (task.status === 'failed' || task.status === 'blocked') && !!onRedo

  return (
    <div
      className={
        system
          ? 'rounded-md border border-dashed bg-gray-50/70 dark:bg-gray-900/40 dark:border-gray-700 text-sm'
          : 'rounded-md border bg-white dark:bg-gray-800 dark:border-gray-700 text-sm'
      }
    >
      <div className="flex items-start gap-2 p-2">
        <span className="mt-0.5 shrink-0">{TASK_STATUS_ICONS[task.status] || task.status}</span>

        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          className="min-w-0 flex-1 text-left"
        >
          <span className="flex items-start gap-1.5">
            <span className="line-clamp-2 flex-1 leading-snug" title={title}>{title}</span>
            {system && (
              <Badge variant="secondary" className="text-xs px-1.5 shrink-0">
                系统校验
              </Badge>
            )}
          </span>
          <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-gray-400">
            <span className={STATUS_TONE[task.status] || 'text-gray-400'}>
              {TASK_STATUS_LABELS[task.status] || task.status}
            </span>
            {agentName && <span>{agentName}</span>}
            <TaskDuration task={task} />
            {files.length > 0 && <span>{files.length} 个文件</span>}
            {deps.length > 0 && <span>依赖 {deps.length}</span>}
          </span>
        </button>

        <div className="flex items-center gap-1.5 shrink-0">
          {traceCount > 0 && (
            <button
              type="button"
              onClick={onOpenTrace}
              className="text-xs text-gray-400 hover:text-gray-600 dark:hover:text-gray-200"
            >
              轨迹 {traceCount}
            </button>
          )}
          {canRedo && (
            <button
              type="button"
              onClick={onRedo}
              className="text-xs text-blue-500 hover:underline whitespace-nowrap"
            >
              重做
            </button>
          )}
          <button
            type="button"
            onClick={onToggle}
            aria-label={expanded ? '收起任务详情' : '展开任务详情'}
            className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200"
          >
            {expanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
          </button>
        </div>
      </div>

      {expanded && (
        <div className="border-t px-2 py-2 text-xs text-gray-600 dark:text-gray-300 space-y-2">
          <div className="whitespace-pre-wrap break-words">
            {stripProtocolMarkers(task.description)}
          </div>
          {files.length > 0 && (
            <div>
              <span className="text-gray-400">声明文件</span>
              <div className="mt-0.5 font-mono text-xs break-all">{files.join(', ')}</div>
            </div>
          )}
          {deps.length > 0 && (
            <div>
              <span className="text-gray-400">依赖任务</span>
              <div className="mt-0.5 font-mono text-xs">{deps.map(shortId).join(', ')}</div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
