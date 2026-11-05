"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import {
  Archive,
  ArchiveRestore,
  ArrowRight,
  Bot,
  CheckSquare,
  FolderKanban,
  MessageSquare,
  Pin,
  PinOff,
  Plus,
  Search,
  Trash2,
  X,
} from "lucide-react"
import { toast } from "sonner"
import { SetupWizard } from "@/components/setup-wizard"
import { CreateGroupDialog } from "@/components/create-group-dialog"
import { ChatFab } from "@/components/chat-fab"
import { Button } from "@/components/ui/button"
import { SessionActionsMenu } from "@/components/session-actions-menu"
import { SessionConfirmDialog } from "@/components/session-confirm-dialog"
import { SessionRenameDialog } from "@/components/session-rename-dialog"
import { EmptyState } from "@/components/empty-state"
import { EXAMPLE_PROMPTS } from "@/lib/onboarding"
import {
  filterSessions,
  getProjectLabel,
  getSessionTypeLabel,
  groupSessions,
  type SessionGroupMode,
} from "@/lib/session-list"
import type { BatchResult } from "@/lib/hooks/use-sessions"

interface Session {
  id: string
  title: string
  type?: string
  phase?: string
  projectDir?: string
  updatedAt: string
  isPinned: boolean
  isArchived: boolean
  _count: { messages: number; members: number }
  members?: Array<{ agentId: string; agent?: { name: string; accentColor: string } }>
}

async function readError(res: Response, fallback: string): Promise<string> {
  try {
    const data = await res.json() as { error?: unknown }
    if (typeof data?.error === 'string' && data.error) return data.error
  } catch {
    // ignore non-JSON error bodies
  }
  return `${fallback} (${res.status})`
}

