'use client'
import { useState, useEffect, useCallback, useMemo } from 'react'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Textarea } from '@/components/ui/textarea'
import { Skeleton } from '@/components/ui/skeleton'
import { getAgentStyle, STATUS_COLORS } from '@/lib/agent-colors'
import { createTaskPoller } from '@/lib/task-poller'
import { assertOkResponse } from '@/lib/http-error'
import { CreateAgentDialog } from '@/components/create-agent-dialog'
import { ProviderImportDialog } from '@/components/provider-import-dialog'
import { TaskCard } from '@/components/task-card'
import { TaskTraceDialog, type TraceEntry } from '@/components/task-trace-dialog'
import { EmptyState } from '@/components/empty-state'
import {
  isSystemTask,
  splitTaskBoard,
  summarizeTaskBoard,
  summarizeTasks,
  systemTaskTitle,
  taskDisplayTitle,
  type TaskBoardCounts,
} from '@/lib/task-board'
import { toast } from 'sonner'

interface Agent {
  id: string
  name: string
  expertise: string
  systemPrompt?: string
  platform: string
  model?: string
  baseUrl?: string
  apiKey?: string
  status?: string
  accentColor: string
  capabilities: string
  parsedCapabilities: string[]
  isPreset: boolean
}

interface Task {
  id: string
  description: string
  status: string
  assignedAgentId?: string
  dependencies: string
  declaredFiles?: string
  trace?: string
}

const parseCaps = (caps: string): string[] => {
  try { return JSON.parse(caps) } catch { return [] }
}

