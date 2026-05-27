"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { FolderKanban, Bot, Sparkles, ArrowRight, MessageSquare, Plus, Play } from "lucide-react"
import { SetupWizard } from "@/components/setup-wizard"
import { CreateGroupDialog } from "@/components/create-group-dialog"

interface Session {
  id: string
  title: string
  updatedAt: string
  _count: { messages: number; members: number }
}

export default function WorkspacePage() {
  const router = useRouter()
  const [agentCount, setAgentCount] = useState(0)
  const [sessions, setSessions] = useState<Session[]>([])
  const [showSetup, setShowSetup] = useState(false)
  const [setupChecked, setSetupChecked] = useState(false)
  const [showCreateGroup, setShowCreateGroup] = useState(false)

  useEffect(() => {
    fetch('/api/agents').then(r => r.json()).then(d => setAgentCount(Array.isArray(d) ? d.length : 0))
    fetch('/api/sessions').then(r => r.json()).then(setSessions)
  }, [])

  // 首次设置检测
  useEffect(() => {
    if (setupChecked) return
    fetch('/api/config?key=setupCompleted')
      .then(r => r.json())
      .then(data => {
        if (data.value !== 'true') setShowSetup(true)
        setSetupChecked(true)
      })
      .catch(() => setSetupChecked(true))
  }, [setupChecked])

  const refreshSessions = () => {
    fetch('/api/sessions').then(r => r.json()).then(setSessions)
  }

  return (
    <div className="flex flex-1 flex-col gap-6 p-6">
      {/* 首次设置向导 */}
      <SetupWizard
        open={showSetup}
        onOpenChange={setShowSetup}
        onComplete={() => { refreshSessions(); setShowSetup(false) }}
      />

      {/* 创建群聊弹窗 */}
      <CreateGroupDialog
        open={showCreateGroup}
        onOpenChange={setShowCreateGroup}
        onCreated={async (sessionId) => {
          refreshSessions()
          router.push(`/?session=${sessionId}`)
        }}
      />

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">工作区</h1>
          <p className="text-sm text-muted-foreground mt-1">概览你的项目和智能体活动</p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => setShowCreateGroup(true)}
            className="flex items-center gap-2 rounded-lg border bg-card px-3 py-2 text-sm hover:bg-accent transition-colors"
          >
            <Plus className="h-4 w-4" />
            创建群聊
          </button>
          <Link
            href="/"
            className="flex items-center gap-2 rounded-lg bg-primary px-3 py-2 text-sm text-primary-foreground hover:bg-primary/90 transition-colors"
          >
            <MessageSquare className="h-4 w-4" />
            进入聊天
          </Link>
        </div>
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
          {sessions.slice(0, 10).map((session) => (
            <div
              key={session.id}
              className="flex items-center justify-between rounded-lg border bg-card p-3 hover:bg-accent transition-colors group"
            >
              <Link
                href={`/dashboard/projects/${session.id}`}
                className="flex-1 min-w-0"
              >
                <p className="text-sm font-medium truncate">{session.title}</p>
                <p className="text-xs text-muted-foreground">
                  {new Date(session.updatedAt).toLocaleDateString()} · {session._count.messages} 条消息
                </p>
              </Link>
              <div className="flex items-center gap-3 ml-3">
                <div className="flex items-center gap-1 text-xs text-muted-foreground">
                  <Bot className="h-3 w-3" />
                  {session._count.members}
                </div>
                <Link
                  href={`/?session=${session.id}`}
                  className="flex items-center gap-1 rounded-md bg-primary/10 px-2 py-1 text-xs text-primary opacity-0 group-hover:opacity-100 transition-opacity"
                >
                  <Play className="h-3 w-3" />
                  进入
                </Link>
              </div>
            </div>
          ))}
          {sessions.length === 0 && (
            <div className="py-8 text-center">
              <p className="text-sm text-muted-foreground mb-3">暂无会话</p>
              <button
                onClick={() => setShowCreateGroup(true)}
                className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm text-primary-foreground hover:bg-primary/90 transition-colors"
              >
                <Plus className="h-4 w-4" />
                创建第一个群聊
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
