"use client"

import { useEffect, useState, useMemo } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { FolderKanban, Bot, ArrowRight, MessageSquare, Plus, Play, Search, Pin, PinOff, Archive, ArchiveRestore, X } from "lucide-react"
import { SetupWizard } from "@/components/setup-wizard"
import { CreateGroupDialog } from "@/components/create-group-dialog"
import { ChatFab } from "@/components/chat-fab"

interface Session {
  id: string
  title: string
  updatedAt: string
  isPinned: boolean
  isArchived: boolean
  _count: { messages: number; members: number }
}

export default function WorkspacePage() {
  const router = useRouter()
  const [agentCount, setAgentCount] = useState(0)
  const [sessions, setSessions] = useState<Session[]>([])
  const [archivedSessions, setArchivedSessions] = useState<Session[]>([])
  const [showSetup, setShowSetup] = useState(false)
  const [setupChecked, setSetupChecked] = useState(false)
  const [showCreateGroup, setShowCreateGroup] = useState(false)
  const [searchQuery, setSearchQuery] = useState("")
  const [showArchived, setShowArchived] = useState(false)

  useEffect(() => {
    fetch('/api/agents').then(r => r.json()).then(d => setAgentCount(Array.isArray(d) ? d.length : 0))
    refreshSessions()
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
    fetch('/api/sessions').then(r => r.json()).then(d => { if (Array.isArray(d)) setSessions(d) })
    fetch('/api/sessions?archived=true').then(r => r.json()).then(d => { if (Array.isArray(d)) setArchivedSessions(d) })
  }

  const togglePin = async (id: string, current: boolean) => {
    await fetch(`/api/sessions/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isPinned: !current }),
    })
    refreshSessions()
  }

  const toggleArchive = async (id: string, current: boolean) => {
    await fetch(`/api/sessions/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isArchived: !current }),
    })
    refreshSessions()
  }

  // 过滤 + 排序
  const filteredSessions = useMemo(() => {
    const list = showArchived ? archivedSessions : sessions
    let result = [...list]

    // 搜索过滤
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase()
      result = result.filter(s => s.title.toLowerCase().includes(q))
    }

    // 排序：置顶优先，然后按时间
    result.sort((a, b) => {
      if (a.isPinned !== b.isPinned) return b.isPinned ? 1 : -1
      return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
    })

    return result
  }, [sessions, archivedSessions, searchQuery, showArchived])

  const archivedCount = archivedSessions.length

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
          router.push(`/chat?session=${sessionId}`)
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
            href="/chat"
            className="flex items-center gap-2 rounded-lg bg-primary px-3 py-2 text-sm text-primary-foreground hover:bg-primary/90 transition-colors"
          >
            <MessageSquare className="h-4 w-4" />
            进入聊天
          </Link>
        </div>
      </div>

      {/* Stats cards */}
      <div className="grid grid-cols-2 gap-4">
        <Link
          href="/projects"
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
          href="/agents"
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

      </div>

      {/* Recent sessions */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-medium">最近会话</h2>
          <div className="flex items-center gap-2">
            {archivedCount > 0 && (
              <button
                onClick={() => setShowArchived(!showArchived)}
                className={`flex items-center gap-1 rounded-md px-2 py-1 text-xs transition-colors ${
                  showArchived ? 'bg-orange-100 text-orange-700' : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                <Archive className="h-3 w-3" />
                {showArchived ? `已归档 (${archivedCount})` : `${archivedCount} 个已归档`}
              </button>
            )}
            <Link href="/projects" className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1">
              查看全部 <ArrowRight className="h-3 w-3" />
            </Link>
          </div>
        </div>

        {/* 搜索框 */}
        <div className="relative mb-3">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <input
            type="text"
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            placeholder="搜索会话..."
            className="w-full rounded-lg border bg-background pl-9 pr-8 py-2 text-sm outline-none focus:ring-2 focus:ring-primary/20"
          />
          {searchQuery && (
            <button
              onClick={() => setSearchQuery('')}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>

        {/* 会话列表 */}
        <div className="space-y-2">
          {filteredSessions.map((session) => {
            const isPinned = session.isPinned
            const isArchived = session.isArchived
            return (
              <div
                key={session.id}
                className={`flex items-center justify-between rounded-lg border bg-card p-3 hover:bg-accent transition-colors group ${
                  isPinned ? 'border-l-2 border-l-primary' : ''
                } ${isArchived ? 'opacity-60' : ''}`}
              >
                <Link
                  href={`/projects/${session.id}`}
                  className="flex-1 min-w-0"
                >
                  <div className="flex items-center gap-2">
                    {isPinned && <Pin className="h-3 w-3 text-primary shrink-0" />}
                    <p className="text-sm font-medium truncate">{session.title}</p>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {new Date(session.updatedAt).toLocaleDateString()} · {session._count.messages} 条消息
                  </p>
                </Link>
                <div className="flex items-center gap-2 ml-3">
                  <div className="flex items-center gap-1 text-xs text-muted-foreground">
                    <Bot className="h-3 w-3" />
                    {session._count.members}
                  </div>
                  {/* 操作按钮 */}
                  <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                    <button
                      onClick={(e) => { e.stopPropagation(); togglePin(session.id, isPinned) }}
                      className="flex h-6 w-6 items-center justify-center rounded hover:bg-background transition-colors"
                      title={isPinned ? '取消置顶' : '置顶'}
                    >
                      {isPinned ? <PinOff className="h-3 w-3 text-muted-foreground" /> : <Pin className="h-3 w-3 text-muted-foreground" />}
                    </button>
                    <button
                      onClick={(e) => { e.stopPropagation(); toggleArchive(session.id, isArchived) }}
                      className="flex h-6 w-6 items-center justify-center rounded hover:bg-background transition-colors"
                      title={isArchived ? '取消归档' : '归档'}
                    >
                      {isArchived ? <ArchiveRestore className="h-3 w-3 text-muted-foreground" /> : <Archive className="h-3 w-3 text-muted-foreground" />}
                    </button>
                    <Link
                      href={`/chat?session=${session.id}`}
                      className="flex items-center gap-1 rounded-md bg-primary/10 px-2 py-1 text-xs text-primary"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <Play className="h-3 w-3" />
                      进入
                    </Link>
                  </div>
                </div>
              </div>
            )
          })}
          {filteredSessions.length === 0 && sessions.length > 0 && (
            <p className="text-sm text-muted-foreground py-4 text-center">没有匹配的会话</p>
          )}
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

      {/* 右下角聊天卡片 */}
      <ChatFab />
    </div>
  )
}