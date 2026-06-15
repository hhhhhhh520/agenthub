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
import { CreateAgentDialog } from '@/components/create-agent-dialog'
import { ProviderImportDialog } from '@/components/provider-import-dialog'
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
  status: string
  accentColor: string
  capabilities: string
  parsedCapabilities: string[]
  isPreset: boolean
}

interface Task {
  id: string
  description: string
  status: string
  assignedAgentId: string
  dependencies: string
  trace?: string
}

const TASK_STATUS_ICONS: Record<string, string> = {
  pending: '⬜',
  in_progress: '🔄',
  completed: '✅',
  failed: '❌',
  blocked: '⏸',
}

const parseCaps = (caps: string): string[] => {
  try { return JSON.parse(caps) } catch { return [] }
}

export function AgentPanel({ sessionId, onPrivateChat }: { sessionId: string | null; onPrivateChat?: (agentId: string, agentName: string) => void }) {
  const [agents, setAgents] = useState<Agent[]>([])
  const [tasks, setTasks] = useState<Task[]>([])
  const [agentsLoading, setAgentsLoading] = useState(true)
  const [tasksLoading, setTasksLoading] = useState(true)
  const [expandedTraces, setExpandedTraces] = useState<Set<string>>(new Set())
  const [tab, setTab] = useState<'agents' | 'tasks'>('agents')
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
      toast.error('加载 Agent 列表失败')
    } finally {
      setAgentsLoading(false)
    }
  }, [sessionId])

  useEffect(() => {
    loadAgents()
  }, [loadAgents])

  useEffect(() => {
    if (!sessionId) { setTasksLoading(false); return }
    setTasksLoading(true)
    setTasks([])
    let errorCount = 0
    let firstFetch = true
    const controller = new AbortController()
    const fetchTasks = () => {
      fetch(`/api/sessions/${sessionId}/tasks`, { signal: controller.signal })
        .then(r => { if (!r.ok) throw new Error(`${r.status}`); return r.json() })
        .then(data => {
          setTasks(prev => {
            if (data.length !== prev.length) return data
            const changed = data.some((t: Task, i: number) =>
              t.status !== prev[i].status || t.trace !== prev[i].trace
            )
            return changed ? data : prev
          })
          errorCount = 0; if (firstFetch) { setTasksLoading(false); firstFetch = false }
        })
        .catch((err) => {
          if (err.name === 'AbortError') return
          errorCount++; if (firstFetch) { setTasksLoading(false); firstFetch = false }
        })
    }
    fetchTasks()
    const interval = setInterval(() => {
      if (errorCount >= 5) return // 退避：连续失败 5 次后停止轮询
      fetchTasks()
    }, redoPollFast ? 1000 : 3000)
    return () => { clearInterval(interval); controller.abort() }
  }, [sessionId, redoPollFast])

  // Memoize parsed traces to avoid JSON.parse on every render
  const parsedTraces = useMemo(() => {
    const map = new Map<string, Array<{ ts: string; event: string; message?: string; agent?: string; attempt?: number; duration_ms?: number }>>()
    for (const task of tasks) {
      try { map.set(task.id, JSON.parse(task.trace || '[]')) } catch { map.set(task.id, []) }
    }
    return map
  }, [tasks])

  return (
    <div className="w-72 border-l bg-gray-50 dark:bg-gray-900 dark:border-gray-700 flex flex-col min-h-0 overflow-hidden">
      <div className="flex border-b dark:border-gray-700">
        <button
          className={`flex-1 p-2 text-sm font-medium ${tab === 'agents' ? 'border-b-2 border-blue-500' : ''}`}
          onClick={() => setTab('agents')}
        >
          Agents ({agents.length})
        </button>
        <button
          className={`flex-1 p-2 text-sm font-medium ${tab === 'tasks' ? 'border-b-2 border-blue-500' : ''}`}
          onClick={() => setTab('tasks')}
        >
          Tasks ({tasks.length})
        </button>
      </div>
      <ScrollArea className="flex-1 min-h-0 overflow-hidden">
        <div className="p-3 space-y-2">
          {tab === 'agents' && (
            <>
              <div className="flex gap-1">
                <Button variant="outline" size="sm" className="flex-1" onClick={() => setShowCreate(true)}>
                  + 创建 Agent
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
                <div className="text-center text-gray-400 dark:text-gray-500 text-xs py-6">
                  还没有 Agent，创建或导入一个
                </div>
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
                      <span className={`w-2 h-2 rounded-full ${STATUS_COLORS[agent.status] || 'bg-gray-400'}`} />
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
              <div className="text-center text-gray-400 dark:text-gray-500 text-xs py-6">
                暂无任务，开始对话后会在这里显示
              </div>
            ) : tasks.map(task => {
            const traceEntries = parsedTraces.get(task.id) || []
            const isExpanded = expandedTraces.has(task.id)
            return (
              <div key={task.id} className="p-2 bg-white dark:bg-gray-800 rounded border dark:border-gray-700 text-sm">
                <div className="flex items-center gap-2">
                  <span>{TASK_STATUS_ICONS[task.status] || task.status}</span>
                  <span className="flex-1">{task.description}</span>
                  {traceEntries.length > 0 && (
                    <button
                      onClick={() => setExpandedTraces(prev => { const next = new Set(prev); next.has(task.id) ? next.delete(task.id) : next.add(task.id); return next })}
                      className="text-xs text-gray-400 hover:text-gray-600"
                    >
                      {isExpanded ? '收起' : `trace(${traceEntries.length})`}
                    </button>
                  )}
                  {(task.status === 'failed' || task.status === 'blocked') && (
                    <button
                      onClick={() => { setRedoTask(task); setRedoDescription(task.description) }}
                      className="text-xs text-blue-500 hover:underline whitespace-nowrap"
                    >
                      重做
                    </button>
                  )}
                </div>
                {isExpanded && traceEntries.length > 0 && (
                  <div className="mt-2 text-xs text-gray-500 space-y-0.5 font-mono">
                    {traceEntries.map((entry, i) => (
                      <div key={i}>
                        {entry.event === 'start' && `▶ ${entry.agent || '?'} 开始执行`}
                        {entry.event === 'success' && `✓ 完成${entry.duration_ms ? ` (${entry.duration_ms}ms)` : ''}`}
                        {entry.event === 'error' && `✗ 失败: ${entry.message || '未知错误'}`}
                        {entry.event === 'correction' && `↻ 纠偏 #${entry.attempt}: ${entry.message || ''}`}
                        {entry.event === 'blocked' && `⏸ 阻塞: ${entry.message || ''}`}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )
          })
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
        }}
      />
      {editingAgent && (
        <CreateAgentDialog
          open={!!editingAgent}
          onOpenChange={(open) => { if (!open) setEditingAgent(null) }}
          editAgent={editingAgent}
          onCreated={() => { setEditingAgent(null); loadAgents() }}
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
          const data = await res.json()
          // Add the imported agent to current session
          if (sessionId && data.agent?.id) {
            await fetch(`/api/sessions/${sessionId}/members`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ agentId: data.agent.id }),
            })
          }
          loadAgents()
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
                    await fetch(`/api/sessions/${sessionId}/tasks/${taskToRedo.id}/redo`, {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ description: desc }),
                    })
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
    </div>
  )
}