export function AgentPanel({ sessionId, onPrivateChat }: { sessionId: string | null; onPrivateChat?: (agentId: string, agentName: string) => void }) {
  const [agents, setAgents] = useState<Agent[]>([])
  const [tasks, setTasks] = useState<Task[]>([])
  const [agentsLoading, setAgentsLoading] = useState(true)
  const [tasksLoading, setTasksLoading] = useState(true)
  const [expandedTasks, setExpandedTasks] = useState<Set<string>>(new Set())
  const [traceTask, setTraceTask] = useState<Task | null>(null)
  const [tab, setTab] = useState<'agents' | 'tasks'>('tasks')
  const [showCreate, setShowCreate] = useState(false)
  const [showImport, setShowImport] = useState(false)
  const [editingAgent, setEditingAgent] = useState<Agent | null>(null)
  const [redoTask, setRedoTask] = useState<Task | null>(null)
  const [redoDescription, setRedoDescription] = useState('')
  const [redoLoading, setRedoLoading] = useState(false)
  const [redoPollFast, setRedoPollFast] = useState(false)

  const loadAgents = useCallback(async () => {
    if (!sessionId) { setAgentsLoading(false); return }
    setAgentsLoading(true)
    try {
      const res = await fetch(`/api/sessions/${sessionId}/agents`)
      if (!res.ok) throw new Error(`${res.status}`)
      const sessionAgents = await res.json()
      if (Array.isArray(sessionAgents) && sessionAgents.length > 0) {
        setAgents(sessionAgents.map((a: Agent) => ({ ...a, parsedCapabilities: parseCaps(a.capabilities) })))
      } else {
        // Session has no agent members — fall back to global agent list
        const globalRes = await fetch('/api/agents')
        if (!globalRes.ok) throw new Error(`${globalRes.status}`)
        const globalAgents = await globalRes.json()
        setAgents(globalAgents.map((a: Agent) => ({ ...a, parsedCapabilities: parseCaps(a.capabilities) })))
      }
    } catch (err) {
      console.error('Failed to load agents:', err)
      toast.error('加载智能体列表失败')
    } finally {
      setAgentsLoading(false)
    }
  }, [sessionId])

  useEffect(() => {
    loadAgents()
  }, [loadAgents])

  useEffect(() => {
    if (!sessionId) { setTasksLoading(false); return }
    const poller = createTaskPoller({
      fetchTasks: (signal) =>
        fetch(`/api/sessions/${sessionId}/tasks`, { signal }).then((r) => {
          if (!r.ok) throw new Error(`${r.status}`)
          return r.json()
        }),
      setTasks: (updater) => setTasks((prev) => updater(prev) as Task[]),
      setLoading: (loading) => setTasksLoading(loading),
      redoFast: redoPollFast,
    })
    return () => poller.stop()
  }, [sessionId, redoPollFast])

  // Memoize parsed traces to avoid JSON.parse on every render
  const parsedTraces = useMemo(() => {
    const map = new Map<string, TraceEntry[]>()
    for (const task of tasks) {
      try {
        const parsed: unknown = JSON.parse(task.trace || '[]')
        map.set(task.id, Array.isArray(parsed) ? parsed as TraceEntry[] : [])
      } catch {
        map.set(task.id, [])
      }
    }
    return map
  }, [tasks])

  const { batches, systemTasks } = useMemo(() => splitTaskBoard(tasks), [tasks])
  const boardSummary = useMemo(() => summarizeTaskBoard(tasks), [tasks])
  const agentNameById = useMemo(
    () => new Map(agents.map(agent => [agent.id, agent.name])),
    [agents],
  )

  const toggleTask = (id: string) => {
    setExpandedTasks(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const traceTaskTitle = traceTask
    ? (isSystemTask(traceTask.description)
        ? systemTaskTitle(traceTask.description)
        : taskDisplayTitle(traceTask.description))
    : ''

  return (
    <div className="w-72 border-l bg-gray-50 dark:bg-gray-900 dark:border-gray-700 flex flex-col min-h-0 overflow-hidden">
      <div className="flex border-b dark:border-gray-700">
        <button
          className={`flex-1 p-2 text-sm font-medium ${tab === 'agents' ? 'border-b-2 border-blue-500' : ''}`}
          onClick={() => setTab('agents')}
        >
          智能体 ({agents.length})
        </button>
        <button
          className={`flex-1 p-2 text-sm font-medium ${tab === 'tasks' ? 'border-b-2 border-blue-500' : ''}`}
          onClick={() => setTab('tasks')}
        >
          任务 ({tasks.length})
        </button>
      </div>
      <ScrollArea className="flex-1 min-h-0 overflow-hidden">
        <div className="p-3 space-y-2">
          {tab === 'agents' && (
            <>
              <div className="flex gap-1">
                <Button variant="outline" size="sm" className="flex-1" onClick={() => setShowCreate(true)}>
                  + 创建智能体
                </Button>
                <Button variant="outline" size="sm" className="flex-1" onClick={() => setShowImport(true)}>
                  导入服务商
                </Button>
              </div>
              {agentsLoading ? (
                <div className="space-y-2">
                  {Array.from({ length: 3 }).map((_, i) => (
                    <div key={i} className="p-2 bg-white dark:bg-gray-800 rounded border dark:border-gray-700 space-y-2">
                      <div className="flex items-center gap-2">
                        <Skeleton className="h-8 w-8 rounded-full" />
                        <Skeleton className="h-4 w-20" />
                      </div>
                      <Skeleton className="h-3 w-32" />
                    </div>
                  ))}
                </div>
              ) : agents.length === 0 ? (
                <EmptyState
                  compact
                  title="还没有智能体"
                  description="创建或导入一个智能体，然后开始对话。"
                />
              ) : agents.map(agent => {
                const style = getAgentStyle(agent.name, agent.accentColor)
                const caps = agent.parsedCapabilities || []
                return (
                  <div key={agent.id} className="group p-2 bg-white dark:bg-gray-800 rounded border dark:border-gray-700 text-sm">
                    <div className="flex items-center gap-2">
                      <Avatar size="sm">
                        <AvatarFallback className={style.avatarBg}>{style.initial}</AvatarFallback>
                      </Avatar>
                      <span className="font-medium flex-1">{agent.name}</span>
                      <button
                        onClick={() => setEditingAgent(agent)}
                        className="text-xs text-gray-400 hover:text-gray-600 opacity-0 group-hover:opacity-100"
                        title="编辑"
                      >
                        编辑
                      </button>
                      {onPrivateChat && (
                        <button
                          onClick={() => onPrivateChat(agent.id, agent.name)}
                          className="text-xs text-blue-500 hover:underline"
                          title={`和 ${agent.name} 私聊`}
                        >
                          私聊
                        </button>
                      )}
                      {agent.status && (
                        <span className={`w-2 h-2 rounded-full ${STATUS_COLORS[agent.status] || 'bg-gray-400'}`} />
                      )}
                    </div>
                    <div className="text-xs text-gray-500 mt-1 ml-9">{agent.expertise}</div>
                    {caps.length > 0 && (
                      <div className="flex flex-wrap gap-1 mt-1 ml-9">
                        {caps.slice(0, 3).map(cap => (
                          <Badge key={cap} variant="secondary" className="text-xs">{cap}</Badge>
                        ))}
                        {caps.length > 3 && <span className="text-xs text-gray-400">+{caps.length - 3}</span>}
                      </div>
                    )}
                  </div>
                )
              })}
            </>
          )}
          {tab === 'tasks' && (
            tasksLoading ? (
              <div className="space-y-2">
                {Array.from({ length: 3 }).map((_, i) => (
                  <div key={i} className="p-2 bg-white dark:bg-gray-800 rounded border dark:border-gray-700 space-y-1">
                    <div className="flex items-center gap-2">
                      <Skeleton className="h-4 w-4" />
                      <Skeleton className="h-4 flex-1" />
                    </div>
                  </div>
                ))}
              </div>
            ) : tasks.length === 0 ? (
              <EmptyState
                compact
                title="暂无任务"
                description="发出第一条需求后，这里会显示拆解结果与执行进度。"
              />
            ) : (
              <>
                <TaskProgress summary={boardSummary} />

                {batches.map(({ batch, tasks: batchTasks }) => {
                  const batchSummary = summarizeTasks(batchTasks)
                  return (
                    <div key={batch} className="space-y-1.5">
                      <div className="flex items-center justify-between px-1 pt-1">
                        <span className="text-xs font-medium text-gray-500">第 {batch + 1} 批</span>
                        <span className="text-xs text-gray-400">
                          {batchSummary.done}/{batchSummary.total}
                          {batchSummary.running > 0 && <span className="text-blue-500"> · 执行 {batchSummary.running}</span>}
                          {batchSummary.failed > 0 && <span className="text-red-500"> · 失败 {batchSummary.failed}</span>}
                          {batchSummary.blocked > 0 && <span className="text-amber-600"> · 阻塞 {batchSummary.blocked}</span>}
                        </span>
                      </div>
                      {batchTasks.map(task => (
                        <TaskCard
                          key={task.id}
                          task={task}
                          agentName={task.assignedAgentId ? agentNameById.get(task.assignedAgentId) : undefined}
                          traceCount={(parsedTraces.get(task.id) || []).length}
                          expanded={expandedTasks.has(task.id)}
                          onToggle={() => toggleTask(task.id)}
                          onOpenTrace={() => setTraceTask(task)}
                          onRedo={() => {
                            setRedoTask(task)
                            setRedoDescription(task.description)
                          }}
                        />
                      ))}
                    </div>
                  )
                })}

                {systemTasks.length > 0 && (
                  <div className="pt-2 space-y-1.5">
                    <div className="flex items-center justify-between px-1">
                      <span className="text-xs font-medium text-gray-500">系统校验</span>
                      <span className="text-xs text-gray-400">
                        {systemTasks.filter(task => task.status === 'completed').length}/{systemTasks.length}
                      </span>
                    </div>
                    {systemTasks.map(task => (
                      <TaskCard
                        key={task.id}
                        task={task}
                        agentName={task.assignedAgentId ? agentNameById.get(task.assignedAgentId) : undefined}
                        traceCount={(parsedTraces.get(task.id) || []).length}
                        expanded={expandedTasks.has(task.id)}
                        onToggle={() => toggleTask(task.id)}
                        onOpenTrace={() => setTraceTask(task)}
                      />
                    ))}
                  </div>
                )}
              </>
            )
          )}
        </div>
      </ScrollArea>
      <CreateAgentDialog
        open={showCreate}
        onOpenChange={setShowCreate}
        onCreated={async (agentId) => {
          // Add the new agent to the current session
          if (sessionId && agentId) {
            await fetch(`/api/sessions/${sessionId}/members`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ agentId }),
            })
          }
          loadAgents()
          if (sessionId) window.dispatchEvent(new Event('agenthub:members-changed'))
        }}
      />
      {editingAgent && (
        <CreateAgentDialog
          open={!!editingAgent}
          onOpenChange={(open) => { if (!open) setEditingAgent(null) }}
          editAgent={editingAgent}
          onCreated={() => {
            setEditingAgent(null)
            loadAgents()
            if (sessionId) window.dispatchEvent(new Event('agenthub:members-changed'))
          }}
        />
      )}
      <ProviderImportDialog
        open={showImport}
        onOpenChange={setShowImport}
        onImport={async (config) => {
          // Server resolves real apiKey from config.toml — browser never sends apiKey
          const res = await fetch('/api/providers/import', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(config),
          })
          await assertOkResponse(res, '导入服务商失败')
          const data = await res.json()
          // Add the imported agent to current session
          if (sessionId && data.agent?.id) {
            const memberRes = await fetch(`/api/sessions/${sessionId}/members`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ agentId: data.agent.id }),
            })
            await assertOkResponse(memberRes, '加入当前会话失败')
          }
          loadAgents()
          if (sessionId) window.dispatchEvent(new Event('agenthub:members-changed'))
        }}
      />
      {redoTask && sessionId && (
        <Dialog open={!!redoTask} onOpenChange={(open) => { if (!open) setRedoTask(null) }}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>重做任务</DialogTitle>
            </DialogHeader>
            <p className="text-sm text-gray-500">可以修改任务描述后重新执行，也可以不改直接提交。</p>
            <Textarea
              value={redoDescription}
              onChange={(e) => setRedoDescription(e.target.value)}
              rows={3}
              className="mt-3"
            />
            <DialogFooter>
              <Button variant="outline" onClick={() => setRedoTask(null)}>取消</Button>
              <Button
                disabled={redoLoading}
                onClick={async () => {
                  setRedoLoading(true)
                  const taskToRedo = redoTask
                  const desc = redoDescription
                  setRedoTask(null) // Close dialog immediately
                  setRedoPollFast(true) // Speed up polling
                  try {
                    const redoRes = await fetch(`/api/sessions/${sessionId}/tasks/${taskToRedo.id}/redo`, {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ description: desc }),
                    })
                    if (!redoRes.ok) {
                      // 429 会话正忙：redo 未执行，降回慢速轮询并提示（否则 checkDone 会空转 30 次再报超时）。
                      const busy = await redoRes.json().catch(() => null) as { error?: string } | null
                      setRedoPollFast(false)
                      toast.error(busy?.error || '重做请求失败')
                      return
                    }
                  } catch (e) {
                    console.error('Redo request failed:', e)
                    toast.error('重做请求失败')
                  } finally {
                    setRedoLoading(false)
                  }
                  // Check task status until terminal, then restore slow polling
                  let checkRetries = 0
                  const checkDone = async () => {
                    checkRetries++
                    if (checkRetries > 30) {
                      setRedoPollFast(false)
                      toast.error('任务状态检查超时，请手动刷新')
                      return
                    }
                    try {
                      const res = await fetch(`/api/sessions/${sessionId}/tasks`)
                      const tasks = await res.json()
                      const t = tasks.find((t: Task) => t.id === taskToRedo.id)
                      if (t && (t.status === 'completed' || t.status === 'failed' || t.status === 'blocked')) {
                        setRedoPollFast(false)
                      } else {
                        setTimeout(checkDone, 1000)
                      }
                    } catch {
                      setTimeout(checkDone, 1000)
                    }
                  }
                  setTimeout(checkDone, 1000)
                }}
              >
                确认重做
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
      <TaskTraceDialog
        open={!!traceTask}
        onOpenChange={(open) => { if (!open) setTraceTask(null) }}
        taskId={traceTask?.id}
        title={traceTaskTitle}
        entries={traceTask ? (parsedTraces.get(traceTask.id) || []) : []}
        raw={traceTask?.trace || ''}
      />
    </div>
  )
}

