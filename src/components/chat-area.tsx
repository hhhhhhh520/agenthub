'use client'
import { Component, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useChat } from '@/lib/hooks/use-chat'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { getAgentStyle } from '@/lib/agent-colors'
import { parseMessage, stripProtocolMarkers, type ParsedMessage } from '@/lib/message-parser'
import { normalizeAgentSelfIntro } from '@/lib/agent-identity'
import { MarkdownMessage } from '@/components/markdown-message'
import { SessionHeader, type SessionHeaderTaskCounts } from '@/components/session-header'
import { SystemEventNotice } from '@/components/system-event-notice'
import { SystemEventDrawer } from '@/components/system-event-drawer'
import { EmptyState } from '@/components/empty-state'
import { collectSystemEvents, groupMessagesForChat } from '@/lib/system-events'
import { isSystemTask, summarizeTaskBoard } from '@/lib/task-board'
import { getLastTraceEvent, getTaskStartedAt } from '@/lib/task-timing'
import { deriveWaitingReason } from '@/lib/waiting-state'
import { isOpenCodePlatform } from '@/lib/permission-mode'
import { MessageActionMenu } from '@/components/message-action-menu'
import { WebPreview } from '@/components/web-preview'
import { CodeDiff } from '@/components/code-diff'
import { formatMessageClock, formatMessageFullTime } from '@/lib/message-time'
import { COMPLETION_GUIDE_KEY } from '@/lib/onboarding'
import { Shield, ShieldAlert, Pin, Info } from 'lucide-react'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { FileCard } from '@/components/file-card'
import { AttachmentInput, type AttachmentPreview } from '@/components/attachment-input'
import { toast } from 'sonner'

const ROLE_STYLES: Record<string, { bg: string; label: string }> = {
  user: {
    bg: 'bg-blue-50/90 text-slate-900 border border-blue-100 dark:bg-blue-950/40 dark:text-blue-50 dark:border-blue-900/60',
    label: '你',
  },
  orchestrator: {
    bg: 'bg-violet-50 text-violet-950 border border-violet-100 dark:bg-violet-950/40 dark:text-violet-100 dark:border-violet-900/60',
    label: 'Orchestrator',
  },
}

interface MemberAgent {
  id: string
  name: string
  accentColor?: string
  platform?: string
}

interface SessionMeta {
  phase: string
  phaseStep: string
  projectDir: string
  permissionMode: string
  recoveredTaskCount?: number
  createdAt?: string
  updatedAt?: string
}

interface HeaderTask {
  id: string
  description: string
  status: string
  assignedAgentId?: string | null
  createdAt?: string
  updatedAt?: string
  trace?: string | null
}

const COMMANDS = [
  { name: '/permission auto', description: '切换到自动模式，减少打扰' },
  { name: '/permission default', description: '切换到默认模式，需要确认' },
]

