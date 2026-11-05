'use client'

import { useEffect, useState } from 'react'
import { Folder, ShieldAlert, ShieldCheck, Square, Timer, AlertTriangle, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { formatElapsed } from '@/lib/elapsed'

export { formatElapsed } from '@/lib/elapsed'

const SESSION_TYPE_LABELS: Record<string, string> = {
  group: '群聊',
  private: '私聊',
  orchestrator: '对话',
}

const STEPS = ['对齐', '拆解', '执行', '完成'] as const

export interface SessionHeaderTaskCounts {
  total: number
  done: number
  running: number
  pending: number
  failed: number
  system?: number
}

export interface SessionHeaderCurrentTask {
  description: string
  agentName?: string
  startedAt?: string
}

export interface SessionHeaderProps {
  sessionType?: string
  phase: string
  phaseStep?: string
  projectDir?: string
  permissionMode?: string
  pendingPermissionCount?: number
  systemEventCount?: number
  onOpenSystemEvents?: () => void
  taskCounts: SessionHeaderTaskCounts
  currentTask?: SessionHeaderCurrentTask
  loading?: boolean
  sessionStartedAt?: string
  waitingReason?: string | null
  waitingSince?: string | null
  onStop: () => void
  onCopyProjectDir: () => void
}

/**
 * 阶段索引：0 对齐 / 1 拆解 / 2 执行 / 3 完成；-1 未开始。
 * 审计没有独立 phase（每批执行后自动做），所以不放进 stepper，避免伪造状态。
 */
export function getStepIndex(phase: string, phaseStep?: string): number {
  if (phase === 'alignment') {
    return phaseStep === 'architect_plan' || phaseStep === 'agent_qa' ? 1 : 0
  }
  if (phase === 'execution') return 2
  if (phase === 'done') return 3
  return -1
}

/** 只让计时器自身每秒重渲染，不带动整条聊天流。 */
function LiveDuration({ start }: { start?: string }) {
  const [now, setNow] = useState<number | null>(null)

  useEffect(() => {
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])

  if (!start) return null
  const startMs = new Date(start).getTime()
  if (!Number.isFinite(startMs)) return null

  return (
    <span className="shrink-0 tabular-nums text-gray-400 dark:text-gray-500">
      {now === null ? '--:--' : formatElapsed(startMs, now)}
    </span>
  )
}

function alignmentDetail(phaseStep?: string): string {
  if (phaseStep === 'pm_confirm') return '产品经理确认需求'
  if (phaseStep === 'architect_plan') return '架构师拆解任务'
  if (phaseStep === 'agent_qa') return '智能体提问澄清'
  return '对齐中'
}

function currentDetail(
  phase: string,
  phaseStep: string | undefined,
  task: SessionHeaderCurrentTask | undefined,
  counts: SessionHeaderTaskCounts,
): string {
  if (phase === 'alignment') return alignmentDetail(phaseStep)
  if (phase === 'execution') {
    if (task) {
      return `${task.agentName || '未分配'} · ${task.description}`
    }
    if (counts.pending > 0) {
      return `等待下一批 · ${counts.pending} 个待执行`
    }
    if ((counts.system ?? 0) > 0) {
      return `等待系统校验 · ${counts.system} 项`
    }
    return '执行中 · 等待任务状态'
  }
  if (phase === 'done') {
    return counts.total > 0 ? `已完成 · ${counts.done}/${counts.total} 个任务` : '已完成'
  }
  return '待开始'
}

export function SessionHeader({
  sessionType,
  phase,
  phaseStep,
  projectDir,
  permissionMode = 'default',
  pendingPermissionCount = 0,
  systemEventCount = 0,
  onOpenSystemEvents,
  taskCounts,
  currentTask,
  loading = false,
  sessionStartedAt,
  waitingReason,
  waitingSince,
  onStop,
  onCopyProjectDir,
}: SessionHeaderProps) {
  const activeIndex = getStepIndex(phase, phaseStep)
  const isAuto = permissionMode === 'auto'
  const hasPendingPermission = pendingPermissionCount > 0
  const active = loading || phase === 'alignment' || phase === 'execution'
  const dir = projectDir?.trim()
  const detail = currentDetail(phase, phaseStep, currentTask, taskCounts)

  return (
    <div className="border-b bg-white dark:bg-gray-800 dark:border-gray-700">
      <div className="px-4 py-2 flex items-center gap-2 flex-wrap min-w-0">
        {sessionType && (
          <span className="px-2 py-0.5 rounded text-xs font-medium bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300 shrink-0">
            {SESSION_TYPE_LABELS[sessionType] || sessionType}
          </span>
        )}

        <div className="flex items-center gap-1.5 shrink-0" aria-label="会话阶段">
          {STEPS.map((label, i) => (
            <div key={label} className="flex items-center gap-1.5">
              <span
                className={
                  i < activeIndex
                    ? 'h-1.5 w-1.5 rounded-full bg-emerald-500'
                    : i === activeIndex
                      ? 'h-1.5 w-1.5 rounded-full bg-blue-500 animate-pulse'
                      : 'h-1.5 w-1.5 rounded-full bg-gray-300 dark:bg-gray-600'
                }
              />
              <span
                className={
                  i === activeIndex
                    ? 'text-xs font-medium text-blue-600 dark:text-blue-400'
                    : i < activeIndex
                      ? 'text-xs text-gray-500 dark:text-gray-400'
                      : 'text-xs text-gray-400 dark:text-gray-500'
                }
              >
                {label}
              </span>
              {i < STEPS.length - 1 && (
                <span className="h-px w-3 bg-gray-200 dark:bg-gray-700" />
              )}
            </div>
          ))}
        </div>

        <div className="ml-auto flex items-center gap-2 min-w-0">
          <button
            type="button"
            onClick={onCopyProjectDir}
            title={dir || '未指定项目目录，使用应用工作目录'}
            aria-label="复制项目目录"
            className="flex items-center gap-1 max-w-[220px] text-xs text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 min-w-0"
          >
            <Folder className="w-3.5 h-3.5 shrink-0" />
            <span className="truncate">{dir || '默认目录'}</span>
          </button>

          <span
            title={
              isAuto
                ? '自动模式：智能体的操作自动执行，不再逐次确认'
                : '默认模式：写文件/执行命令前需要你确认'
            }
            className={
              hasPendingPermission
                ? 'flex items-center gap-1 text-xs font-medium text-amber-600 dark:text-amber-400 shrink-0'
                : isAuto
                  ? 'flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400 shrink-0'
                  : 'flex items-center gap-1 text-xs text-amber-600 dark:text-amber-400 shrink-0'
            }
          >
            {isAuto ? <ShieldCheck className="w-3.5 h-3.5" /> : <ShieldAlert className="w-3.5 h-3.5" />}
            {isAuto ? '自动 · 免确认' : '默认 · 需确认'}
            {hasPendingPermission && <span className="font-semibold">待批 {pendingPermissionCount}</span>}
          </span>

          {systemEventCount > 0 && onOpenSystemEvents && (
            <button
              type="button"
              onClick={onOpenSystemEvents}
              className="flex items-center gap-1 text-xs font-medium text-amber-600 hover:text-amber-700 dark:text-amber-400 dark:hover:text-amber-300 shrink-0"
              title="查看告警、审计、校验与纠偏记录"
            >
              <AlertTriangle className="w-3.5 h-3.5" />
              系统事件 {systemEventCount}
            </button>
          )}

          {active && (
            <Button size="xs" variant="outline" onClick={onStop} className="shrink-0">
              <Square className="w-3 h-3 mr-1" />
              停止
            </Button>
          )}
        </div>
      </div>

      <div className="px-4 pb-2 flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400 min-w-0">
        <span
          className={
            phase === 'execution'
              ? 'h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse shrink-0'
              : phase === 'done'
                ? 'h-1.5 w-1.5 rounded-full bg-blue-500 shrink-0'
                : phase === 'alignment'
                  ? 'h-1.5 w-1.5 rounded-full bg-amber-500 shrink-0'
                  : 'h-1.5 w-1.5 rounded-full bg-gray-300 dark:bg-gray-600 shrink-0'
          }
        />
        {waitingReason && (
          <span
            className="inline-flex shrink-0 items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700 dark:bg-amber-950/40 dark:text-amber-300"
            title={waitingSince ? `等待开始于 ${new Date(waitingSince).toLocaleString('zh-CN')}` : waitingReason}
          >
            <Loader2 className="h-3 w-3 animate-spin" />
            <span>{waitingReason}</span>
            {waitingSince && <LiveDuration start={waitingSince} />}
          </span>
        )}
        <span className="truncate" title={detail}>{detail}</span>
        {currentTask?.startedAt && phase === 'execution' && (
          <span className="flex items-center gap-1 shrink-0">
            <Timer className="w-3 h-3 text-gray-400" />
            <LiveDuration start={currentTask.startedAt} />
          </span>
        )}

        <span className="ml-auto flex items-center gap-2 shrink-0 whitespace-nowrap">
          {sessionStartedAt && (
            <span className="flex items-center gap-1 text-gray-400 dark:text-gray-500" title="会话已用时间">
              <Timer className="w-3 h-3" />
              会话 <LiveDuration start={sessionStartedAt} />
            </span>
          )}
          {taskCounts.total > 0 && (
            <span>任务 {taskCounts.done}/{taskCounts.total}</span>
          )}
          {(taskCounts.system ?? 0) > 0 && (
            <span>系统校验 {taskCounts.system}</span>
          )}
          {taskCounts.failed > 0 && <span className="text-red-500">失败 {taskCounts.failed}</span>}
          {phase === 'execution' && (
            <span
              title="每批任务后执行影子 git diff；敏感路径越界整批失败，普通越界只告警"
              className="hidden sm:flex items-center gap-1 text-gray-400 dark:text-gray-500"
            >
              <ShieldCheck className="w-3 h-3" />
              每批审计
            </span>
          )}
        </span>
      </div>
    </div>
  )
}
