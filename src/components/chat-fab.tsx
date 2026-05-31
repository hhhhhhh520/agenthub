'use client'

import { useState, useRef, useEffect } from 'react'
import { MessageSquare, X, Send, Plus, Minimize2, Shield, Loader2 } from 'lucide-react'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Button } from '@/components/ui/button'
import { useChatFab } from '@/lib/hooks/use-chat-fab'

const STARTER_PROMPTS = [
  '按优先级列出我未完成的任务',
  '总结一下我今天做了什么',
  '规划接下来该做什么',
]

export function ChatFab() {
  const {
    agents,
    agentNameMap,
    selectedAgent,
    selectAgent,
    resetChat,
    messages,
    streaming,
    loading,
    send,
    stop,
    pendingPermissions,
    respondPermission,
    projectDir,
  } = useChatFab()

  const [isOpen, setIsOpen] = useState(false)
  const [isMinimized, setIsMinimized] = useState(false)
  const [showAgentPicker, setShowAgentPicker] = useState(false)
  const [input, setInput] = useState('')
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, streaming])

  const handleSend = (text?: string) => {
    const content = text || input.trim()
    if (!content || !selectedAgent) return
    send(content)
    setInput('')
  }

  const handleNewChat = () => {
    resetChat()
    setShowAgentPicker(false)
  }

  const handlePickPrompt = (prompt: string) => {
    handleSend(prompt)
  }

  const handleSelectAgent = async (agent: typeof agents[0]) => {
    await selectAgent(agent)
    setShowAgentPicker(false)
  }

  // 收起状态：只显示浮动按钮
  if (!isOpen) {
    return (
      <button
        onClick={() => { setIsOpen(true) }}
        className="fixed bottom-6 right-6 z-50 flex h-14 w-14 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg hover:bg-primary/90 transition-all hover:scale-105"
      >
        <MessageSquare className="h-6 w-6" />
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
              {selectedAgent ? (
                <>
                  <div
                    className="h-3 w-3 rounded-full"
                    style={{ backgroundColor: selectedAgent.accentColor }}
                  />
                  <span className="text-sm font-medium">{selectedAgent.name}</span>
                </>
              ) : (
                <span className="text-sm text-muted-foreground">选择 Agent</span>
              )}
            </button>
            {/* Agent Picker Dropdown */}
            {showAgentPicker && (
              <div className="absolute top-full left-0 mt-1 w-56 rounded-lg border bg-card shadow-lg z-10">
                {agents.length === 0 ? (
                  <div className="px-3 py-2 text-sm text-muted-foreground">暂无可用 Agent</div>
                ) : (
                  agents.map(agent => (
                    <button
                      key={agent.id}
                      onClick={() => handleSelectAgent(agent)}
                      className="flex w-full items-center gap-2 px-3 py-2 text-sm hover:bg-accent transition-colors first:rounded-t-lg last:rounded-b-lg"
                    >
                      <div
                        className="h-2.5 w-2.5 rounded-full"
                        style={{ backgroundColor: agent.accentColor }}
                      />
                      <span>{agent.name}</span>
                      <span className="ml-auto text-xs text-muted-foreground truncate">{agent.expertise}</span>
                    </button>
                  ))
                )}
                {!projectDir && (
                  <div className="border-t px-3 py-2 text-xs text-amber-600 bg-amber-50">
                    建议先在主页面设置工作目录
                  </div>
                )}
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
            {!selectedAgent ? (
              /* Agent Picker */
              <div className="flex flex-col items-center justify-center h-full py-8">
                <h3 className="text-lg font-semibold mb-4">选择 Agent 开始对话</h3>
                <div className="w-full space-y-2">
                  {agents.map(agent => (
                    <button
                      key={agent.id}
                      onClick={() => handleSelectAgent(agent)}
                      className="w-full flex items-center gap-3 rounded-lg border bg-card px-3 py-3 text-left hover:bg-accent transition-colors"
                    >
                      <Avatar className="h-8 w-8 shrink-0">
                        <AvatarFallback
                          className="text-sm font-bold text-white"
                          style={{ backgroundColor: agent.accentColor }}
                        >
                          {agent.name[0]}
                        </AvatarFallback>
                      </Avatar>
                      <div>
                        <div className="text-sm font-medium">{agent.name}</div>
                        <div className="text-xs text-muted-foreground">{agent.expertise}</div>
                      </div>
                    </button>
                  ))}
                </div>
                {!projectDir && (
                  <p className="mt-4 text-xs text-amber-600 text-center">
                    建议先在主页面设置工作目录，Agent 将在该目录下工作
                  </p>
                )}
              </div>
            ) : messages.length === 0 ? (
              /* Empty State */
              <div className="flex flex-col items-center justify-center h-full py-8">
                <Avatar className="h-16 w-16 mb-4">
                  <AvatarFallback
                    className="text-lg font-bold text-white"
                    style={{ backgroundColor: selectedAgent.accentColor }}
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
                {messages.map(msg => {
                  const agent = msg.agentId ? agentNameMap.get(msg.agentId) : null
                  return (
                    <div
                      key={msg.id}
                      className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
                    >
                      <div className={`flex items-start gap-2 max-w-[85%] ${msg.role === 'user' ? 'flex-row-reverse' : ''}`}>
                        {msg.role !== 'user' && (
                          <Avatar className="h-6 w-6 mt-0.5 shrink-0">
                            <AvatarFallback
                              className="text-[10px] font-bold text-white"
                              style={{ backgroundColor: agent?.accentColor || '#6366f1' }}
                            >
                              {agent?.name?.[0] || '?'}
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
                          {msg.rawContent}
                        </div>
                      </div>
                    </div>
                  )
                })}
                {/* Streaming messages */}
                {Object.entries(streaming).map(([agentId, content]) => {
                  const agent = agentNameMap.get(agentId)
                  return (
                    <div key={agentId} className="flex justify-start">
                      <div className="flex items-start gap-2 max-w-[85%]">
                        <Avatar className="h-6 w-6 mt-0.5 shrink-0">
                          <AvatarFallback
                            className="text-[10px] font-bold text-white"
                            style={{ backgroundColor: agent?.accentColor || '#6366f1' }}
                          >
                            {agent?.name?.[0] || '?'}
                          </AvatarFallback>
                        </Avatar>
                        <div className="rounded-lg px-3 py-2 text-sm bg-muted">
                          {content}
                          <span className="inline-block w-1.5 h-3.5 ml-0.5 bg-foreground/50 animate-pulse" />
                        </div>
                      </div>
                    </div>
                  )
                })}
                {/* Loading indicator */}
                {loading && Object.keys(streaming).length === 0 && (
                  <div className="flex justify-start">
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                      <Loader2 className="h-4 w-4 animate-spin" />
                      <span>思考中...</span>
                    </div>
                  </div>
                )}
                <div ref={bottomRef} />
              </div>
            )}
          </ScrollArea>

          {/* Permission bar */}
          {pendingPermissions.length > 0 && pendingPermissions.map(p => (
            <div key={p.requestId} className="border-t px-3 py-2 text-sm bg-amber-50 text-amber-800 flex items-center justify-between">
              <span className="flex items-center gap-1 min-w-0">
                <Shield className="w-4 h-4 shrink-0" />
                <span className="truncate">
                  请求使用 <strong>{p.toolName}</strong>
                  {p.toolName === 'Bash' && !!p.toolInput?.command && (
                    <code className="ml-1 text-xs bg-amber-100 px-1 rounded">
                      {String(p.toolInput.command).slice(0, 40)}
                    </code>
                  )}
                </span>
              </span>
              <div className="flex gap-1 shrink-0 ml-2">
                <Button size="xs" variant="destructive" onClick={() => respondPermission(p.requestId, 'deny')}>拒绝</Button>
                <Button size="xs" onClick={() => respondPermission(p.requestId, 'allow')}>允许</Button>
              </div>
            </div>
          ))}

          {/* Input */}
          <div className="border-t p-3">
            <div className="flex gap-2">
              <input
                type="text"
                value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && !e.shiftKey && handleSend()}
                placeholder={selectedAgent ? `和${selectedAgent.name}对话...` : '请先选择 Agent'}
                disabled={!selectedAgent}
                className="flex-1 rounded-lg border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary/20 disabled:opacity-50"
              />
              {loading ? (
                <button
                  onClick={stop}
                  className="flex h-9 w-9 items-center justify-center rounded-lg bg-destructive text-destructive-foreground hover:bg-destructive/90 transition-colors"
                >
                  <span className="text-xs font-medium">停</span>
                </button>
              ) : (
                <button
                  onClick={() => handleSend()}
                  disabled={!input.trim() || !selectedAgent}
                  className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary text-primary-foreground disabled:opacity-50 hover:bg-primary/90 transition-colors"
                >
                  <Send className="h-4 w-4" />
                </button>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  )
}