export default function WorkspacePage() {
  const router = useRouter()
  const [agentCount, setAgentCount] = useState(0)
  const [sessions, setSessions] = useState<Session[]>([])
  const [archivedSessions, setArchivedSessions] = useState<Session[]>([])
  const [showSetup, setShowSetup] = useState(false)
  const [setupChecked, setSetupChecked] = useState(false)
  const [showCreateGroup, setShowCreateGroup] = useState(false)
  const [createGroupSeed, setCreateGroupSeed] = useState('')
  const [searchQuery, setSearchQuery] = useState("")
  const [showArchived, setShowArchived] = useState(false)
  const [groupMode, setGroupMode] = useState<SessionGroupMode>("time")
  const [managing, setManaging] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set())
  const [batchWorking, setBatchWorking] = useState(false)
  const [renameTarget, setRenameTarget] = useState<{ id: string; title: string } | null>(null)
  const [deleteTargets, setDeleteTargets] = useState<string[]>([])

  const refreshSessions = useCallback(async () => {
    const [active, archived] = await Promise.all([
      fetch('/api/sessions').then(r => r.json()).catch(() => []),
      fetch('/api/sessions?archived=true').then(r => r.json()).catch(() => []),
    ])
    if (Array.isArray(active)) setSessions(active)
    if (Array.isArray(archived)) setArchivedSessions(archived)
  }, [])

  useEffect(() => {
    fetch('/api/agents').then(r => r.json()).then(d => setAgentCount(Array.isArray(d) ? d.length : 0))
    void refreshSessions()
  }, [refreshSessions])

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

  const currentSessions = showArchived ? archivedSessions : sessions
  const sessionMap = useMemo(
    () => new Map([...sessions, ...archivedSessions].map(session => [session.id, session])),
    [sessions, archivedSessions],
  )
  const filteredSessions = useMemo(
    () => filterSessions(currentSessions, searchQuery),
    [currentSessions, searchQuery],
  )
  const groupedSessions = useMemo(
    () => groupSessions(filteredSessions, groupMode),
    [filteredSessions, groupMode],
  )
  const allSelected = filteredSessions.length > 0 && filteredSessions.every(session => selectedIds.has(session.id))
  const archivedCount = archivedSessions.length

  useEffect(() => {
    const available = new Set([...sessions, ...archivedSessions].map(session => session.id))
    setSelectedIds(prev => {
      const next = new Set([...prev].filter(id => available.has(id)))
      return next.size === prev.size ? prev : next
    })
  }, [sessions, archivedSessions])

  const toggleSelected = (id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const toggleSelectAll = () => {
    if (allSelected) {
      setSelectedIds(new Set())
    } else {
      setSelectedIds(new Set(filteredSessions.map(session => session.id)))
    }
  }

  const switchArchiveView = (archived: boolean) => {
    setShowArchived(archived)
    setManaging(false)
    setSelectedIds(new Set())
  }

  const toggleManaging = () => {
    if (managing) setSelectedIds(new Set())
    setManaging(!managing)
  }

  const openCreateGroup = (seed = '') => {
    setCreateGroupSeed(seed)
    setShowCreateGroup(true)
  }

  const togglePin = async (id: string, current: boolean) => {
    try {
      const res = await fetch(`/api/sessions/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isPinned: !current }),
      })
      if (!res.ok) {
        toast.error(await readError(res, '更新置顶失败'))
        return
      }
      await refreshSessions()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '更新置顶失败')
    }
  }

  const archiveSessions = async (ids: string[], archived: boolean): Promise<BatchResult> => {
    const succeeded: string[] = []
    const failed: BatchResult['failed'] = []
    for (const id of ids) {
      try {
        const res = await fetch(`/api/sessions/${id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ isArchived: archived }),
        })
        if (res.ok) succeeded.push(id)
        else failed.push({ id, error: await readError(res, archived ? '归档失败' : '恢复失败') })
      } catch (err) {
        failed.push({ id, error: err instanceof Error ? err.message : '操作失败' })
      }
    }

    await refreshSessions()
    if (failed.length === 0) {
      toast.success(archived ? `已归档 ${succeeded.length} 个会话` : `已恢复 ${succeeded.length} 个会话`)
    } else {
      toast.error(`${archived ? '归档' : '恢复'} ${succeeded.length} 个，${failed.length} 个失败：${failed[0].error}`)
    }
    return { succeeded, failed }
  }

  const deleteSessions = async (ids: string[]): Promise<BatchResult> => {
    const succeeded: string[] = []
    const failed: BatchResult['failed'] = []
    for (const id of ids) {
      try {
        const res = await fetch(`/api/sessions/${id}`, { method: 'DELETE' })
        if (res.ok) succeeded.push(id)
        else failed.push({ id, error: await readError(res, '删除失败') })
      } catch (err) {
        failed.push({ id, error: err instanceof Error ? err.message : '删除失败' })
      }
    }

    await refreshSessions()
    if (failed.length === 0) {
      toast.success(`已删除 ${succeeded.length} 个会话`)
    } else {
      toast.error(`已删除 ${succeeded.length} 个，${failed.length} 个失败：${failed[0].error}`)
    }
    return { succeeded, failed }
  }

  const renameSession = async (id: string, title: string): Promise<boolean> => {
    try {
      const res = await fetch(`/api/sessions/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title }),
      })
      if (!res.ok) {
        toast.error(await readError(res, '重命名失败'))
        return false
      }
      await refreshSessions()
      toast.success('会话已重命名')
      return true
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '重命名失败')
      return false
    }
  }

  const handleArchiveSelected = async () => {
    const ids = [...selectedIds]
    if (ids.length === 0 || batchWorking) return
    setBatchWorking(true)
    try {
      const result = await archiveSessions(ids, !showArchived)
      setSelectedIds(new Set(result.failed.map(item => item.id)))
      if (result.failed.length === 0) setManaging(false)
    } finally {
      setBatchWorking(false)
    }
  }

  const handleConfirmDelete = async () => {
    if (deleteTargets.length === 0) return
    const result = await deleteSessions(deleteTargets)
    setSelectedIds(new Set(result.failed.map(item => item.id)))
    if (result.failed.length === 0) setManaging(false)
  }

  const deleteTitle = deleteTargets.length === 1
    ? '删除会话'
    : `删除 ${deleteTargets.length} 个会话`
  const deleteDescription = deleteTargets.length === 1
    ? `确定删除会话「${sessionMap.get(deleteTargets[0])?.title || ''}」吗？删除后无法恢复。`
    : `确定删除选中的 ${deleteTargets.length} 个会话吗？删除后无法恢复；正在运行的会话会删除失败并保留。`

  return (
    <div className="flex flex-1 flex-col gap-6 p-6">
      {/* 首次设置向导 */}
      <SetupWizard
        open={showSetup}
        onOpenChange={setShowSetup}
        onComplete={() => { void refreshSessions(); setShowSetup(false) }}
      />

      {/* 创建群聊弹窗 */}
      <CreateGroupDialog
        open={showCreateGroup}
        onOpenChange={open => {
          setShowCreateGroup(open)
          if (!open) setCreateGroupSeed('')
        }}
        initialTask={createGroupSeed}
        onCreated={async (sessionId) => {
          await refreshSessions()
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
            onClick={() => openCreateGroup()}
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
          <h2 className="text-sm font-medium">会话</h2>
          <div className="flex items-center gap-2">
            <Link href="/projects" className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1">
              查看全部 <ArrowRight className="h-3 w-3" />
            </Link>
          </div>
        </div>

        <div className="mb-3 flex flex-wrap items-center gap-2">
          <div className="flex rounded-md bg-muted p-0.5 text-xs">
            <button
              type="button"
              onClick={() => switchArchiveView(false)}
              className={`rounded px-2 py-1 transition-colors ${!showArchived ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground'}`}
            >
              进行中 {sessions.length}
            </button>
            <button
              type="button"
              onClick={() => switchArchiveView(true)}
              className={`rounded px-2 py-1 transition-colors ${showArchived ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground'}`}
            >
              已归档 {archivedCount}
            </button>
          </div>
          <div className="flex rounded-md bg-muted p-0.5 text-xs">
            <button
              type="button"
              onClick={() => setGroupMode('time')}
              className={`rounded px-2 py-1 transition-colors ${groupMode === 'time' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground'}`}
            >
              时间
            </button>
            <button
              type="button"
              onClick={() => setGroupMode('project')}
              className={`rounded px-2 py-1 transition-colors ${groupMode === 'project' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground'}`}
            >
              项目
            </button>
          </div>
          <Button
            size="xs"
            variant={managing ? 'secondary' : 'outline'}
            className="gap-1"
            onClick={toggleManaging}
          >
            <CheckSquare className="h-3 w-3" />
            {managing ? '完成' : '管理'}
          </Button>
        </div>

        {managing && (
          <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border bg-muted/40 px-3 py-2 text-sm">
            <span className="text-muted-foreground">已选 {selectedIds.size} 个</span>
            <button type="button" onClick={toggleSelectAll} className="text-xs text-primary hover:underline">
              {allSelected ? '取消全选' : '全选'}
            </button>
            <div className="ml-auto flex flex-wrap gap-1">
              <Button
                size="xs"
                variant="outline"
                className="gap-1"
                disabled={selectedIds.size === 0 || batchWorking}
                onClick={handleArchiveSelected}
              >
                {showArchived ? <ArchiveRestore className="h-3 w-3" /> : <Archive className="h-3 w-3" />}
                {showArchived ? '恢复' : '归档'}
              </Button>
              <Button
                size="xs"
                variant="destructive"
                className="gap-1"
                disabled={selectedIds.size === 0}
                onClick={() => setDeleteTargets([...selectedIds])}
              >
                <Trash2 className="h-3 w-3" />
                删除
              </Button>
              <Button size="xs" variant="ghost" onClick={toggleManaging}>
                取消
              </Button>
            </div>
          </div>
        )}

        {/* 搜索框 */}
        <div className="relative mb-3">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <input
            type="text"
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            placeholder="搜索标题、项目、成员..."
            className="w-full rounded-lg border bg-background pl-9 pr-8 py-2 text-sm outline-none focus:ring-2 focus:ring-primary/20"
          />
          {searchQuery && (
            <button
              onClick={() => setSearchQuery('')}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              aria-label="清空搜索"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>

        {/* 会话列表 */}
        <div className="space-y-3">
          {groupedSessions.map((group) => (
            <div key={group.key}>
              <div
                className="mb-1 flex items-center justify-between px-1 text-xs text-muted-foreground"
                title={group.projectDir || undefined}
              >
                <span>{group.label}</span>
                <span>{group.sessions.length}</span>
              </div>
              <div className="space-y-1.5">
                {group.sessions.map((session) => {
                  const canSelect = managing
                  return (
                    <div
                      key={session.id}
                      className={`group flex items-center gap-3 rounded-lg border bg-card px-3 py-2.5 transition-colors hover:bg-accent ${
                        session.isPinned ? 'border-l-2 border-l-primary' : ''
                      }`}
                    >
                      {canSelect && (
                        <input
                          type="checkbox"
                          checked={selectedIds.has(session.id)}
                          onChange={() => toggleSelected(session.id)}
                          className="h-4 w-4 shrink-0 accent-primary"
                          aria-label={`选择会话 ${session.title}`}
                        />
                      )}

                      <Link
                        href={`/chat?session=${session.id}`}
                        onClick={(event) => {
                          if (managing) {
                            event.preventDefault()
                            toggleSelected(session.id)
                          }
                        }}
                        className="min-w-0 flex-1"
                      >
                        <div className="flex items-center gap-2">
                          {session.isPinned && <Pin className="h-3 w-3 shrink-0 text-primary" />}
                          <p className="truncate text-sm font-medium">{session.title}</p>
                        </div>
                        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
                          <span className="max-w-[240px] truncate">
                            {session.projectDir ? getProjectLabel(session.projectDir) : getSessionTypeLabel(session.type)}
                          </span>
                          <span>·</span>
                          <span>{session._count.messages} 条消息</span>
                          <span>·</span>
                          <span>{new Date(session.updatedAt).toLocaleDateString()}</span>
                        </div>
                      </Link>

                      {!managing && (
                        <div className="flex shrink-0 items-center gap-1">
                          <button
                            onClick={() => { void togglePin(session.id, session.isPinned) }}
                            className="flex h-7 w-7 items-center justify-center rounded hover:bg-background transition-colors"
                            title={session.isPinned ? '取消置顶' : '置顶'}
                            aria-label={session.isPinned ? `取消置顶 ${session.title}` : `置顶 ${session.title}`}
                          >
                            {session.isPinned
                              ? <PinOff className="h-3.5 w-3.5 text-muted-foreground" />
                              : <Pin className="h-3.5 w-3.5 text-muted-foreground" />}
                          </button>
                          <SessionActionsMenu
                            session={session}
                            onRename={(id, title) => setRenameTarget({ id, title })}
                            onArchive={(id, archived) => { void archiveSessions([id], archived) }}
                            onDelete={id => setDeleteTargets([id])}
                            alwaysVisible
                          />
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
          ))}
          {filteredSessions.length === 0 && currentSessions.length > 0 && (
            <EmptyState compact title="没有匹配的会话" description="试试搜索项目名或智能体名。" />
          )}
          {currentSessions.length === 0 && (
            <EmptyState
              title={showArchived ? '暂无已归档会话' : '暂无会话'}
              description={
                showArchived
                  ? '归档的会话会显示在这里，可随时恢复。'
                  : '描述你想做的事，Orchestrator 会先和你对齐，再拆解成可执行任务。'
              }
              action={!showArchived ? (
                <div className="space-y-3">
                  <button
                    onClick={() => openCreateGroup()}
                    className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm text-primary-foreground hover:bg-primary/90 transition-colors"
                  >
                    <Plus className="h-4 w-4" />
                    创建第一个群聊
                  </button>
                  <div className="mx-auto grid max-w-3xl gap-2 text-left sm:grid-cols-3">
                    {EXAMPLE_PROMPTS.map(prompt => (
                      <button
                        key={prompt}
                        onClick={() => openCreateGroup(prompt)}
                        className="rounded-lg border bg-card px-3 py-2.5 text-xs leading-relaxed text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                      >
                        {prompt}
                      </button>
                    ))}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    点示例可直接带入需求；项目目录可先留空，使用应用默认工作目录。
                  </p>
                </div>
              ) : undefined}
            />
          )}
        </div>
      </div>

      {/* 右下角聊天卡片 */}
      <ChatFab />

      <SessionRenameDialog
        open={!!renameTarget}
        onOpenChange={open => { if (!open) setRenameTarget(null) }}
        initialTitle={renameTarget?.title || ''}
        onRename={async (title) => {
          if (!renameTarget) return false
          return renameSession(renameTarget.id, title)
        }}
      />

      <SessionConfirmDialog
        open={deleteTargets.length > 0}
        onOpenChange={open => { if (!open) setDeleteTargets([]) }}
        title={deleteTitle}
        description={deleteDescription}
        confirmLabel="删除"
        destructive
        onConfirm={handleConfirmDelete}
      />
    </div>
  )
}
