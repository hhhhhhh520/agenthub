'use client'
import { useState, useEffect } from 'react'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
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

  const loadAgents = async () => {
    if (!sessionId) return
    const res = await fetch(`/api/sessions/${sessionId}/agents`)
    setAgents(await res.json())
  }

  useEffect(() => {
    loadAgents()
  }, [sessionId])

  useEffect(() => {
    if (!sessionId) return
    fetch(`/api/sessions/${sessionId}/tasks`)
      .then(r => r.json())
      .then(setTasks)
    const interval = setInterval(() => {
      fetch(`/api/sessions/${sessionId}/tasks`)
        .then(r => r.json())
        .then(setTasks)
    }, 3000)
    return () => clearInterval(interval)
  }, [sessionId])

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
                          className="text-xs text-blue-500 hover:underline opacity-0 group-hover:opacity-100"
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
          // Save provider config to .env via API
          await fetch('/api/providers/import', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(config),
          })
        }}
      />
    </div>
  )
}
