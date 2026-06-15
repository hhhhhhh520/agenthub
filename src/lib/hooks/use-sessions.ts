'use client'
import { useState, useEffect, useCallback, useRef } from 'react'
import { useSearchParams } from 'next/navigation'
import { toast } from 'sonner'

interface Session {
  id: string
  title: string
  type: string
  createdAt: string
  updatedAt: string
  _count?: { messages: number; agents: number }
  members?: Array<{ agentId: string; agent?: { name: string; accentColor: string } }>
}

export function useSessions() {
  const searchParams = useSearchParams()
  const [sessions, setSessions] = useState<Session[]>([])
  const [activeId, setActiveId] = useState<string | null>(searchParams.get('session'))
  const [isLoading, setIsLoading] = useState(true)
  const isRefreshing = useRef(false)
  const needsRefresh = useRef(false)

  const doFetch = useCallback(async () => {
    try {
      const res = await fetch('/api/sessions')
      const data = await res.json()
      setSessions(data)
    } catch (err) {
      console.error('Failed to refresh sessions:', err)
    }
  }, [])

  const refresh = useCallback(async (showLoading = false) => {
    if (isRefreshing.current) { needsRefresh.current = true; return }
    isRefreshing.current = true
    if (showLoading) setIsLoading(true)
    try {
      await doFetch()
    } finally {
      if (showLoading) setIsLoading(false)
      isRefreshing.current = false
      if (needsRefresh.current) { needsRefresh.current = false; refresh(false) }
    }
  }, [doFetch])

  useEffect(() => { refresh(true) }, [refresh])

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
    try {
      const res = await fetch(`/api/sessions/${id}`, { method: 'DELETE' })
      if (!res.ok) throw new Error('Delete failed')
      setSessions(prev => {
        const filtered = prev.filter(s => s.id !== id)
        setActiveId(prev => prev === id ? (filtered[0]?.id || null) : prev)
        return filtered
      })
      toast.success('会话已删除')
    } catch (err) {
      console.error('Failed to delete session:', err)
      toast.error('删除会话失败')
    }
  }

  return { sessions, activeId, setActiveId, create, remove, refresh, isLoading }
}
