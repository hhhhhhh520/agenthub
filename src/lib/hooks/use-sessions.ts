'use client'
import { useState, useEffect, useCallback } from 'react'

interface Session {
  id: string
  title: string
  createdAt: string
  updatedAt: string
  _count?: { messages: number; agents: number }
}

export function useSessions() {
  const [sessions, setSessions] = useState<Session[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    const res = await fetch('/api/sessions')
    const data = await res.json()
    setSessions(data)
  }, [])

  useEffect(() => { refresh() }, [refresh])

  const create = async (title?: string) => {
    const res = await fetch('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title }),
    })
    const session = await res.json()
    setSessions(prev => [session, ...prev])
    setActiveId(session.id)
    return session
  }

  const remove = async (id: string) => {
    await fetch(`/api/sessions/${id}`, { method: 'DELETE' })
    setSessions(prev => prev.filter(s => s.id !== id))
    if (activeId === id) setActiveId(sessions[0]?.id || null)
  }

  return { sessions, activeId, setActiveId, create, remove, refresh }
}
