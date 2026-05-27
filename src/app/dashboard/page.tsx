"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import { FolderKanban, Bot, Sparkles, ArrowRight } from "lucide-react"

interface Session {
  id: string
  title: string
  updatedAt: string
  _count: { messages: number; members: number }
}

export default function WorkspacePage() {
  const [agentCount, setAgentCount] = useState(0)
  const [sessions, setSessions] = useState<Session[]>([])

  useEffect(() => {
    fetch('/api/agents').then(r => r.json()).then(d => setAgentCount(Array.isArray(d) ? d.length : 0))
    fetch('/api/sessions').then(r => r.json()).then(setSessions)
  }, [])

  return (
    <div className="flex flex-1 flex-col gap-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold">工作区</h1>
        <p className="text-sm text-muted-foreground mt-1">概览你的项目和智能体活动</p>
      </div>

      {/* Stats cards */}
      <div className="grid grid-cols-3 gap-4">
        <Link
          href="/dashboard/projects"
          className="rounded-lg border bg-card p-4 hover:bg-accent transition-colors"
        >
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-md bg-blue-100 text-blue-700">
              <FolderKanban className="h-5 w-5" />
            </div>
            <div>
              <p className="text-2xl font-semibold">{sessions.length}</p>
              <p className="text-xs text-muted-foreground">会话</p>
            </div>
          </div>
        </Link>

        <Link
          href="/dashboard/agents"
          className="rounded-lg border bg-card p-4 hover:bg-accent transition-colors"
        >
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-md bg-green-100 text-green-700">
              <Bot className="h-5 w-5" />
            </div>
            <div>
              <p className="text-2xl font-semibold">{agentCount}</p>
              <p className="text-xs text-muted-foreground">智能体</p>
            </div>
          </div>
        </Link>

        <Link
          href="/dashboard/skills"
          className="rounded-lg border bg-card p-4 hover:bg-accent transition-colors"
        >
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-md bg-purple-100 text-purple-700">
              <Sparkles className="h-5 w-5" />
            </div>
            <div>
              <p className="text-2xl font-semibold">-</p>
              <p className="text-xs text-muted-foreground">Skill</p>
            </div>
          </div>
        </Link>
      </div>

      {/* Recent sessions */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-medium">最近会话</h2>
          <Link href="/dashboard/projects" className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1">
            查看全部 <ArrowRight className="h-3 w-3" />
          </Link>
        </div>
        <div className="space-y-2">
          {sessions.slice(0, 5).map((session) => (
            <Link
              key={session.id}
              href={`/dashboard/projects/${session.id}`}
              className="flex items-center justify-between rounded-lg border bg-card p-3 hover:bg-accent transition-colors"
            >
              <div>
                <p className="text-sm font-medium">{session.title}</p>
                <p className="text-xs text-muted-foreground">{new Date(session.updatedAt).toLocaleDateString()}</p>
              </div>
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Bot className="h-3 w-3" />
                {session._count.members} 智能体
              </div>
            </Link>
          ))}
          {sessions.length === 0 && (
            <p className="text-sm text-muted-foreground py-4 text-center">暂无会话</p>
          )}
        </div>
      </div>
    </div>
  )
}
