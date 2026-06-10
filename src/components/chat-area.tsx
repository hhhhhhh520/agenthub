'use client'
import { useEffect, useRef, useState } from 'react'
import { useChat } from '@/lib/hooks/use-chat'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { getAgentStyle } from '@/lib/agent-colors'
import { parseMessage, type ParsedMessage } from '@/lib/message-parser'
import { MessageActionMenu } from '@/components/message-action-menu'
import { WebPreview } from '@/components/web-preview'
import { CodeDiff } from '@/components/code-diff'
import { Shield, Pin } from 'lucide-react'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { FileCard } from '@/components/file-card'
import { AttachmentInput, type AttachmentPreview } from '@/components/attachment-input'

const ROLE_STYLES: Record<string, { bg: string; label: string }> = {
  user: { bg: 'bg-blue-500 text-white ml-auto', label: 'You' },
  orchestrator: { bg: 'bg-purple-100 text-purple-900', label: 'Orchestrator' },
}

interface MemberAgent {
  id: string
  name: string
  accentColor?: string
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
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!sessionId) return
    loadMessages()
    fetch(`/api/sessions/${sessionId}/members`)
      .then(r => r.json())
      .then((members: Array<{ agent: MemberAgent }>) => {
        const names = members.map(m => m.agent.name)
        const colorMap: Record<string, string> = {}
        members.forEach(m => {
          if (m.agent.accentColor) colorMap[m.agent.name] = m.agent.accentColor
        })
        setAgentNames(names)
        setAgentColorMap(colorMap)
      })
      .catch(() => {})
    // 断点续跑：检查是否有任务被恢复
    fetch(`/api/sessions/${sessionId}`)
      .then(r => r.json())
      .then((session: { recoveredTaskCount?: number }) => {
        if (session.recoveredTaskCount && session.recoveredTaskCount > 0) {
          setRecoveredCount(session.recoveredTaskCount)
          setShowRecovery(true)
        }
      })
      .catch(() => {})
  }, [sessionId, loadMessages])
  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [messages, streaming])

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
    return <div className="flex-1 flex items-center justify-center text-gray-400">选择或创建一个会话</div>
  }

  const handleSend = () => {
    const mentionAll = input.includes('@所有人')
    let targetAgent: string | undefined
    if (!mentionAll) {
      const match = input.match(/@(\S+)/)
      if (match && agentNames.includes(match[1])) {
        targetAgent = match[1]
      }
    }
    const attachmentIds = attachments.filter(a => !a.uploading).map(a => a.id)
    send(input, mentionAll, targetAgent, replyTo?.id, undefined, attachmentIds.length > 0 ? attachmentIds : undefined)
    setInput('')
    setReplyTo(null)
    setAttachments([])
  }

  const handleCopy = (content: string) => {
    navigator.clipboard.writeText(content)
  }

  const handleQuote = (content: string) => {
    setInput(content)
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

  const SESSION_TYPE_LABELS: Record<string, string> = {
    group: '群聊',
    private: '私聊',
    orchestrator: '对话',
  }

  const PHASE_LABELS: Record<string, string> = {
    alignment: '对齐中',
    execution: '执行中',
    done: '已完成',
  }

  return (
    <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
      {sessionType && (
        <div className="border-b px-4 py-2 flex items-center gap-2 text-sm bg-white">
          <span className="px-2 py-0.5 rounded text-xs font-medium bg-gray-100 text-gray-600">
            {SESSION_TYPE_LABELS[sessionType] || sessionType}
          </span>
          {phase !== 'idle' && PHASE_LABELS[phase] && (
            <span className="flex items-center gap-1.5 text-xs text-gray-400">
              <span className={`w-1.5 h-1.5 rounded-full ${phase === 'done' ? 'bg-blue-500' : phase === 'execution' ? 'bg-green-500 animate-pulse' : 'bg-amber-500'}`} />
              {PHASE_LABELS[phase]}
            </span>
          )}
        </div>
      )}
      <ScrollArea className="flex-1 min-h-0 overflow-hidden p-4">
        <div className="space-y-3 max-w-3xl mx-auto">
          {messages.map(msg => {
            const replyPreview = msg.replyTo
              ? (
                <div className="text-xs text-gray-500 bg-gray-50 rounded px-2 py-1 mb-1 border-l-2 border-gray-300">
                  {msg.replyTo.rawContent.slice(0, 80)}{msg.replyTo.rawContent.length > 80 ? '...' : ''}
                </div>
              )
              : null

            if (msg.role === 'agent' && msg.agentId) {
              const style = getAgentStyle(msg.agentId, agentColorMap[msg.agentId])
              const parsed = parseMessage(msg.rawContent)
              return (
                <div key={msg.id} className="flex gap-2 max-w-[80%] group relative">
                  {msg.isPinned && (
                    <Pin className="absolute -top-1 -left-1 w-3 h-3 text-amber-500 fill-amber-500 z-10" />
                  )}
                  <Avatar size="sm">
                    <AvatarFallback className={style.avatarBg}>{style.initial}</AvatarFallback>
                  </Avatar>
                  <div className={`rounded-lg p-3 ${style.bg} flex-1`}>
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-xs font-medium opacity-70">{msg.agentId}</span>
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
                    <MessageContent parsed={parsed} sessionId={sessionId} />
                  </div>
                </div>
              )
            }
            const style = ROLE_STYLES[msg.role] || ROLE_STYLES.orchestrator
            const parsed = parseMessage(msg.rawContent)
            return (
              <div key={msg.id} className={`max-w-[80%] rounded-lg p-3 ${msg.role === 'user' ? style.bg + ' ml-auto' : style.bg} group relative`}>
                {msg.isPinned && (
                  <Pin className="absolute -top-1 -right-1 w-3 h-3 text-amber-500 fill-amber-500 z-10" />
                )}
                <div className="flex items-center justify-between mb-1">
                  <span className="text-xs font-medium opacity-70">{style.label}</span>
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
                <MessageContent parsed={parsed} sessionId={sessionId} />
              </div>
            )
          })}
          {/* Thinking 展示 */}
          {Object.entries(thinking).map(([agentId, text]) => {
            if (!text) return null
            const style = getAgentStyle(agentId, agentColorMap[agentId])
            return (
              <div key={`thinking-${agentId}`} className="flex gap-2 max-w-[80%]">
                <Avatar size="sm">
                  <AvatarFallback className={style.avatarBg}>{style.initial}</AvatarFallback>
                </Avatar>
                <div className="rounded-lg p-3 bg-gray-50 border border-gray-200">
                  <div className="text-xs font-medium mb-1 text-gray-400">💭 {agentId} 思考中...</div>
                  <div className="text-sm text-gray-500 italic whitespace-pre-wrap">{text}</div>
                </div>
              </div>
            )
          })}
          {/* Tool Calls 展示 */}
          {toolCalls.map(tc => (
            <div key={tc.id} className="flex gap-2 max-w-[80%] ml-8">
              <div className={`rounded-lg p-2 text-xs font-mono border ${tc.status === 'running' ? 'bg-blue-50 border-blue-200' : 'bg-gray-50 border-gray-200'}`}>
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
              <div key={agentId} className="flex gap-2 max-w-[80%]">
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
        <div className="border-t px-3 py-2 flex items-center gap-2 text-sm text-gray-500 bg-gray-50">
          <span className="truncate flex-1">回复 {replyTo.role}: {replyTo.rawContent.slice(0, 60)}...</span>
          <button onClick={() => setReplyTo(null)} className="text-gray-400 hover:text-gray-600">✕</button>
        </div>
      )}
      {awaitingInput && (
        <div className="border-t px-3 py-2 text-sm text-blue-600 bg-blue-50">
          {awaitingInput === 'pm_confirm' && '产品经理已确认需求，请查看并回复'}
          {awaitingInput === 'architect_plan' && '架构师已出方案，请查看并确认'}
          {awaitingInput === 'agent_qa' && 'Agent 有问题需要你回答'}
          {!['pm_confirm', 'architect_plan', 'agent_qa'].includes(awaitingInput) && '等待你的输入...'}
        </div>
      )}
      {pendingPermissions.length > 0 && pendingPermissions.map(p => (
        <div key={p.requestId} className="border-t px-3 py-2 text-sm bg-amber-50 text-amber-800 flex items-center justify-between">
          <span className="flex items-center gap-1">
            <Shield className="w-4 h-4" />
            Agent 请求使用 <strong>{p.toolName}</strong>
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
      {phase !== 'idle' && (
        <div className="border-t px-3 py-1 text-xs text-gray-400 bg-gray-50 flex items-center gap-2">
          <span className={`w-2 h-2 rounded-full ${phase === 'done' ? 'bg-blue-500' : phase === 'execution' ? 'bg-green-500 animate-pulse' : 'bg-amber-500'}`} />
          {phase === 'alignment' && '对齐中'}
          {phase === 'execution' && '执行中'}
          {phase === 'done' && '已完成'}
        </div>
      )}
      <div className="border-t p-3">
        {showCommands && (
          <div className="mb-2 bg-white border rounded-lg shadow-lg max-h-48 overflow-y-auto">
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
          <div className="mb-2 bg-white border rounded-lg shadow-lg max-h-48 overflow-y-auto">
            <button
              className="w-full px-3 py-2 text-left hover:bg-gray-100 flex items-center gap-2"
              onClick={() => handleMentionSelect('所有人')}
            >
              <span className="text-lg">👥</span>
              <span className="text-sm font-medium">所有人</span>
              <span className="text-xs text-gray-500">让所有 Agent 参与讨论</span>
            </button>
            {agentNames
              .filter(name => name.toLowerCase().includes(mentionQuery.toLowerCase()))
              .map(name => (
                <button
                  key={name}
                  className="w-full px-3 py-2 text-left hover:bg-gray-100 flex items-center gap-2"
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
              <div className="px-3 py-2 text-sm text-gray-400">无匹配的 Agent</div>
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
            placeholder="输入消息... (/ 命令，@Agent名 指定执行，@所有人 讨论)"
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
    </div>
  )
}

function MessageContent({ parsed, sessionId }: { parsed: ParsedMessage; sessionId: string }) {
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
        if (retryRes.ok) setDiffStatus(prev => ({ ...prev, [idx]: 'accepted' }))
        return
      }
      if (res.ok) {
        setDiffStatus(prev => ({ ...prev, [idx]: 'accepted' }))
      }
    } catch (e) {
      console.error('Accept failed:', e)
    }
  }

  const handleReject = (idx: number) => {
    setDiffStatus(prev => ({ ...prev, [idx]: 'rejected' }))
  }

  const parts = parsed.text.split(/__(?:CODE_BLOCK|ARTIFACT)_(\d+)__/)
  return (
    <div className="text-sm">
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
        return part ? <span key={i} className="whitespace-pre-wrap">{part}</span> : null
      })}
    </div>
  )
}
