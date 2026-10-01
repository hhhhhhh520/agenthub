'use client'
import { Suspense, useState, useEffect } from 'react'
import { SessionSidebar } from '@/components/session-sidebar'
import { ChatArea } from '@/components/chat-area'
import { AgentPanel } from '@/components/agent-panel'
import { CreateGroupDialog } from '@/components/create-group-dialog'
import { useSessions } from '@/lib/hooks/use-sessions'

function ChatContent() {
  const { sessions, activeId, setActiveId, create, remove, refresh, isLoading } = useSessions()
  const [showCreateGroup, setShowCreateGroup] = useState(false)

  return (
    <div className="flex h-screen overflow-hidden">
      <SessionSidebar
        sessions={sessions}
        activeId={activeId}
        isLoading={isLoading}
        onSelect={setActiveId}
        onCreateGroup={() => setShowCreateGroup(true)}
        onQuickStart={async () => {
          const session = await create('与 Orchestrator 对话', 'orchestrator')
          await refresh()
          setActiveId(session.id)
        }}
        onDelete={remove}
      />
      <CreateGroupDialog
        open={showCreateGroup}
        onOpenChange={setShowCreateGroup}
        onCreated={async (sessionId) => {
          await refresh()
          setActiveId(sessionId)
        }}
      />
      <div className="flex-1 flex overflow-hidden">
        <ChatArea sessionId={activeId} sessionType={sessions.find(s => s.id === activeId)?.type} />
        <AgentPanel
          sessionId={activeId}
          onPrivateChat={async (agentId, agentName) => {
            // 从来源会话继承 projectDir（否则私聊 agent 的 workDir 回落 process.cwd()，"失忆"用户工作目录）
            await create(`私聊: ${agentName}`, 'private', [agentId], sessions.find(s => s.id === activeId)?.projectDir || undefined)
          }}
        />
      </div>
    </div>
  )
}

export default function ChatPage() {
  return (
    <Suspense>
      <ChatContent />
    </Suspense>
  )
}
