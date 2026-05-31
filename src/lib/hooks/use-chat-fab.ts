'use client'
import { useState, useEffect, useCallback, useMemo } from 'react'
import { useChat } from './use-chat'

interface Agent {
  id: string
  name: string
  expertise: string
  accentColor: string
  status: string
}

interface Session {
  id: string
  title: string
  type: string
  members: { agentId: string }[]
}

export function useChatFab() {
  const [agents, setAgents] = useState<Agent[]>([])
  const [selectedAgent, setSelectedAgent] = useState<Agent | null>(null)
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [projectDir, setProjectDir] = useState('')

  const chat = useChat(sessionId)

  // name → Agent 映射，渲染消息时用
  // 注意：chat/route.ts 存 Message.agentId 用的是 agent.name（不是 UUID）
  const agentNameMap = useMemo(() => {
    const map = new Map<string, Agent>()
    for (const agent of agents) map.set(agent.name, agent)
    return map
  }, [agents])

  // 初始化
  useEffect(() => {
    fetch('/api/agents').then(r => r.json()).then(setAgents)
    fetch('/api/recent-dirs').then(r => r.json()).then(dirs => {
      if (dirs[0]) setProjectDir(dirs[0].path)
    })
  }, [])

  // sessionId 变化时加载历史消息
  useEffect(() => {
    if (sessionId) chat.loadMessages()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId])

  // 选择 Agent → 查找或创建私聊 Session
  const selectAgent = useCallback(async (agent: Agent) => {
    setSelectedAgent(agent)

    // 获取 sessions 确保数据新鲜
    const freshSessions: Session[] = await fetch('/api/sessions').then(r => r.json())

    // 用 agent.id 匹配（SessionMember.agentId 存的是 Agent UUID）
    const existing = freshSessions.find(
      s => s.type === 'private' && s.members?.some(m => m.agentId === agent.id)
    )

    if (existing) {
      setSessionId(existing.id)
    } else {
      const session = await fetch('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: `私聊: ${agent.name}`,
          type: 'private',
          projectDir,
        }),
      }).then(r => r.json())

      await fetch(`/api/sessions/${session.id}/members`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId: agent.id }),
      })

      setSessionId(session.id)
    }
  }, [projectDir])

  const resetChat = useCallback(() => {
    setSelectedAgent(null)
    setSessionId(null)
  }, [])

  return {
    agents,
    agentNameMap,
    selectedAgent,
    selectAgent,
    resetChat,
    projectDir,
    setProjectDir,
    sessionId,
    ...chat,
  }
}
