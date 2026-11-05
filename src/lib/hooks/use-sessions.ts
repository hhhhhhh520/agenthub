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
  projectDir?: string
  phase?: string
  isPinned?: boolean
  isArchived?: boolean
  _count?: { messages: number; members: number }
  members?: Array<{ agentId: string; agent?: { name: string; accentColor: string } }>
}

export interface BatchResult {
  succeeded: string[]
  failed: Array<{ id: string; error: string }>
}

async function readError(res: Response, fallback: string): Promise<string> {
  try {
    const data = await res.json() as { error?: unknown }
    if (typeof data?.error === 'string' && data.error) return data.error
  } catch {
    // ignore non-JSON error bodies
  }
  return `${fallback} (${res.status})`
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
      setSessions(Array.isArray(data) ? data : [])
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

  // 首条消息自动命名、临时执行状态等变更后，侧栏标题/排序立即同步。
  useEffect(() => {
    if (typeof window === 'undefined') return
    const handleSessionsChanged = () => { void refresh(false) }
    window.addEventListener('agenthub:sessions-changed', handleSessionsChanged)
    return () => window.removeEventListener('agenthub:sessions-changed', handleSessionsChanged)
  }, [refresh])

  // 从 URL 参数自动选中会话
  useEffect(() => {
    const sessionFromUrl = searchParams.get('session')
    if (sessionFromUrl && !activeId) {
      setActiveId(sessionFromUrl)
    }
  }, [searchParams, activeId])

  const create = async (title?: string, type?: string, agentIds?: string[], projectDir?: string) => {
    const res = await fetch('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, type, agentIds, projectDir }),
    })
    const session = await res.json()
    setSessions(prev => [session, ...prev])
    setActiveId(session.id)
    return session
  }

  const applyRemoval = useCallback((ids: string[]) => {
    const removed = new Set(ids)
    setSessions(prev => {
      const next = prev.filter(s => !removed.has(s.id))
      setActiveId(current => current && removed.has(current) ? (next[0]?.id || null) : current)
      return next
    })
  }, [])

  const deleteOne = useCallback(async (id: string): Promise<{ id: string; ok: boolean; error?: string }> => {
    try {
      const res = await fetch(`/api/sessions/${id}`, { method: 'DELETE' })
      if (res.ok) return { id, ok: true }
      return { id, ok: false, error: await readError(res, '删除失败') }
    } catch (err) {
      return { id, ok: false, error: err instanceof Error ? err.message : '删除失败' }
    }
  }, [])

  const remove = async (id: string) => {
    const result = await deleteOne(id)
    if (!result.ok) {
      toast.error(result.error || '删除会话失败')
      return false
    }
    applyRemoval([id])
    toast.success('会话已删除')
    return true
  }

  const removeMany = async (ids: string[]): Promise<BatchResult> => {
    const succeeded: string[] = []
    const failed: BatchResult['failed'] = []
    for (const id of ids) {
      const result = await deleteOne(id)
      if (result.ok) succeeded.push(id)
      else failed.push({ id, error: result.error || '删除失败' })
    }

    if (succeeded.length > 0) applyRemoval(succeeded)

    if (failed.length === 0) {
      toast.success(`已删除 ${succeeded.length} 个会话`)
    } else {
      toast.error(`已删除 ${succeeded.length} 个，${failed.length} 个失败：${failed[0].error}`)
    }
    return { succeeded, failed }
  }

  const rename = async (id: string, title: string): Promise<boolean> => {
    try {
      const res = await fetch(`/api/sessions/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title }),
      })
      if (!res.ok) {
        toast.error(await readError(res, '重命名失败'))
        return false
      }
      const updated = await res.json().catch(() => null) as { title?: unknown } | null
      const nextTitle = typeof updated?.title === 'string' ? updated.title : title.trim()
      setSessions(prev => prev.map(s => s.id === id ? { ...s, title: nextTitle } : s))
      toast.success('会话已重命名')
      return true
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '重命名失败')
      return false
    }
  }

  const archiveMany = async (ids: string[], archived = true): Promise<BatchResult> => {
    const succeeded: string[] = []
    const failed: BatchResult['failed'] = []
    for (const id of ids) {
      try {
        const res = await fetch(`/api/sessions/${id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ isArchived: archived }),
        })
        if (res.ok) succeeded.push(id)
        else failed.push({ id, error: await readError(res, archived ? '归档失败' : '恢复失败') })
      } catch (err) {
        failed.push({ id, error: err instanceof Error ? err.message : '操作失败' })
      }
    }

    if (succeeded.length > 0) {
      if (archived) applyRemoval(succeeded)
      else await doFetch()
    }

    if (failed.length === 0) {
      toast.success(archived ? `已归档 ${succeeded.length} 个会话` : `已恢复 ${succeeded.length} 个会话`)
    } else {
      toast.error(`${archived ? '归档' : '恢复'} ${succeeded.length} 个，${failed.length} 个失败：${failed[0].error}`)
    }
    return { succeeded, failed }
  }

  return {
    sessions,
    activeId,
    setActiveId,
    create,
    remove,
    removeMany,
    rename,
    archiveMany,
    refresh,
    isLoading,
  }
}
