'use client'
import { useState, useEffect } from 'react'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Badge } from '@/components/ui/badge'

interface Agent {
  id: string
  name: string
  expertise: string
  platform: string
  status: string
}

interface Task {
  id: string
  description: string
  status: string
  assignedAgentId: string
  dependencies: string
}

const STATUS_ICONS: Record<string, string> = {
  idle: '⏳',
  working: '🔄',
  done: '✅',
  error: '❌',
  pending: '⬜',
  in_progress: '🔄',
  completed: '✅',
  failed: '❌',
}

export function AgentPanel({ sessionId }: { sessionId: string | null }) {
  const [agents, setAgents] = useState<Agent[]>([])
  const [tasks, setTasks] = useState<Task[]>([])
  const [tab, setTab] = useState<'agents' | 'tasks'>('agents')

  useEffect(() => {
    if (!sessionId) return
    const load = async () => {
      const [aRes, tRes] = await Promise.all([
        fetch(`/api/sessions/${sessionId}/agents`),
        fetch(`/api/sessions/${sessionId}/tasks`),
      ])
      setAgents(await aRes.json())
      setTasks(await tRes.json())
    }
    load()
    const interval = setInterval(load, 3000)
    return () => clearInterval(interval)
  }, [sessionId])

  if (!sessionId) return null

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
          {tab === 'agents' && agents.map(agent => (
            <div key={agent.id} className="p-2 bg-white rounded border text-sm">
              <div className="flex items-center justify-between">
                <span className="font-medium">{agent.name}</span>
                <span>{STATUS_ICONS[agent.status] || agent.status}</span>
              </div>
              <div className="text-xs text-gray-500 mt-1">{agent.expertise}</div>
              <Badge variant="outline" className="mt-1 text-xs">{agent.platform}</Badge>
            </div>
          ))}
          {tab === 'tasks' && tasks.map(task => (
            <div key={task.id} className="p-2 bg-white rounded border text-sm">
              <div className="flex items-center gap-2">
                <span>{STATUS_ICONS[task.status] || task.status}</span>
                <span className="flex-1">{task.description}</span>
              </div>
            </div>
          ))}
        </div>
      </ScrollArea>
    </div>
  )
}