export function ChatArea({ sessionId, sessionType }: { sessionId: string | null; sessionType?: string }) {
  const { messages, streaming, loading, send, stop, loadMessages, phase, awaitingInput, pendingPermissions, respondPermission, thinking, toolCalls } = useChat(sessionId)
  const [input, setInput] = useState('')
  const [agentNames, setAgentNames] = useState<string[]>([])
  const [agentColorMap, setAgentColorMap] = useState<Record<string, string>>({})
  const [replyTo, setReplyTo] = useState<{ id: string; rawContent: string; role: string } | null>(null)
  const [attachments, setAttachments] = useState<AttachmentPreview[]>([])
  const [showCommands, setShowCommands] = useState(false)
  const [showMentions, setShowMentions] = useState(false)
  const [mentionQuery, setMentionQuery] = useState('')
  const [showRecovery, setShowRecovery] = useState(false)
  const [recoveredCount, setRecoveredCount] = useState(0)
  const [sessionMeta, setSessionMeta] = useState<SessionMeta | null>(null)
  const [tasks, setTasks] = useState<HeaderTask[]>([])
  const [agentIdToName, setAgentIdToName] = useState<Record<string, string>>({})
  const [liveStep, setLiveStep] = useState('')
  const [systemDrawerOpen, setSystemDrawerOpen] = useState(false)
  const [hasOpenCodeMember, setHasOpenCodeMember] = useState(false)
  const [switchingToAuto, setSwitchingToAuto] = useState(false)
  const [messagesReady, setMessagesReady] = useState(false)
  const [waitingSince, setWaitingSince] = useState<string | null>(null)
  const waitingStartedRef = useRef<number | null>(null)
  const [showProductsGuide, setShowProductsGuide] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)
  const nearBottomRef = useRef(true)

  const applyMembers = useCallback((members: Array<{ agent: MemberAgent }>) => {
    const names = members.map(m => m.agent.name)
    const colorMap: Record<string, string> = {}
    const idToName: Record<string, string> = {}
    members.forEach(m => {
      idToName[m.agent.id] = m.agent.name
      if (m.agent.accentColor) colorMap[m.agent.name] = m.agent.accentColor
    })
    setAgentNames(names)
    setAgentColorMap(colorMap)
    setAgentIdToName(idToName)
    setHasOpenCodeMember(members.some(m => isOpenCodePlatform(m.agent.platform)))
  }, [])

  useEffect(() => {
    if (!sessionId) {
      setSessionMeta(null)
      setTasks([])
      setLiveStep('')
      setHasOpenCodeMember(false)
      setMessagesReady(false)
      return
    }

    let cancelled = false
    const controller = new AbortController()

    setSessionMeta(null)
    setTasks([])
    setLiveStep('')
    setHasOpenCodeMember(false)
    setMessagesReady(false)

    const messagesPromise = loadMessages().finally(() => {
      if (!cancelled) setMessagesReady(true)
    })

    // 并行请求成员和会话信息
    Promise.all([
      messagesPromise,
      fetch(`/api/sessions/${sessionId}/members`, { signal: controller.signal })
        .then(r => r.json())
        .then((members: Array<{ agent: MemberAgent }>) => {
          if (cancelled) return
          applyMembers(members)
        })
        .catch(err => {
          if (!cancelled && (err as Error).name !== 'AbortError') console.error(err)
        }),
      // 会话上下文 + 断点续跑检查
      fetch(`/api/sessions/${sessionId}`, { signal: controller.signal })
        .then(r => r.ok ? r.json() : null)
        .then((session: SessionMeta | null) => {
          if (cancelled || !session) return
          setSessionMeta(session)
          if (session.recoveredTaskCount && session.recoveredTaskCount > 0) {
            setRecoveredCount(session.recoveredTaskCount)
            setShowRecovery(true)
          }
        })
        .catch(err => {
          if (!cancelled && (err as Error).name !== 'AbortError') console.error(err)
        }),
    ])

    return () => {
      cancelled = true
      controller.abort()
    }
  }, [sessionId, loadMessages, applyMembers])

  // AgentPanel 新增/编辑成员后，刷新成员列表，让 OpenCode 权限提示即时出现。
  useEffect(() => {
    if (!sessionId) return
    let cancelled = false
    const refreshMembers = () => {
      fetch(`/api/sessions/${sessionId}/members`)
        .then(r => r.ok ? r.json() : [])
        .then((members: unknown) => {
          if (!cancelled && Array.isArray(members)) {
            applyMembers(members as Array<{ agent: MemberAgent }>)
          }
        })
        .catch(() => {})
    }
    window.addEventListener('agenthub:members-changed', refreshMembers)
    return () => {
      cancelled = true
      window.removeEventListener('agenthub:members-changed', refreshMembers)
    }
  }, [sessionId, applyMembers])

  // phase 事件只带 phase；页面刷新后 useChat 可能停在 idle，用会话快照兜底。
  const effectivePhase = phase !== 'idle' ? phase : (sessionMeta?.phase || 'idle')

  // Header 只需要当前任务和计数：活跃阶段 5s 轮询，空闲/完成只取一次。
  useEffect(() => {
    if (!sessionId) return

    let cancelled = false
    let inFlight = false
    const controller = new AbortController()

    const load = () => {
      if (inFlight) return
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
      inFlight = true
      fetch(`/api/sessions/${sessionId}/tasks`, { signal: controller.signal, cache: 'no-store' })
        .then(r => r.ok ? r.json() : [])
        .then((data: unknown) => {
          if (!cancelled && Array.isArray(data)) setTasks(data as HeaderTask[])
        })
        .catch(() => { /* 轮询失败静默，下一轮再试 */ })
        .finally(() => { inFlight = false })
    }

    load()
    if (effectivePhase !== 'alignment' && effectivePhase !== 'execution') {
      return () => {
        cancelled = true
        controller.abort()
      }
    }

    const timer = setInterval(load, 5000)
    return () => {
      cancelled = true
      controller.abort()
      clearInterval(timer)
    }
  }, [sessionId, effectivePhase])

  // awaitingInput 是实时 phaseStep；刷新时用会话快照的 phaseStep 兜底。
  useEffect(() => {
    if (awaitingInput) setLiveStep(awaitingInput)
  }, [awaitingInput])

  useEffect(() => {
    if (phase === 'idle' || phase === 'execution' || phase === 'done') setLiveStep('')
  }, [phase])

  const headerStep = effectivePhase === 'alignment'
    ? (liveStep || sessionMeta?.phaseStep || '')
    : ''

  const activeTask = tasks.find(t => t.status === 'in_progress' && !isSystemTask(t.description))
  const boardSummary = summarizeTaskBoard(tasks)
  const taskCounts: SessionHeaderTaskCounts = {
    total: boardSummary.total,
    done: boardSummary.done,
    running: boardSummary.running,
    pending: boardSummary.pending,
    failed: boardSummary.failed + boardSummary.blocked,
    system: boardSummary.system,
  }
  const currentTask = activeTask
    ? {
        description: activeTask.description,
        agentName: activeTask.assignedAgentId ? agentIdToName[activeTask.assignedAgentId] : undefined,
        startedAt: getTaskStartedAt(activeTask) || undefined,
      }
    : undefined

  useEffect(() => {
    if (boardSummary.done === 0 || typeof window === 'undefined') return
    try {
      if (localStorage.getItem(COMPLETION_GUIDE_KEY) === '1') return
    } catch {
      // localStorage 不可用时仍展示一次
    }
    setShowProductsGuide(true)
  }, [boardSummary.done])

  const dismissProductsGuide = () => {
    setShowProductsGuide(false)
    try { localStorage.setItem(COMPLETION_GUIDE_KEY, '1') } catch { /* ignore */ }
  }
  const runningTool = toolCalls.find(tc => tc.status === 'running')?.toolName ?? null
  const waitingReason = deriveWaitingReason({
    loading,
    pendingPermissionCount: pendingPermissions.length,
    awaitingInput,
    retrying: !!activeTask && loading && getLastTraceEvent(activeTask.trace) === 'retry',
    runningTool,
    thinking: Object.keys(thinking).length > 0,
    streaming: Object.keys(streaming).length > 0,
  }).label
  const isWaiting = !!waitingReason

  useEffect(() => {
    if (!isWaiting) {
      waitingStartedRef.current = null
      setWaitingSince(null)
      return
    }
    if (waitingStartedRef.current === null) {
      const now = Date.now()
      waitingStartedRef.current = now
      setWaitingSince(new Date(now).toISOString())
    }
  }, [isWaiting])

  const systemEvents = useMemo(() => collectSystemEvents(messages, tasks), [messages, tasks])
  const chatItems = useMemo(() => groupMessagesForChat(messages), [messages])
  useEffect(() => {
    if (nearBottomRef.current) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
    }
  }, [messages, streaming])

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value
    setInput(value)
    setShowCommands(value.startsWith('/'))

    // 检测 @ 触发
    const lastAt = value.lastIndexOf('@')
    if (lastAt !== -1 && lastAt === value.length - 1) {
      // 刚输入 @，显示所有成员
      setShowMentions(true)
      setMentionQuery('')
    } else if (lastAt !== -1) {
      // @ 后面有内容，按输入过滤
      const query = value.slice(lastAt + 1)
      if (!query.includes(' ')) {
        setShowMentions(true)
        setMentionQuery(query)
      } else {
        setShowMentions(false)
      }
    } else {
      setShowMentions(false)
    }
  }

  const handleCommandSelect = (command: string) => {
    setInput(command)
    setShowCommands(false)
  }

  const handleMentionSelect = (name: string) => {
    const lastAt = input.lastIndexOf('@')
    const before = input.slice(0, lastAt)
    setInput(before + '@' + name + ' ')
    setShowMentions(false)
  }

  if (!sessionId) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <EmptyState
          title="选择一个会话开始"
          description="从左侧选择会话，或点击「创建群聊」描述你的需求。"
          className="max-w-sm"
        />
      </div>
    )
  }

  const handleSend = () => {
    if (attachments.some(a => a.uploading)) {
      toast.error('附件仍在上传中，请稍候')
      return
    }
    const mentionAll = input.includes('@所有人')
    let targetAgent: string | undefined
    if (!mentionAll) {
      const match = input.match(/@(\S+)/)
      if (match && agentNames.includes(match[1])) {
        targetAgent = match[1]
      }
    }
    const attachmentIds = attachments.filter(a => !a.uploading).map(a => a.id)
    const trimmed = input.trim()
    if (trimmed.startsWith('/permission')) {
      const mode = trimmed.split(/\s+/)[1]
      if (mode === 'auto' || mode === 'default') {
        setSessionMeta(prev => prev ? { ...prev, permissionMode: mode } : prev)
      }
    }
    send(input, mentionAll, targetAgent, replyTo?.id, undefined, attachmentIds.length > 0 ? attachmentIds : undefined)
    setInput('')
    setReplyTo(null)
    setAttachments([])
  }

  const handleCopy = (content: string) => {
    navigator.clipboard.writeText(stripProtocolMarkers(content))
  }

  const handleQuote = (content: string) => {
    setInput(stripProtocolMarkers(content))
  }

  const handleCopyProjectDir = () => {
    const dir = sessionMeta?.projectDir?.trim()
    if (!dir) {
      toast.info('当前会话未指定项目目录，使用应用工作目录')
      return
    }
    navigator.clipboard.writeText(dir)
      .then(() => toast.success('项目目录已复制'))
      .catch(() => toast.error('复制项目目录失败'))
  }

  const switchToAuto = async () => {
    if (!sessionId || switchingToAuto) return
    setSwitchingToAuto(true)
    try {
      const res = await fetch(`/api/sessions/${sessionId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ permissionMode: 'auto' }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => null) as { error?: string } | null
        throw new Error(data?.error || '切换失败')
      }
      setSessionMeta(prev => prev ? { ...prev, permissionMode: 'auto' } : prev)
      toast.success('已切换为自动模式')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '切换自动模式失败')
    } finally {
      setSwitchingToAuto(false)
    }
  }

  const handleRegenerate = (messageId: string) => {
    send('', undefined, undefined, undefined, messageId)
  }

  const handlePin = async (messageId: string, isPinned: boolean) => {
    await fetch(`/api/sessions/${sessionId}/messages/${messageId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isPinned }),
    })
    loadMessages()
  }

  return (
    <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
      <SessionHeader
        sessionType={sessionType}
        phase={effectivePhase}
        phaseStep={headerStep}
        projectDir={sessionMeta?.projectDir}
        permissionMode={sessionMeta?.permissionMode}
        pendingPermissionCount={pendingPermissions.length}
        systemEventCount={systemEvents.length}
        onOpenSystemEvents={() => setSystemDrawerOpen(true)}
        taskCounts={taskCounts}
        currentTask={currentTask}
        loading={loading}
        sessionStartedAt={sessionMeta?.createdAt}
        waitingReason={waitingReason}
        waitingSince={waitingSince}
        onStop={stop}
        onCopyProjectDir={handleCopyProjectDir}
      />
      {sessionMeta?.permissionMode === 'default' && hasOpenCodeMember && (
        <div className="border-b border-amber-200 bg-amber-50 px-4 py-1.5 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200 flex items-center gap-2">
          <ShieldAlert className="w-3.5 h-3.5 shrink-0" />
          <span className="min-w-0 truncate">
            当前会话包含 OpenCode 智能体，默认模式下写文件/执行命令会被拒绝。
          </span>
          <button
            type="button"
            onClick={switchToAuto}
            disabled={switchingToAuto}
            className="ml-auto shrink-0 font-medium underline underline-offset-2 disabled:opacity-50"
          >
            {switchingToAuto ? '切换中...' : '切换自动模式'}
          </button>
        </div>
      )}
      {showProductsGuide && (
        <div className="border-b border-blue-200 bg-blue-50 px-4 py-2 text-xs text-blue-900 dark:border-blue-900/60 dark:bg-blue-950/40 dark:text-blue-200 flex items-center gap-2">
          <Info className="h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0">
            产物在聊天消息里：Diff 可直接 Accept/Reject；文件卡片可下载；任务卡「轨迹」可查看执行记录。
          </span>
          <button
            type="button"
            onClick={dismissProductsGuide}
            className="ml-auto shrink-0 font-medium underline underline-offset-2"
          >
            知道了
          </button>
        </div>
      )}
      <ScrollArea className="flex-1 min-h-0 overflow-hidden px-4 py-5" onScroll={(e) => {
        const el = e.currentTarget
        nearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 150
      }}>
        <div className="space-y-4 max-w-4xl mx-auto">
          {messagesReady && chatItems.length === 0 && !loading &&
            Object.keys(streaming).length === 0 &&
            Object.keys(thinking).length === 0 &&
            toolCalls.length === 0 && (
              <EmptyState
                title="还没有消息"
                description="在下方描述你的目标，Orchestrator 会先和你对齐需求，再拆解任务。"
              />
            )}
          {chatItems.map(item => {
            if (item.type === 'system') {
              return (
                <SystemEventNotice
                  key={`system-${item.events[0].id}`}
                  events={item.events}
                  onOpen={() => setSystemDrawerOpen(true)}
                />
              )
            }
            const msg = item.message
            const replyText = msg.replyTo ? stripProtocolMarkers(msg.replyTo.rawContent) : ''
            const replyPreview = msg.replyTo
              ? (
                <div className="text-xs text-gray-500 dark:text-gray-400 bg-gray-50 dark:bg-gray-800 rounded px-2 py-1 mb-1 border-l-2 border-gray-300 dark:border-gray-600">
                  {replyText.slice(0, 80)}{replyText.length > 80 ? '...' : ''}
                </div>
              )
              : null

            if (msg.role === 'agent' && msg.agentId) {
              const style = getAgentStyle(msg.agentId, agentColorMap[msg.agentId])
              const parsed = parseMessage(normalizeAgentSelfIntro(msg.rawContent, msg.agentId))
              const agentName = agentIdToName[msg.agentId] || msg.agentId
              return (
                <div key={msg.id} className="flex gap-2 max-w-[92%] sm:max-w-[86%] group relative">
                  {msg.isPinned && (
                    <Pin className="absolute -top-1 -left-1 w-3 h-3 text-amber-500 fill-amber-500 z-10" />
                  )}
                  <Avatar size="sm">
                    <AvatarFallback className={style.avatarBg}>{style.initial}</AvatarFallback>
                  </Avatar>
                  <div className={`rounded-xl p-3.5 border border-black/5 dark:border-white/10 shadow-sm ${style.bg} flex-1`}>
                    <div className="flex items-start justify-between gap-2 mb-1.5">
                      <div className="flex min-w-0 items-center gap-2">
                        <span className="truncate text-xs font-semibold opacity-80">{agentName}</span>
                        <time
                          dateTime={msg.createdAt}
                          title={formatMessageFullTime(msg.createdAt)}
                          className="shrink-0 text-xs font-normal opacity-60"
                        >
                          {formatMessageClock(msg.createdAt)}
                        </time>
                      </div>
                      <MessageActionMenu
                        role="agent"
                        isPinned={msg.isPinned}
                        onReply={() => setReplyTo({ id: msg.id, rawContent: msg.rawContent, role: msg.agentId || 'agent' })}
                        onCopy={() => handleCopy(msg.rawContent)}
                        onQuote={() => handleQuote(msg.rawContent)}
                        onRegenerate={() => handleRegenerate(msg.id)}
                        onPin={() => handlePin(msg.id, !msg.isPinned)}
                      />
                    </div>
                    {replyPreview}
                    {msg.attachments && msg.attachments.length > 0 && (
                      <div className="flex flex-wrap gap-2 mb-2">
                        {msg.attachments.map(att => (
                          att.mimeType.startsWith('image/') ? (
                            <img
                              key={att.id}
                              src={`/api/attachments/${att.id}`}
                              alt={att.filename}
                              className="max-w-[300px] max-h-[200px] rounded border object-contain cursor-pointer"
                              onClick={() => window.open(`/api/attachments/${att.id}`, '_blank')}
                            />
                          ) : (
                            <FileCard
                              key={att.id}
                              fileName={att.filename}
                              fileSize={att.size}
                              downloadUrl={`/api/attachments/${att.id}`}
                            />
                          )
                        ))}
                      </div>
                    )}
                    <MessageErrorBoundary><MessageContent parsed={parsed} sessionId={sessionId} /></MessageErrorBoundary>
                  </div>
                </div>
              )
            }
            const style = ROLE_STYLES[msg.role] || ROLE_STYLES.orchestrator
            const roleName = msg.role === 'orchestrator' ? 'Orchestrator' : (msg.agentId || '智能体')
            const parsed = parseMessage(
              msg.role === 'user' ? msg.rawContent : normalizeAgentSelfIntro(msg.rawContent, roleName)
            )
            const isUser = msg.role === 'user'
            return (
              <div
                key={msg.id}
                className={`${isUser ? 'max-w-[85%] sm:max-w-[60%] ml-auto' : 'max-w-[90%] sm:max-w-[78%]'} rounded-xl p-3 ${style.bg} group relative`}
              >
                {msg.isPinned && (
                  <Pin className="absolute -top-1 -right-1 w-3 h-3 text-amber-500 fill-amber-500 z-10" />
                )}
                <div className="flex items-start justify-between gap-2 mb-1.5">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="truncate text-xs font-semibold opacity-80">{style.label}</span>
                    <time
                      dateTime={msg.createdAt}
                      title={formatMessageFullTime(msg.createdAt)}
                      className="shrink-0 text-xs font-normal opacity-60"
                    >
                      {formatMessageClock(msg.createdAt)}
                    </time>
                  </div>
                  <MessageActionMenu
                    role={msg.role}
                    isPinned={msg.isPinned}
                    onReply={() => setReplyTo({ id: msg.id, rawContent: msg.rawContent, role: msg.role })}
                    onCopy={() => handleCopy(msg.rawContent)}
                    onQuote={() => handleQuote(msg.rawContent)}
                    onRegenerate={msg.role !== 'user' ? () => handleRegenerate(msg.id) : undefined}
                    onPin={() => handlePin(msg.id, !msg.isPinned)}
                  />
                </div>
                {replyPreview}
                {msg.attachments && msg.attachments.length > 0 && (
                  <div className="flex flex-wrap gap-2 mb-2">
                    {msg.attachments.map(att => (
                      att.mimeType.startsWith('image/') ? (
                        <img
                          key={att.id}
                          src={`/api/attachments/${att.id}`}
                          alt={att.filename}
                          className="max-w-[300px] max-h-[200px] rounded border object-contain cursor-pointer"
                          onClick={() => window.open(`/api/attachments/${att.id}`, '_blank')}
                        />
                      ) : (
                        <FileCard
                          key={att.id}
                          fileName={att.filename}
                          fileSize={att.size}
                          downloadUrl={`/api/attachments/${att.id}`}
                        />
                      )
                    ))}
                  </div>
                )}
                <MessageErrorBoundary><MessageContent parsed={parsed} sessionId={sessionId} markdown={msg.role !== 'user'} /></MessageErrorBoundary>
              </div>
            )
          })}
          {/* Thinking 展示 */}
          {Object.entries(thinking).map(([agentId, text]) => {
            if (!text) return null
            const style = getAgentStyle(agentId, agentColorMap[agentId])
            return (
              <div key={`thinking-${agentId}`} className="flex gap-2 max-w-[92%] sm:max-w-[86%]">
                <Avatar size="sm">
                  <AvatarFallback className={style.avatarBg}>{style.initial}</AvatarFallback>
                </Avatar>
                <div className="rounded-lg p-3 bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700">
                  <div className="text-xs font-medium mb-1 text-gray-400 dark:text-gray-500">💭 {agentId} 思考中...</div>
                  <div className="text-sm text-gray-500 dark:text-gray-400 italic whitespace-pre-wrap">{text}</div>
                </div>
              </div>
            )
          })}
          {/* Tool Calls 展示 */}
          {toolCalls.map(tc => (
            <div key={tc.id} className="flex gap-2 max-w-[92%] sm:max-w-[86%] ml-8">
              <div className={`rounded-lg p-2 text-xs font-mono border ${tc.status === 'running' ? 'bg-blue-50 dark:bg-blue-950 border-blue-200 dark:border-blue-800' : 'bg-gray-50 dark:bg-gray-800 border-gray-200 dark:border-gray-700'}`}>
                <div className="flex items-center gap-1 mb-1">
                  {tc.status === 'running' ? (
                    <span className="animate-spin">⚙️</span>
                  ) : (
                    <span>✅</span>
                  )}
                  <span className="font-semibold">{tc.toolName}</span>
                </div>
                {tc.toolInput && Object.keys(tc.toolInput).length > 0 && (
                  <pre className="text-xs overflow-x-auto max-w-md">{JSON.stringify(tc.toolInput, null, 2)}</pre>
                )}
                {tc.toolResult && (
                  <div className="mt-1 pt-1 border-t border-gray-200">
                    <pre className="text-xs overflow-x-auto max-w-md max-h-32 overflow-y-auto">{tc.toolResult}</pre>
                  </div>
                )}
              </div>
            </div>
          ))}
          {/* Streaming 文本展示 */}
          {Object.entries(streaming).map(([agentId, text]) => {
            const style = getAgentStyle(agentId, agentColorMap[agentId])
            return (
              <div key={agentId} className="flex gap-2 max-w-[92%] sm:max-w-[86%]">
                <Avatar size="sm">
                  <AvatarFallback className={style.avatarBg}>{style.initial}</AvatarFallback>
                </Avatar>
                <div className={`rounded-lg p-3 ${style.bg}`}>
                  <div className="text-xs font-medium mb-1 opacity-70">{agentId}</div>
                  <div className="text-sm whitespace-pre-wrap">{text}<span className="animate-pulse">|</span></div>
                </div>
              </div>
            )
          })}
          <div ref={bottomRef} />
        </div>
      </ScrollArea>
      {replyTo && (
        <div className="border-t px-3 py-2 flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400 bg-gray-50 dark:bg-gray-800 dark:border-gray-700">
          <span className="truncate flex-1">回复 {replyTo.role}: {replyTo.rawContent.slice(0, 60)}...</span>
          <button onClick={() => setReplyTo(null)} className="text-gray-400 dark:text-gray-500 hover:text-gray-600">✕</button>
        </div>
      )}
      {awaitingInput && (
        <div className="border-t px-3 py-2 text-sm text-blue-600 bg-blue-50">
          {awaitingInput === 'pm_confirm' && '产品经理已确认需求，请查看并回复'}
          {awaitingInput === 'architect_plan' && '架构师已出方案，请查看并确认'}
          {awaitingInput === 'agent_qa' && '智能体有问题需要你回答'}
          {!['pm_confirm', 'architect_plan', 'agent_qa'].includes(awaitingInput) && '等待你的输入...'}
        </div>
      )}
      {pendingPermissions.length > 0 && pendingPermissions.map(p => (
        <div key={p.requestId} className="border-t px-3 py-2 text-sm bg-amber-50 text-amber-800 flex items-center justify-between">
          <span className="flex items-center gap-1">
            <Shield className="w-4 h-4" />
            智能体请求使用 <strong>{p.toolName}</strong>
            {p.toolName === 'Bash' && !!p.toolInput?.command && (
              <code className="ml-1 text-xs bg-amber-100 px-1 rounded">
                {String(p.toolInput.command).slice(0, 80)}
              </code>
            )}
            {p.toolName === 'Write' && !!p.toolInput?.file_path && (
              <code className="ml-1 text-xs bg-amber-100 px-1 rounded">
                {String(p.toolInput.file_path)}
              </code>
            )}
          </span>
          <div className="flex gap-2">
            <Button size="xs" variant="destructive" onClick={() => respondPermission(p.requestId, 'deny')}>拒绝</Button>
            <Button size="xs" onClick={() => respondPermission(p.requestId, 'allow')}>允许</Button>
          </div>
        </div>
      ))}
      <div className="border-t p-3">
        {showCommands && (
          <div className="mb-2 bg-white dark:bg-gray-800 border dark:border-gray-700 rounded-lg shadow-lg max-h-48 overflow-y-auto">
            {COMMANDS
              .filter(cmd => cmd.name.startsWith(input))
              .map(cmd => (
                <button
                  key={cmd.name}
                  className="w-full px-3 py-2 text-left hover:bg-gray-100 flex items-center gap-2"
                  onClick={() => handleCommandSelect(cmd.name)}
                >
                  <span className="font-mono text-sm text-blue-600">{cmd.name}</span>
                  <span className="text-xs text-gray-500">{cmd.description}</span>
                </button>
              ))
            }
          </div>
        )}
        {showMentions && (
          <div className="mb-2 bg-white dark:bg-gray-800 border dark:border-gray-700 rounded-lg shadow-lg max-h-48 overflow-y-auto">
            <button
              className="w-full px-3 py-2 text-left hover:bg-gray-100 dark:hover:bg-gray-700 flex items-center gap-2"
              onClick={() => handleMentionSelect('所有人')}
            >
              <span className="text-lg">👥</span>
              <span className="text-sm font-medium">所有人</span>
              <span className="text-xs text-gray-500">让所有智能体参与讨论</span>
            </button>
            {agentNames
              .filter(name => name.toLowerCase().includes(mentionQuery.toLowerCase()))
              .map(name => (
                <button
                  key={name}
                  className="w-full px-3 py-2 text-left hover:bg-gray-100 dark:hover:bg-gray-700 flex items-center gap-2"
                  onClick={() => handleMentionSelect(name)}
                >
                  <Avatar className="h-5 w-5">
                    <AvatarFallback
                      className="text-xs text-white"
                      style={{ backgroundColor: agentColorMap[name] || '#6b7280' }}
                    >
                      {name.charAt(0)}
                    </AvatarFallback>
                  </Avatar>
                  <span className="text-sm font-medium">{name}</span>
                </button>
              ))
            }
            {agentNames.filter(name => name.toLowerCase().includes(mentionQuery.toLowerCase())).length === 0 && (
              <div className="px-3 py-2 text-sm text-gray-400">没有匹配的智能体</div>
            )}
          </div>
        )}
        <div className="flex gap-2 items-end">
          {sessionId && (
            <AttachmentInput
              sessionId={sessionId}
              attachments={attachments}
              onAttachmentsChange={setAttachments}
            />
          )}
          <Input
            value={input}
            onChange={handleInputChange}
            onKeyDown={e => e.key === 'Enter' && !e.shiftKey && handleSend()}
            placeholder="输入消息…（/ 命令，@智能体名 指定执行，@所有人 讨论）"
            disabled={loading}
          />
          {loading ? (
            <Button onClick={stop} variant="destructive" size="sm">停止</Button>
          ) : (
            <Button onClick={handleSend} disabled={!input.trim()} size="sm">发送</Button>
          )}
        </div>
      </div>
      <Dialog open={showRecovery} onOpenChange={setShowRecovery}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>发现未完成的任务</DialogTitle>
            <DialogDescription>
              上次有 {recoveredCount} 个任务未完成，已自动恢复为待执行状态。是否继续执行？
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowRecovery(false)}>跳过</Button>
            <Button onClick={() => { setShowRecovery(false); send('继续执行未完成的任务') }}>继续执行</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <SystemEventDrawer
        open={systemDrawerOpen}
        onOpenChange={setSystemDrawerOpen}
        events={systemEvents}
      />
    </div>
  )
}

