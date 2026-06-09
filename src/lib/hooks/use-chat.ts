'use client'
import { useState, useCallback, useRef } from 'react'

interface Attachment {
  id: string
  filename: string
  mimeType: string
  size: number
}

interface Message {
  id: string
  role: 'user' | 'agent' | 'orchestrator'
  rawContent: string
  agentId?: string
  replyToId?: string
  replyTo?: { id: string; rawContent: string; role: string } | null
  isPinned?: boolean
  createdAt: string
  attachments?: Attachment[]
}

interface SSEEvent {
  agentId: string
  type: string
  content: string
  messageId?: string
  data?: { requestId?: string; toolName?: string; toolInput?: Record<string, unknown> }
}

interface ToolCall {
  id: string
  agentId: string
  toolName: string
  toolInput: Record<string, unknown>
  toolResult?: string
  status: 'running' | 'completed'
}

export function useChat(sessionId: string | null) {
  const [messages, setMessages] = useState<Message[]>([])
  const [streaming, setStreaming] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(false)
  const [phase, setPhase] = useState<string>('idle')
  const [awaitingInput, setAwaitingInput] = useState<string | null>(null)
  const [pendingPermissions, setPendingPermissions] = useState<Array<{
    requestId: string
    toolName: string
    toolInput: Record<string, unknown>
    agentId: string
  }>>([])
  const [thinking, setThinking] = useState<Record<string, string>>({})
  const [toolCalls, setToolCalls] = useState<ToolCall[]>([])
  const abortRef = useRef<AbortController | null>(null)

  const loadMessages = useCallback(async () => {
    if (!sessionId) return
    const res = await fetch(`/api/sessions/${sessionId}/messages`)
    const data = await res.json()
    setMessages(data)
  }, [sessionId])

  const send = useCallback(async (content: string, mentionAll?: boolean, targetAgent?: string, replyToId?: string, regenerate?: string, attachmentIds?: string[]) => {
    if (!sessionId || (!content.trim() && !regenerate && (!attachmentIds || attachmentIds.length === 0))) return

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
        body: JSON.stringify({ message: content, mentionAll, targetAgent, replyToId, regenerate, attachmentIds }),
        signal: controller.signal,
      })

      if (!res.ok) {
        let errorMsg = `请求失败 (${res.status})`
        try {
          const errData = await res.json()
          if (errData.error) errorMsg = errData.error
        } catch {}
        setMessages(prev => [...prev, {
          id: crypto.randomUUID(),
          role: 'orchestrator',
          rawContent: `Error: ${errorMsg}`,
          createdAt: new Date().toISOString(),
        }])
        return
      }

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
          let event: SSEEvent
          try {
            event = JSON.parse(line.slice(6))
          } catch {
            console.warn('SSE parse failed:', line.slice(6, 100))
            continue
          }

          if (event.type === 'done') {
            if (event.messageId) {
              // Regenerate: replace existing message
              setMessages(prev => prev.map(m =>
                m.id === event.messageId ? { ...m, rawContent: event.content } : m
              ))
            } else {
              // New message: add to messages list
              setMessages(prev => [...prev, {
                id: crypto.randomUUID(),
                role: event.agentId === 'orchestrator' ? 'orchestrator' : 'agent',
                rawContent: event.content,
                agentId: event.agentId === 'orchestrator' ? undefined : event.agentId,
                createdAt: new Date().toISOString(),
              }])
            }
            // Clear streaming, thinking, and toolCalls
            setStreaming(prev => { const next = { ...prev }; delete next[event.agentId]; return next })
            setThinking(prev => { const next = { ...prev }; delete next[event.agentId]; return next })
            setToolCalls(prev => prev.filter(tc => tc.agentId !== event.agentId))
          } else if (event.type === 'error') {
            setMessages(prev => [...prev, {
              id: crypto.randomUUID(),
              role: 'orchestrator',
              rawContent: event.content,
              createdAt: new Date().toISOString(),
            }])
            // 清除 streaming 状态，防止后续 text chunk 拼接到旧内容上
            setStreaming(prev => { const next = { ...prev }; delete next[event.agentId]; return next })
            setThinking(prev => { const next = { ...prev }; delete next[event.agentId]; return next })
            setToolCalls(prev => prev.filter(tc => tc.agentId !== event.agentId))
          } else if (event.type === 'awaiting_user_input') {
            setAwaitingInput(event.content)
            setStreaming({})
            setLoading(false)
          } else if (event.type === 'phase_transition') {
            setPhase(event.content)
            setAwaitingInput(null)
          } else if (event.type === 'task_status') {
            // Task status updates are handled by the agent panel polling
          } else if (event.type === 'session') {
            // CLI session ID - don't display, just ignore
          } else if (event.type === 'permission_request') {
            setPendingPermissions(prev => [...prev, {
              requestId: event.data?.requestId || '',
              toolName: event.data?.toolName || '',
              toolInput: event.data?.toolInput || {},
              agentId: event.agentId,
            }])
          } else if (event.type === 'permission_cancel') {
            setPendingPermissions(prev => prev.filter(p => p.requestId !== event.data?.requestId))
          } else if (event.type === 'thinking') {
            // 思考过程：累积到 thinking 状态
            setThinking(prev => ({
              ...prev,
              [event.agentId]: (prev[event.agentId] || '') + event.content,
            }))
          } else if (event.type === 'tool_use') {
            // 工具调用：添加到 toolCalls 列表
            const toolCall: ToolCall = {
              id: crypto.randomUUID(),
              agentId: event.agentId,
              toolName: event.data?.toolName || 'unknown',
              toolInput: event.data?.toolInput || {},
              status: 'running',
            }
            setToolCalls(prev => [...prev, toolCall])
          } else if (event.type === 'tool_result') {
            // 工具结果：更新最后一个匹配的 toolCall
            setToolCalls(prev => {
              const updated = [...prev]
              // 找到最后一个同 agent 的 running 状态的 toolCall
              for (let i = updated.length - 1; i >= 0; i--) {
                if (updated[i].agentId === event.agentId && updated[i].status === 'running') {
                  updated[i] = { ...updated[i], toolResult: event.content, status: 'completed' }
                  break
                }
              }
              return updated
            })
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
        setMessages(prev => [...prev, {
          id: crypto.randomUUID(),
          role: 'orchestrator',
          rawContent: `Error: 网络请求失败，请检查连接后重试。(${(err as Error).message || 'Unknown error'})`,
          createdAt: new Date().toISOString(),
        }])
      }
    } finally {
      setLoading(false)
      abortRef.current = null
    }
  }, [sessionId])

  const stop = useCallback(() => {
    abortRef.current?.abort()
  }, [])

  const respondPermission = useCallback(async (requestId: string, behavior: 'allow' | 'deny') => {
    if (!sessionId) return
    const target = pendingPermissions.find(p => p.requestId === requestId)
    if (!target) return
    await fetch(`/api/sessions/${sessionId}/permission`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requestId,
        behavior,
        agentId: target.agentId,
      }),
    })
    setPendingPermissions(prev => prev.filter(p => p.requestId !== requestId))
  }, [sessionId, pendingPermissions])

  return { messages, streaming, loading, send, stop, loadMessages, phase, awaitingInput, pendingPermissions, respondPermission, thinking, toolCalls }
}
