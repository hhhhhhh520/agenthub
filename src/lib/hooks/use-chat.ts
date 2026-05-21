'use client'
import { useState, useCallback, useRef } from 'react'

interface Message {
  id: string
  role: 'user' | 'agent' | 'orchestrator'
  rawContent: string
  agentId?: string
  replyToId?: string
  replyTo?: { id: string; rawContent: string; role: string } | null
  createdAt: string
}

interface SSEEvent {
  agentId: string
  type: 'text' | 'code' | 'status' | 'done' | 'error'
  content: string
  messageId?: string
}

export function useChat(sessionId: string | null) {
  const [messages, setMessages] = useState<Message[]>([])
  const [streaming, setStreaming] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(false)
  const abortRef = useRef<AbortController | null>(null)

  const loadMessages = useCallback(async () => {
    if (!sessionId) return
    const res = await fetch(`/api/sessions/${sessionId}/messages`)
    const data = await res.json()
    setMessages(data)
  }, [sessionId])

  const send = useCallback(async (content: string, mentionAll?: boolean, targetAgent?: string, replyToId?: string, regenerate?: string) => {
    if (!sessionId || (!content.trim() && !regenerate)) return

    if (!regenerate) {
      const userMsg: Message = {
        id: crypto.randomUUID(),
        role: 'user',
        rawContent: content,
        replyToId,
        createdAt: new Date().toISOString(),
      }
      setMessages(prev => [...prev, userMsg])
    }
    setLoading(true)
    setStreaming({})

    const controller = new AbortController()
    abortRef.current = controller

    try {
      const res = await fetch(`/api/sessions/${sessionId}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: content, mentionAll, targetAgent, replyToId, regenerate }),
        signal: controller.signal,
      })

      const reader = res.body?.getReader()
      if (!reader) return

      const decoder = new TextDecoder()
      let buffer = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n\n')
        buffer = lines.pop() || ''

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          const event: SSEEvent = JSON.parse(line.slice(6))

          if (event.type === 'done') {
            if (event.messageId) {
              // Regenerate: replace existing message
              setMessages(prev => prev.map(m =>
                m.id === event.messageId ? { ...m, rawContent: event.content } : m
              ))
            } else {
              setMessages(prev => [...prev, {
                id: crypto.randomUUID(),
                role: event.agentId === 'orchestrator' ? 'orchestrator' : 'agent',
                rawContent: event.content,
                agentId: event.agentId,
                createdAt: new Date().toISOString(),
              }])
            }
            setStreaming(prev => { const next = { ...prev }; delete next[event.agentId]; return next })
          } else if (event.type === 'error') {
            setMessages(prev => [...prev, {
              id: crypto.randomUUID(),
              role: 'orchestrator',
              rawContent: `Error: ${event.content}`,
              createdAt: new Date().toISOString(),
            }])
          } else {
            setStreaming(prev => ({
              ...prev,
              [event.agentId]: (prev[event.agentId] || '') + event.content,
            }))
          }
        }
      }
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        console.error('Chat error:', err)
      }
    } finally {
      setLoading(false)
      abortRef.current = null
    }
  }, [sessionId])

  const stop = useCallback(() => {
    abortRef.current?.abort()
  }, [])

  return { messages, streaming, loading, send, stop, loadMessages }
}
