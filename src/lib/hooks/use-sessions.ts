'use client'
import { useState, useEffect, useCallback } from 'react'
import { useSearchParams } from 'next/navigation'

interface Session {
  id: string
  title: string
  type: string
  createdAt: string
  updatedAt: string
  _count?: { messages: number; agents: number }
}

export function useSessions() {
  const searchParams = useSearchParams()
  const [sessions, setSessions] = useState<Session[]>([])
  const [activeId, setActiveId] = useState<string | null>(searchParams.get('session'))

  const refresh = useCallback(async () => {
    const res = await fetch('/api/sessions')
    const data = await res.json()
    setSessions(data)
  }, [])

  useEffect(() => { refresh() }, [refresh])

  // 从 URL 参数自动选中会话
  useEffect(() => {
    const sessionFromUrl = searchParams.get('session')
    if (sessionFromUrl && !activeId) {
      setActiveId(sessionFromUrl)
    }
  }, [searchParams, activeId])

  const create = async (title?: string, type?: string, agentIds?: string[]) => {
    const res = await fetch('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, type, agentIds }),
    })
    const session = await res.json()
    setSessions(prev => [session, ...prev])
    setActiveId(session.id)
    return session
  }

  const remove = async (id: string) => {
    await fetch(`/api/sessions/${id}`, { method: 'DELETE' })
    let nextFirst: string | null = null
    setSessions(prev => {
      const filtered = prev.filter(s => s.id !== id)
      nextFirst = filtered[0]?.id || null
      return filtered
    })
    if (activeId === id) setActiveId(nextFirst)
  }

  return { sessions, activeId, setActiveId, create, remove, refresh }
}
