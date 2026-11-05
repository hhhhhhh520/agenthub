'use client'
import { useEffect, useMemo, useState } from 'react'
import { Archive, Pin, Search, Trash2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Skeleton } from '@/components/ui/skeleton'
import { SessionActionsMenu } from '@/components/session-actions-menu'
import { SessionConfirmDialog } from '@/components/session-confirm-dialog'
import { SessionRenameDialog } from '@/components/session-rename-dialog'
import { EmptyState } from '@/components/empty-state'
import {
  filterSessions,
  getProjectLabel,
  getSessionTypeLabel,
  groupSessions,
  type SessionGroupMode,
} from '@/lib/session-list'
import type { BatchResult } from '@/lib/hooks/use-sessions'

interface Session {
  id: string
  title: string
  type?: string
  phase?: string
  projectDir?: string
  updatedAt: string
  isPinned?: boolean
  members?: Array<{ agentId: string; agent?: { name: string; accentColor: string } }>
}

interface Props {
  sessions: Session[]
  activeId: string | null
  isLoading: boolean
  onSelect: (id: string) => void
  onCreateGroup: () => void
  onQuickStart: () => void
  onDelete: (id: string) => Promise<boolean | void>
  onDeleteMany: (ids: string[]) => Promise<BatchResult>
  onArchiveMany: (ids: string[], archived?: boolean) => Promise<BatchResult>
  onRename: (id: string, title: string) => Promise<boolean>
}

function formatUpdatedAt(updatedAt: string): string {
  const date = new Date(updatedAt)
  if (Number.isNaN(date.getTime())) return ''
  const now = new Date()
  if (date.toDateString() === now.toDateString()) {
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  }
  return date.toLocaleDateString([], { month: 'numeric', day: 'numeric' })
}

function MemberDots({ session }: { session: Session }) {
  if (!session.members || session.members.length === 0) return null
  const visible = session.members.slice(0, 2)
  return (
    <div className="flex shrink-0 -space-x-1">
      {visible.map(member => {
        const name = member.agent?.name || member.agentId
        return (
          <div
            key={member.agentId}
            className="flex h-5 w-5 items-center justify-center rounded-full border border-background text-xs font-medium text-white"
            style={{ backgroundColor: member.agent?.accentColor || '#6366f1' }}
            title={name}
          >
            {name.charAt(0)}
          </div>
        )
      })}
      {session.members.length > 2 && (
        <div className="flex h-5 w-5 items-center justify-center rounded-full border border-background bg-muted text-xs text-muted-foreground">
          +{session.members.length - 2}
        </div>
      )}
    </div>
  )
}

