"use client"

import { useState, useEffect } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { Plus, Bot, Clock } from "lucide-react"
import { Button } from "@/components/ui/button"

interface Session {
  id: string
  title: string
  type: string
  phase: string
  projectDir: string
  updatedAt: string
  _count: { messages: number; members: number }
}

const phaseLabels: Record<string, string> = {
  idle: "空闲",
  alignment: "对齐中",
  execution: "执行中",
  done: "已完成",
}

const phaseColors: Record<string, string> = {
  idle: "bg-gray-100 text-gray-700",
  alignment: "bg-yellow-100 text-yellow-700",
  execution: "bg-green-100 text-green-700",
  done: "bg-blue-100 text-blue-700",
}

export default function ProjectsPage() {
  const router = useRouter()
  const [sessions, setSessions] = useState<Session[]>([])

  useEffect(() => {
    fetch("/api/sessions")
      .then(r => r.json())
      .then(data => { if (Array.isArray(data)) setSessions(data) })
  }, [])

  const handleCreateProject = async () => {
    const res = await fetch("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "新项目", type: "group" }),
    })
    if (res.ok) {
      const session = await res.json()
      router.push(`/chat?session=${session.id}`)
    }
  }

  return (
    <div className="flex flex-1 flex-col gap-6 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">项目</h1>
          <p className="text-sm text-muted-foreground mt-1">管理你的多智能体协作项目</p>
        </div>
        <Button size="sm" className="gap-1" onClick={handleCreateProject}>
          <Plus className="h-4 w-4" /> 创建项目
        </Button>
      </div>

      {sessions.length === 0 ? (
        <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">
          暂无项目，点击"创建项目"开始
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {sessions.map((session) => (
            <Link
              key={session.id}
              href={`/projects/${session.id}`}
              className="rounded-lg border bg-card p-4 hover:bg-accent transition-colors group"
            >
              <div className="flex items-start justify-between mb-2">
                <h3 className="font-medium text-sm group-hover:underline">{session.title}</h3>
                <span className={`text-xs px-2 py-0.5 rounded-full ${phaseColors[session.phase] || "bg-gray-100 text-gray-700"}`}>
                  {phaseLabels[session.phase] || session.phase}
                </span>
              </div>
              <p className="text-xs text-muted-foreground mb-3 line-clamp-2">
                {session.projectDir || (session.type === "private" ? "私聊" : "群聊")}
              </p>
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <div className="flex items-center gap-1">
                  <Bot className="h-3 w-3" />
                  {session._count.members} 智能体
                </div>
                <div className="flex items-center gap-1">
                  <Clock className="h-3 w-3" />
                  {new Date(session.updatedAt).toLocaleDateString()}
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}
