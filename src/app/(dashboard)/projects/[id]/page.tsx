"use client"

import { useState, useEffect, useRef } from "react"
import { useParams } from "next/navigation"
import { ArrowLeft, Bot, Plus, Send } from "lucide-react"
import Link from "next/link"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"

interface Session {
  id: string
  title: string
  type: string
  phase: string
  _count: { messages: number; members: number }
}

interface Message {
  id: string
  role: string
  rawContent: string
  agentId?: string
  createdAt: string
}

interface Task {
  id: string
  description: string
  status: string
  assignedAgentId?: string
}

interface Agent {
  id: string
  name: string
  accentColor: string
  status: string
}

const taskStatusIcons: Record<string, string> = {
  completed: "✅",
  in_progress: "🔄",
  pending: "⬜",
  failed: "❌",
  blocked: "⏸",
}

const agentStatusDot: Record<string, string> = {
  working: "bg-green-500",
  idle: "bg-gray-400",
  done: "bg-blue-500",
  error: "bg-red-500",
}

const phaseLabels: Record<string, string> = {
  idle: "空闲",
  alignment: "对齐中",
  execution: "执行中",
  done: "已完成",
}

export default function ProjectDetailPage() {
  const params = useParams()
  const sessionId = params.id as string

  const [session, setSession] = useState<Session | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [tasks, setTasks] = useState<Task[]>([])
  const [agents, setAgents] = useState<Agent[]>([])
  const [input, setInput] = useState("")
  const [sending, setSending] = useState(false)
  const messagesEndRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!sessionId) return
    fetch(`/api/sessions/${sessionId}`).then(r => r.json()).then(setSession)
    fetch(`/api/sessions/${sessionId}/messages`).then(r => r.json()).then(data => { if (Array.isArray(data)) setMessages(data) })
    fetch(`/api/sessions/${sessionId}/tasks`).then(r => r.json()).then(data => { if (Array.isArray(data)) setTasks(data) })
    fetch(`/api/sessions/${sessionId}/agents`).then(r => r.json()).then(data => { if (Array.isArray(data)) setAgents(data) })
  }, [sessionId])

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" })
  }, [messages])

  const agentMap = Object.fromEntries(agents.map(a => [a.id, a]))

  const handleSend = async () => {
    if (!input.trim() || sending) return
    const content = input
    setInput("")
    setSending(true)

    const userMsg: Message = {
      id: crypto.randomUUID(),
      role: "user",
      rawContent: content,
      createdAt: new Date().toISOString(),
    }
    setMessages(prev => [...prev, userMsg])

    try {
      const res = await fetch(`/api/sessions/${sessionId}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: content }),
      })

      const reader = res.body?.getReader()
      if (!reader) return

      const decoder = new TextDecoder()
      let buffer = ""

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split("\n\n")
        buffer = lines.pop() || ""

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue
          try {
            const event = JSON.parse(line.slice(6))
            if (event.type === "done") {
              setMessages(prev => [...prev, {
                id: crypto.randomUUID(),
                role: event.agentId === "orchestrator" ? "orchestrator" : "agent",
                rawContent: event.content,
                agentId: event.agentId === "orchestrator" ? undefined : event.agentId,
                createdAt: new Date().toISOString(),
              }])
            }
          } catch {}
        }
      }
    } catch (err) {
      console.error("Chat error:", err)
    } finally {
      setSending(false)
    }
  }

  if (!session) {
    return <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">加载中...</div>
  }

  return (
    <div className="flex flex-1 flex-col h-svh">
      {/* Header */}
      <div className="flex items-center gap-3 border-b px-4 py-3 shrink-0">
        <Link href="/projects" className="text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-4 w-4" />
        </Link>
        <h1 className="font-semibold text-sm flex-1">{session.title}</h1>
        <Badge variant="outline" className="text-xs">{phaseLabels[session.phase] || session.phase}</Badge>
        <span className="text-xs text-muted-foreground">{session._count.messages} 条消息</span>
      </div>

      {/* Three-column layout */}
      <div className="flex flex-1 min-h-0">
        {/* Messages sidebar */}
        <div className="w-72 border-r flex flex-col">
          <div className="p-3 border-b text-xs font-medium text-muted-foreground">消息 ({messages.length})</div>
          <ScrollArea className="flex-1">
            <div className="p-2 space-y-1">
              {messages.map((msg) => {
                const agent = msg.agentId ? agentMap[msg.agentId] : null
                const senderName = msg.role === "user" ? "你" : msg.role === "orchestrator" ? "Orchestrator" : agent?.name || "Agent"
                return (
                  <div key={msg.id} className="p-2 rounded text-sm hover:bg-accent cursor-pointer">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="font-medium text-xs">{senderName}</span>
                      <span className="text-xs text-muted-foreground ml-auto">
                        {new Date(msg.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                      </span>
                    </div>
                    <p className="text-xs text-muted-foreground line-clamp-2">
                      {msg.rawContent.replace(/```[\s\S]*?```/g, "[代码块]")}
                    </p>
                  </div>
                )
              })}
            </div>
          </ScrollArea>
        </div>

        {/* Chat area */}
        <div className="flex-1 flex flex-col">
          <ScrollArea className="flex-1 p-4">
            <div className="space-y-4 max-w-3xl mx-auto">
              {messages.length === 0 && (
                <div className="text-center text-muted-foreground text-sm py-12">暂无消息</div>
              )}
              {messages.map((msg) => {
                const agent = msg.agentId ? agentMap[msg.agentId] : null
                const senderName = msg.role === "user" ? "你" : msg.role === "orchestrator" ? "Orchestrator" : agent?.name || "Agent"
                const color = msg.role === "user" ? "#6366f1" : agent?.accentColor || "#f59e0b"
                return (
                  <div key={msg.id} className="flex gap-3">
                    <Avatar className="h-8 w-8 shrink-0">
                      <AvatarFallback className="text-xs text-white" style={{ backgroundColor: color }}>
                        {senderName.charAt(0)}
                      </AvatarFallback>
                    </Avatar>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="font-medium text-sm">{senderName}</span>
                        <span className="text-xs text-muted-foreground">
                          {new Date(msg.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                        </span>
                      </div>
                      <div className="text-sm whitespace-pre-wrap break-words bg-accent/50 rounded-lg p-3">
                        {msg.rawContent}
                      </div>
                    </div>
                  </div>
                )
              })}
              <div ref={messagesEndRef} />
            </div>
          </ScrollArea>

          {/* Input */}
          <div className="border-t p-3 shrink-0">
            <div className="flex gap-2">
              <input
                type="text"
                value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={e => e.key === "Enter" && handleSend()}
                placeholder={sending ? "等待回复中..." : "输入消息... (@ 提及智能体)"}
                disabled={sending}
                className="flex-1 h-9 rounded-md border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring disabled:opacity-50"
              />
              <Button size="sm" onClick={handleSend} disabled={sending || !input.trim()}>
                <Send className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>
        </div>

        {/* Agent & Task panel */}
        <div className="w-64 border-l flex flex-col">
          {/* Agents */}
          <div className="p-3 border-b text-xs font-medium text-muted-foreground">智能体 ({agents.length})</div>
          <div className="p-2 space-y-1 border-b">
            {agents.length === 0 && (
              <div className="p-2 text-xs text-muted-foreground">暂无智能体</div>
            )}
            {agents.map((agent) => (
              <div key={agent.id} className="flex items-center gap-2 p-2 rounded hover:bg-accent">
                <Avatar className="h-6 w-6">
                  <AvatarFallback
                    className="text-xs text-white"
                    style={{ backgroundColor: agent.accentColor }}
                  >
                    {agent.name.charAt(0)}
                  </AvatarFallback>
                </Avatar>
                <span className="text-xs font-medium flex-1">{agent.name}</span>
                <span className={`h-2 w-2 rounded-full ${agentStatusDot[agent.status] || "bg-gray-400"}`} />
              </div>
            ))}
          </div>

          {/* Tasks */}
          <div className="p-3 border-b text-xs font-medium text-muted-foreground">任务 ({tasks.length})</div>
          <ScrollArea className="flex-1">
            <div className="p-2 space-y-1">
              {tasks.length === 0 && (
                <div className="p-2 text-xs text-muted-foreground">暂无任务</div>
              )}
              {tasks.map((task) => {
                const agent = task.assignedAgentId ? agentMap[task.assignedAgentId] : null
                return (
                  <div key={task.id} className="p-2 rounded text-xs hover:bg-accent">
                    <div className="flex items-center gap-2">
                      <span>{taskStatusIcons[task.status] || task.status}</span>
                      <span className="flex-1">{task.description}</span>
                    </div>
                    {agent && (
                      <div className="flex items-center gap-1 mt-1 text-muted-foreground">
                        <Bot className="h-3 w-3" />
                        {agent.name}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </ScrollArea>
        </div>
      </div>
    </div>
  )
}