export function SessionSidebar({
  sessions,
  activeId,
  isLoading,
  onSelect,
  onCreateGroup,
  onQuickStart,
  onDelete,
  onDeleteMany,
  onArchiveMany,
  onRename,
}: Props) {
  const [query, setQuery] = useState('')
  const [groupMode, setGroupMode] = useState<SessionGroupMode>('time')
  const [managing, setManaging] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set())
  const [batchWorking, setBatchWorking] = useState(false)
  const [renameTarget, setRenameTarget] = useState<{ id: string; title: string } | null>(null)
  const [deleteTargets, setDeleteTargets] = useState<string[]>([])

  const sessionMap = useMemo(() => new Map(sessions.map(session => [session.id, session])), [sessions])
  const filtered = useMemo(() => filterSessions(sessions, query), [sessions, query])
  const grouped = useMemo(() => groupSessions(filtered, groupMode), [filtered, groupMode])

  useEffect(() => {
    const available = new Set(sessions.map(session => session.id))
    setSelectedIds(prev => {
      const next = new Set([...prev].filter(id => available.has(id)))
      return next.size === prev.size ? prev : next
    })
    if (sessions.length === 0) setManaging(false)
  }, [sessions])

  const allSelected = filtered.length > 0 && filtered.every(session => selectedIds.has(session.id))

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
      setSelectedIds(new Set(filtered.map(session => session.id)))
    }
  }

  const toggleManaging = () => {
    if (managing) setSelectedIds(new Set())
    setManaging(!managing)
  }

  const handleArchiveSelected = async () => {
    const ids = [...selectedIds]
    if (ids.length === 0 || batchWorking) return
    setBatchWorking(true)
    try {
      const result = await onArchiveMany(ids, true)
      setSelectedIds(new Set(result.failed.map(item => item.id)))
      if (result.failed.length === 0) setManaging(false)
    } finally {
      setBatchWorking(false)
    }
  }

  const handleConfirmDelete = async () => {
    if (deleteTargets.length === 0) return
    if (deleteTargets.length === 1) {
      await onDelete(deleteTargets[0])
      return
    }
    const result = await onDeleteMany(deleteTargets)
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
    <div className="flex w-64 shrink-0 flex-col overflow-hidden border-r bg-gray-50 dark:border-gray-700 dark:bg-gray-900">
      <div className="space-y-2 border-b p-3">
        <div className="grid grid-cols-2 gap-2">
          <Button onClick={onQuickStart} variant="outline" size="sm" aria-label="开始对话">
            开始对话
          </Button>
          <Button onClick={onCreateGroup} size="sm" aria-label="创建群聊">
            创建群聊
          </Button>
        </div>
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            value={query}
            onChange={event => setQuery(event.target.value)}
            placeholder="搜索标题、项目、成员"
            aria-label="搜索会话"
            className="w-full rounded-md border bg-background py-1.5 pl-8 pr-7 text-xs outline-none focus:ring-2 focus:ring-primary/20"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery('')}
              aria-label="清空搜索"
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
        <div className="flex items-center justify-between gap-2">
          <div className="flex rounded-md bg-muted p-0.5 text-xs">
            <button
              type="button"
              onClick={() => setGroupMode('time')}
              className={`rounded px-2 py-0.5 transition-colors ${groupMode === 'time' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground'}`}
            >
              时间
            </button>
            <button
              type="button"
              onClick={() => setGroupMode('project')}
              className={`rounded px-2 py-0.5 transition-colors ${groupMode === 'project' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground'}`}
            >
              项目
            </button>
          </div>
          <button
            type="button"
            onClick={toggleManaging}
            className="text-xs text-muted-foreground hover:text-foreground"
          >
            {managing ? '完成' : '管理'}
          </button>
        </div>

        {managing && (
          <div className="space-y-2 rounded-md border bg-background p-2">
            <div className="flex items-center justify-between text-xs">
              <span className="text-muted-foreground">已选 {selectedIds.size} 个</span>
              <button type="button" onClick={toggleSelectAll} className="hover:text-foreground">
                {allSelected ? '取消全选' : '全选'}
              </button>
            </div>
            <div className="grid grid-cols-2 gap-1">
              <Button
                size="xs"
                variant="outline"
                disabled={selectedIds.size === 0 || batchWorking}
                onClick={handleArchiveSelected}
                className="gap-1"
              >
                <Archive className="h-3 w-3" />
                归档
              </Button>
              <Button
                size="xs"
                variant="destructive"
                disabled={selectedIds.size === 0}
                onClick={() => setDeleteTargets([...selectedIds])}
                className="gap-1"
              >
                <Trash2 className="h-3 w-3" />
                删除
              </Button>
            </div>
          </div>
        )}
      </div>

      <ScrollArea className="min-h-0 flex-1 overflow-hidden">
        <div className="space-y-3 p-2">
          {isLoading ? (
            <div className="space-y-3 p-2">
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="space-y-1">
                  <Skeleton className="h-3 w-12" />
                  <Skeleton className="h-9 w-full" />
                </div>
              ))}
            </div>
          ) : grouped.length === 0 ? (
            <EmptyState
              compact
              title={query ? '没有匹配的会话' : '还没有会话'}
              description={query ? '试试搜索项目名或智能体名。' : '点击上方「开始对话」或「创建群聊」。'}
            />
          ) : grouped.map(group => (
            <div key={group.key}>
              <div
                className="mb-1 flex items-center justify-between px-2 text-xs font-medium text-gray-400 dark:text-gray-500"
                title={group.projectDir || undefined}
              >
                <span className="truncate">{group.label}</span>
                <span>{group.sessions.length}</span>
              </div>
              <div className="space-y-0.5">
                {group.sessions.map(session => {
                  const isActive = activeId === session.id
                  const isChecked = selectedIds.has(session.id)
                  const projectLabel = getProjectLabel(session.projectDir)
                  return (
                    <div
                      key={session.id}
                      className={`group flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm select-none ${
                        isActive
                          ? 'bg-blue-100 text-blue-900 dark:bg-blue-900 dark:text-blue-100'
                          : 'hover:bg-gray-100 dark:hover:bg-gray-800'
                      }`}
                      onClick={() => managing ? toggleSelected(session.id) : onSelect(session.id)}
                      role="button"
                      tabIndex={0}
                      aria-pressed={managing ? isChecked : undefined}
                      onKeyDown={(event) => {
                        if (event.target !== event.currentTarget) return
                        if (event.key !== 'Enter' && event.key !== ' ') return
                        event.preventDefault()
                        if (managing) toggleSelected(session.id)
                        else onSelect(session.id)
                      }}
                    >
                      {managing ? (
                        <input
                          type="checkbox"
                          checked={isChecked}
                          onChange={() => toggleSelected(session.id)}
                          onClick={event => event.stopPropagation()}
                          className="h-3.5 w-3.5 shrink-0 accent-primary"
                          aria-label={`选择会话 ${session.title}`}
                        />
                      ) : (
                        <MemberDots session={session} />
                      )}

                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1">
                          {session.isPinned && <Pin className="h-3 w-3 shrink-0 text-primary" />}
                          <span className="truncate text-[13px] font-medium">{session.title}</span>
                        </div>
                        <div className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
                          <span className="truncate">
                            {projectLabel === '未绑定项目' ? getSessionTypeLabel(session.type) : projectLabel}
                          </span>
                          <span>·</span>
                          <span className="shrink-0">{formatUpdatedAt(session.updatedAt)}</span>
                        </div>
                      </div>

                      {!managing && (
                        <SessionActionsMenu
                          session={session}
                          onRename={(id, title) => setRenameTarget({ id, title })}
                          onArchive={(id, archived) => { void onArchiveMany([id], archived) }}
                          onDelete={id => setDeleteTargets([id])}
                          alwaysVisible={isActive}
                        />
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
          ))}
        </div>
      </ScrollArea>

      <SessionRenameDialog
        open={!!renameTarget}
        onOpenChange={open => { if (!open) setRenameTarget(null) }}
        initialTitle={renameTarget?.title || ''}
        onRename={async (title) => {
          if (!renameTarget) return false
          return onRename(renameTarget.id, title)
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
