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
import { FileCard } from '@/components/file-card'

const ROLE_STYLES: Record<string, { bg: string; label: string }> = {
  user: { bg: 'bg-blue-500 text-white ml-auto', label: 'You' },
  orchestrator: { bg: 'bg-purple-100 text-purple-900', label: 'Orchestrator' },
}

interface MemberAgent {
  id: string
  name: string
  accentColor?: string
}

export function ChatArea({ sessionId }: { sessionId: string | null }) {
  const { messages, streaming, loading, send, stop, loadMessages, phase, awaitingInput } = useChat(sessionId)
  const [input, setInput] = useState('')
  const [agentNames, setAgentNames] = useState<string[]>([])
  const [agentColorMap, setAgentColorMap] = useState<Record<string, string>>({})
  const [replyTo, setReplyTo] = useState<{ id: string; rawContent: string; role: string } | null>(null)
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
  }, [sessionId, loadMessages])
  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [messages, streaming])

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
    send(input, mentionAll, targetAgent, replyTo?.id)
    setInput('')
    setReplyTo(null)
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

  return (
    <div className="flex-1 flex flex-col">
      <ScrollArea className="flex-1 p-4">
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
                <div key={msg.id} className="flex gap-2 max-w-[80%] group">
                  <Avatar size="sm">
                    <AvatarFallback className={style.avatarBg}>{style.initial}</AvatarFallback>
                  </Avatar>
                  <div className={`rounded-lg p-3 ${style.bg} flex-1`}>
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-xs font-medium opacity-70">{msg.agentId}</span>
                      <MessageActionMenu
                        role="agent"
                        onReply={() => setReplyTo({ id: msg.id, rawContent: msg.rawContent, role: msg.agentId || 'agent' })}
                        onCopy={() => handleCopy(msg.rawContent)}
                        onQuote={() => handleQuote(msg.rawContent)}
                        onRegenerate={() => handleRegenerate(msg.id)}
                      />
                    </div>
                    {replyPreview}
                    <MessageContent parsed={parsed} sessionId={sessionId} />
                  </div>
                </div>
              )
            }
            const style = ROLE_STYLES[msg.role] || ROLE_STYLES.orchestrator
            const parsed = parseMessage(msg.rawContent)
            return (
              <div key={msg.id} className={`max-w-[80%] rounded-lg p-3 ${msg.role === 'user' ? style.bg + ' ml-auto' : style.bg} group`}>
                <div className="flex items-center justify-between mb-1">
                  <span className="text-xs font-medium opacity-70">{style.label}</span>
                  <MessageActionMenu
                    role={msg.role}
                    onReply={() => setReplyTo({ id: msg.id, rawContent: msg.rawContent, role: msg.role })}
                    onCopy={() => handleCopy(msg.rawContent)}
                    onQuote={() => handleQuote(msg.rawContent)}
                    onRegenerate={msg.role !== 'user' ? () => handleRegenerate(msg.id) : undefined}
                  />
                </div>
                {replyPreview}
                <MessageContent parsed={parsed} sessionId={sessionId} />
              </div>
            )
          })}
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
      {phase !== 'idle' && (
        <div className="border-t px-3 py-1 text-xs text-gray-400 bg-gray-50 flex items-center gap-2">
          <span className={`w-2 h-2 rounded-full ${phase === 'done' ? 'bg-blue-500' : phase === 'execution' ? 'bg-green-500 animate-pulse' : 'bg-amber-500'}`} />
          {phase === 'alignment' && '对齐中'}
          {phase === 'execution' && '执行中'}
          {phase === 'done' && '已完成'}
        </div>
      )}
      <div className="border-t p-3 flex gap-2">
        <Input
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && !e.shiftKey && handleSend()}
          placeholder="输入消息... (@Agent名 指定执行，@所有人 讨论)"
          disabled={loading}
        />
        {loading ? (
          <Button onClick={stop} variant="destructive" size="sm">停止</Button>
        ) : (
          <Button onClick={handleSend} disabled={!input.trim()} size="sm">发送</Button>
        )}
      </div>
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
