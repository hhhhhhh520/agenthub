'use client'

import { useState, useRef, useEffect } from 'react'
import { MessageSquare, X, Send, Plus, Minimize2 } from 'lucide-react'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { ScrollArea } from '@/components/ui/scroll-area'

// Mock 数据
const MOCK_AGENTS = [
  { id: '1', name: '前端工程师', color: '#3b82f6', expertise: 'React、TypeScript、CSS' },
  { id: '2', name: '后端工程师', color: '#10b981', expertise: 'Node.js、API 设计、数据库' },
  { id: '3', name: '产品经理', color: '#f59e0b', expertise: '需求分析、PRD、用户故事' },
  { id: '4', name: '架构师', color: '#8b5cf6', expertise: '系统设计、技术选型' },
  { id: '5', name: '测试工程师', color: '#ef4444', expertise: '单元测试、E2E 测试' },
]

const STARTER_PROMPTS = [
  '按优先级列出我未完成的任务',
  '总结一下我今天做了什么',
  '规划接下来该做什么',
]

interface Message {
  id: string
  role: 'user' | 'agent'
  content: string
  agentName?: string
  agentColor?: string
  timestamp: Date
}

export function ChatFab() {
  const [isOpen, setIsOpen] = useState(false)
  const [isMinimized, setIsMinimized] = useState(false)
  const [selectedAgent, setSelectedAgent] = useState(MOCK_AGENTS[0])
  const [showAgentPicker, setShowAgentPicker] = useState(false)
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [unread, setUnread] = useState(0)
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  const handleSend = (text?: string) => {
    const content = text || input.trim()
    if (!content) return

    const userMsg: Message = {
      id: Date.now().toString(),
      role: 'user',
      content,
      timestamp: new Date(),
    }
    setMessages(prev => [...prev, userMsg])
    setInput('')

    // Mock 回复
    setTimeout(() => {
      const agentMsg: Message = {
        id: (Date.now() + 1).toString(),
        role: 'agent',
        content: `收到！我是${selectedAgent.name}，正在处理你的请求：「${content}」`,
        agentName: selectedAgent.name,
        agentColor: selectedAgent.color,
        timestamp: new Date(),
      }
      setMessages(prev => [...prev, agentMsg])
      if (!isOpen) setUnread(prev => prev + 1)
    }, 1000)
  }

  const handleNewChat = () => {
    setMessages([])
    setShowAgentPicker(false)
  }

  const handlePickPrompt = (prompt: string) => {
    handleSend(prompt)
  }

  // 收起状态：只显示浮动按钮
  if (!isOpen) {
    return (
      <button
        onClick={() => { setIsOpen(true); setUnread(0) }}
        className="fixed bottom-6 right-6 z-50 flex h-14 w-14 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg hover:bg-primary/90 transition-all hover:scale-105"
      >
        <MessageSquare className="h-6 w-6" />
        {unread > 0 && (
          <span className="absolute -top-1 -right-1 flex h-5 w-5 items-center justify-center rounded-full bg-red-500 text-[10px] text-white font-bold">
            {unread}
          </span>
        )}
      </button>
    )
  }

  // 展开状态：聊天卡片
  return (
    <div className="fixed bottom-6 right-6 z-50 flex w-[380px] h-[520px] flex-col rounded-xl border bg-card shadow-2xl overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between border-b px-4 py-3">
        <div className="flex items-center gap-2">
          <button
            onClick={handleNewChat}
            className="flex h-7 w-7 items-center justify-center rounded-md border hover:bg-accent transition-colors"
            title="新对话"
          >
            <Plus className="h-4 w-4" />
          </button>
          <div className="relative">
            <button
              onClick={() => setShowAgentPicker(!showAgentPicker)}
              className="flex items-center gap-2 rounded-md px-2 py-1 hover:bg-accent transition-colors"
            >
              <div
                className="h-3 w-3 rounded-full"
                style={{ backgroundColor: selectedAgent.color }}
              />
              <span className="text-sm font-medium">{selectedAgent.name}</span>
            </button>
            {/* Agent Picker Dropdown */}
            {showAgentPicker && (
              <div className="absolute top-full left-0 mt-1 w-48 rounded-lg border bg-card shadow-lg z-10">
                {MOCK_AGENTS.map(agent => (
                  <button
                    key={agent.id}
                    onClick={() => {
                      setSelectedAgent(agent)
                      setShowAgentPicker(false)
                    }}
                    className="flex w-full items-center gap-2 px-3 py-2 text-sm hover:bg-accent transition-colors first:rounded-t-lg last:rounded-b-lg"
                  >
                    <div
                      className="h-2.5 w-2.5 rounded-full"
                      style={{ backgroundColor: agent.color }}
                    />
                    <span>{agent.name}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => setIsMinimized(!isMinimized)}
            className="flex h-7 w-7 items-center justify-center rounded-md hover:bg-accent transition-colors"
          >
            <Minimize2 className="h-4 w-4" />
          </button>
          <button
            onClick={() => { setIsOpen(false); setIsMinimized(false) }}
            className="flex h-7 w-7 items-center justify-center rounded-md hover:bg-accent transition-colors"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* Body */}
      {!isMinimized && (
        <>
          <ScrollArea className="flex-1 px-4 py-3">
            {messages.length === 0 ? (
              /* Empty State */
              <div className="flex flex-col items-center justify-center h-full py-8">
                <Avatar className="h-16 w-16 mb-4">
                  <AvatarFallback
                    className="text-lg font-bold text-white"
                    style={{ backgroundColor: selectedAgent.color }}
                  >
                    {selectedAgent.name[0]}
                  </AvatarFallback>
                </Avatar>
                <h3 className="text-lg font-semibold mb-1">你好，我是{selectedAgent.name}</h3>
                <p className="text-sm text-muted-foreground mb-6">{selectedAgent.expertise}</p>
                <div className="w-full space-y-2">
                  {STARTER_PROMPTS.map((prompt, i) => (
                    <button
                      key={i}
                      onClick={() => handlePickPrompt(prompt)}
                      className="w-full rounded-lg border bg-card px-3 py-2.5 text-left text-sm hover:bg-accent transition-colors"
                    >
                      {prompt}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              /* Message List */
              <div className="space-y-4">
                {messages.map(msg => (
                  <div
                    key={msg.id}
                    className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
                  >
                    <div className={`flex items-start gap-2 max-w-[85%] ${msg.role === 'user' ? 'flex-row-reverse' : ''}`}>
                      {msg.role === 'agent' && (
                        <Avatar className="h-6 w-6 mt-0.5 shrink-0">
                          <AvatarFallback
                            className="text-[10px] font-bold text-white"
                            style={{ backgroundColor: msg.agentColor }}
                          >
                            {msg.agentName?.[0]}
                          </AvatarFallback>
                        </Avatar>
                      )}
                      <div
                        className={`rounded-lg px-3 py-2 text-sm ${
                          msg.role === 'user'
                            ? 'bg-primary text-primary-foreground'
                            : 'bg-muted'
                        }`}
                      >
                        {msg.content}
                      </div>
                    </div>
                  </div>
                ))}
                <div ref={bottomRef} />
              </div>
            )}
          </ScrollArea>

          {/* Input */}
          <div className="border-t p-3">
            <div className="flex gap-2">
              <input
                type="text"
                value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleSend()}
                placeholder={`和${selectedAgent.name}对话...`}
                className="flex-1 rounded-lg border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary/20"
              />
              <button
                onClick={() => handleSend()}
                disabled={!input.trim()}
                className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary text-primary-foreground disabled:opacity-50 hover:bg-primary/90 transition-colors"
              >
                <Send className="h-4 w-4" />
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
