'use client'
import { useEffect, useRef, useState } from 'react'
import { useChat } from '@/lib/hooks/use-chat'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'

const ROLE_STYLES: Record<string, { bg: string; label: string }> = {
  user: { bg: 'bg-blue-500 text-white ml-auto', label: 'You' },
  orchestrator: { bg: 'bg-purple-100 text-purple-900', label: 'Orchestrator' },
  agent: { bg: 'bg-gray-100 text-gray-900', label: 'Agent' },
}

export function ChatArea({ sessionId }: { sessionId: string | null }) {
  const { messages, streaming, loading, send, stop, loadMessages } = useChat(sessionId)
  const [input, setInput] = useState('')
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => { if (sessionId) loadMessages() }, [sessionId, loadMessages])
  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [messages, streaming])

  if (!sessionId) {
    return <div className="flex-1 flex items-center justify-center text-gray-400">选择或创建一个会话</div>
  }

  const handleSend = () => {
    const mentionAll = input.includes('@所有人')
    send(input, mentionAll)
    setInput('')
  }

  return (
    <div className="flex-1 flex flex-col">
      <ScrollArea className="flex-1 p-4">
        <div className="space-y-3 max-w-3xl mx-auto">
          {messages.map(msg => {
            const style = ROLE_STYLES[msg.role] || ROLE_STYLES.agent
            return (
              <div key={msg.id} className={`max-w-[80%] rounded-lg p-3 ${msg.role === 'user' ? style.bg + ' ml-auto' : style.bg}`}>
                <div className="text-xs font-medium mb-1 opacity-70">
                  {msg.role === 'agent' ? msg.agentId : style.label}
                </div>
                <div className="text-sm whitespace-pre-wrap">{msg.content}</div>
              </div>
            )
          })}
          {Object.entries(streaming).map(([agentId, text]) => (
            <div key={agentId} className="max-w-[80%] rounded-lg p-3 bg-gray-100">
              <div className="text-xs font-medium mb-1 opacity-70">{agentId}</div>
              <div className="text-sm whitespace-pre-wrap">{text}<span className="animate-pulse">|</span></div>
            </div>
          ))}
          <div ref={bottomRef} />
        </div>
      </ScrollArea>
      <div className="border-t p-3 flex gap-2">
        <Input
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && !e.shiftKey && handleSend()}
          placeholder="输入消息... (@Agent名 指定执行，@所有人 讨论)"
          disabled={loading}
        />
        {loading ? (
          <Button onClick={stop} variant="destructive" size="sm">停止</Button>
        ) : (
          <Button onClick={handleSend} disabled={!input.trim()} size="sm">发送</Button>
        )}
      </div>
    </div>
  )
}