class MessageErrorBoundary extends Component<{ children: ReactNode }, { hasError: boolean }> {
  state = { hasError: false }
  static getDerivedStateFromError() { return { hasError: true } }
  render() {
    if (this.state.hasError) {
      return <div className="text-xs text-red-500 dark:text-red-400 italic p-2 rounded bg-red-50 dark:bg-red-950">消息渲染失败</div>
    }
    return this.props.children
  }
}

function MessageContent({ parsed, sessionId, markdown = true }: { parsed: ParsedMessage; sessionId: string; markdown?: boolean }) {
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null)
  const [diffStatus, setDiffStatus] = useState<Record<number, 'accepted' | 'rejected'>>({})

  const handleCopy = (code: string, idx: number) => {
    navigator.clipboard.writeText(code)
    setCopiedIdx(idx)
    setTimeout(() => setCopiedIdx(null), 2000)
  }

  const handleAccept = async (idx: number, filePath: string, content: string) => {
    try {
      const res = await fetch(`/api/sessions/${sessionId}/files/accept`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filePath, content }),
      })
      if (res.status === 409) {
        const confirmed = window.confirm('文件已被外部修改，是否覆盖？')
        if (!confirmed) return
        const retryRes = await fetch(`/api/sessions/${sessionId}/files/accept`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ filePath, content, force: true }),
        })
        if (!retryRes.ok) {
          const data = await retryRes.json().catch(() => null)
          throw new Error(data?.error || `覆盖失败 (${retryRes.status})`)
        }
        setDiffStatus(prev => ({ ...prev, [idx]: 'accepted' }))
        return
      }
      if (!res.ok) {
        const data = await res.json().catch(() => null)
        throw new Error(data?.error || `接受失败 (${res.status})`)
      }
      setDiffStatus(prev => ({ ...prev, [idx]: 'accepted' }))
    } catch (e) {
      console.error('Accept failed:', e)
      toast.error(e instanceof Error ? e.message : '接受文件失败')
    }
  }

  const handleReject = (idx: number) => {
    setDiffStatus(prev => ({ ...prev, [idx]: 'rejected' }))
  }

  const parts = parsed.text.split(/__(?:CODE_BLOCK|ARTIFACT)_(\d+)__/)
  return (
    <div className="text-sm leading-relaxed">
      {parts.map((part, i) => {
        if (i % 2 === 1) {
          const codeBlock = parsed.codeBlocks[parseInt(part)]
          if (codeBlock) {
            return (
              <div key={i} className="relative my-2 rounded bg-gray-900 text-gray-100">
                <div className="flex items-center justify-between px-3 py-1 text-xs text-gray-400 border-b border-gray-700">
                  <span>{codeBlock.language}</span>
                  <button onClick={() => handleCopy(codeBlock.code, i)} className="hover:text-white">
                    {copiedIdx === i ? '已复制' : '复制'}
                  </button>
                </div>
                <pre className="p-3 overflow-x-auto"><code>{codeBlock.code}</code></pre>
              </div>
            )
          }

          const artifact = parsed.artifacts[parseInt(part)]
          if (artifact) {
            if (artifact.type === 'web-preview') {
              return <div key={i} className="my-2"><WebPreview html={artifact.content} /></div>
            }
            if (artifact.type === 'diff') {
              const status = diffStatus[i]
              if (status === 'accepted') {
                return <div key={i} className="my-2 text-green-600 text-xs">✓ 已接受</div>
              }
              if (status === 'rejected') {
                return <div key={i} className="my-2 text-gray-500 text-xs">✗ 已拒绝</div>
              }
              const data = artifact.meta
              return (
                <div key={i} className="my-2">
                  <CodeDiff
                    original={data.original || ''}
                    modified={data.modified || artifact.content}
                    language={data.language || 'javascript'}
                    onAccept={() => handleAccept(i, data.filePath || 'output.txt', data.modified || artifact.content)}
                    onReject={() => handleReject(i)}
                  />
                </div>
              )
            }
            if (artifact.type === 'file') {
              return (
                <div key={i} className="my-2">
                  <FileCard
                    fileName={artifact.meta.fileName || 'file'}
                    fileSize={artifact.meta.fileSize ? parseInt(artifact.meta.fileSize) : undefined}
                    downloadUrl={artifact.meta.downloadUrl}
                  />
                </div>
              )
            }
            return <div key={i} className="my-2 text-xs text-gray-500">[{artifact.type}]</div>
          }

          return null
        }
        return part ? (
          markdown
            ? <MarkdownMessage key={i} content={part} />
            : <span key={i} className="whitespace-pre-wrap">{part}</span>
        ) : null
      })}
    </div>
  )
}
