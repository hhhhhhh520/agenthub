'use client'
import { useState, useEffect, useCallback } from 'react'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Textarea } from '@/components/ui/textarea'
import { getAgentStyle, STATUS_COLORS } from '@/lib/agent-colors'
import { CreateAgentDialog } from '@/components/create-agent-dialog'
import { ProviderImportDialog } from '@/components/provider-import-dialog'

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
  isPreset: boolean
}

interface Task {
  id: string
  description: string
  status: string
  assignedAgentId: string
  dependencies: string
}

const TASK_STATUS_ICONS: Record<string, string> = {
  pending: '⬜',
  in_progress: '🔄',
  completed: '✅',
  failed: '❌',
  blocked: '⏸',
}

export function AgentPanel({ sessionId, onPrivateChat }: { sessionId: string | null; onPrivateChat?: (agentId: string, agentName: string) => void }) {
  const [agents, setAgents] = useState<Agent[]>([])
  const [tasks, setTasks] = useState<Task[]>([])
  const [tab, setTab] = useState<'agents' | 'tasks'>('agents')
  const [showCreate, setShowCreate] = useState(false)
  const [showImport, setShowImport] = useState(false)
  const [editingAgent, setEditingAgent] = useState<Agent | null>(null)
  const [redoTask, setRedoTask] = useState<Task | null>(null)
  const [redoDescription, setRedoDescription] = useState('')
  const [redoLoading, setRedoLoading] = useState(false)
  const [redoPollFast, setRedoPollFast] = useState(false)

  const loadAgents = useCallback(async () => {
    if (!sessionId) return
    const res = await fetch(`/api/sessions/${sessionId}/agents`)
    const sessionAgents = await res.json()
    if (Array.isArray(sessionAgents) && sessionAgents.length > 0) {
      setAgents(sessionAgents)
    } else {
      // Session has no agent members — fall back to global agent list
      const globalRes = await fetch('/api/agents')
      setAgents(await globalRes.json())
    }
  }, [sessionId])

  useEffect(() => {
    loadAgents()
  }, [loadAgents])

  useEffect(() => {
    if (!sessionId) return
    let errorCount = 0
    const fetchTasks = () => {
      fetch(`/api/sessions/${sessionId}/tasks`)
        .then(r => { if (!r.ok) throw new Error(`${r.status}`); return r.json() })
        .then(data => { setTasks(data); errorCount = 0 })
        .catch(() => { errorCount++ })
    }
    fetchTasks()
    const interval = setInterval(() => {
      if (errorCount >= 5) return // 退避：连续失败 5 次后停止轮询
      fetchTasks()
    }, redoPollFast ? 1000 : 3000)
    return () => clearInterval(interval)
  }, [sessionId, redoPollFast])

  return (
    <div className="w-72 border-l bg-gray-50 flex flex-col">
      <div className="flex border-b">
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
      <ScrollArea className="flex-1">
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
              {agents.map(agent => {
                const style = getAgentStyle(agent.name, agent.accentColor)
                const caps: string[] = (() => { try { return JSON.parse(agent.capabilities) } catch { return [] } })()
                return (
                  <div key={agent.id} className="group p-2 bg-white rounded border text-sm">
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
          {tab === 'tasks' && tasks.map(task => (
            <div key={task.id} className="p-2 bg-white rounded border text-sm">
              <div className="flex items-center gap-2">
                <span>{TASK_STATUS_ICONS[task.status] || task.status}</span>
                <span className="flex-1">{task.description}</span>
                {(task.status === 'failed' || task.status === 'blocked') && (
                  <button
                    onClick={() => { setRedoTask(task); setRedoDescription(task.description) }}
                    className="text-xs text-blue-500 hover:underline whitespace-nowrap"
                  >
                    重做
                  </button>
                )}
              </div>
            </div>
          ))}
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
                  } finally {
                    setRedoLoading(false)
                  }
                  // Check task status until terminal, then restore slow polling
                  const checkDone = async () => {
                    const res = await fetch(`/api/sessions/${sessionId}/tasks`)
                    const tasks = await res.json()
                    const t = tasks.find((t: Task) => t.id === taskToRedo.id)
                    if (t && (t.status === 'completed' || t.status === 'failed' || t.status === 'blocked')) {
                      setRedoPollFast(false)
                    } else {
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