function TaskProgress({ summary }: { summary: TaskBoardCounts }) {
  const percent = summary.total > 0 ? Math.round((summary.done / summary.total) * 100) : 0
  const barTone = summary.total > 0 && summary.done === summary.total
    ? 'bg-emerald-500'
    : summary.failed + summary.blocked > 0
      ? 'bg-amber-500'
      : 'bg-blue-500'

  return (
    <div className="rounded-md border bg-white p-2 dark:bg-gray-800 dark:border-gray-700">
      <div className="flex items-center justify-between text-xs">
        <span className="font-medium">任务进度</span>
        <span className="text-gray-500">{summary.done}/{summary.total}</span>
      </div>
      <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-gray-100 dark:bg-gray-700">
        <div className={`h-full rounded-full ${barTone}`} style={{ width: `${percent}%` }} />
      </div>
      <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-gray-500">
        {summary.running > 0 && <span className="text-blue-500">执行中 {summary.running}</span>}
        {summary.pending > 0 && <span>待执行 {summary.pending}</span>}
        {summary.failed > 0 && <span className="text-red-500">失败 {summary.failed}</span>}
        {summary.blocked > 0 && <span className="text-amber-600">阻塞 {summary.blocked}</span>}
        {summary.system > 0 && <span>系统校验 {summary.system}</span>}
        {summary.total === 0 && <span>暂无用户任务</span>}
      </div>
    </div>
  )
}
