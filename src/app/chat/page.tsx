'use client'
import { Suspense, useState, useEffect } from 'react'
import { SessionSidebar } from '@/components/session-sidebar'
import { ChatArea } from '@/components/chat-area'
import { AgentPanel } from '@/components/agent-panel'
import { CreateGroupDialog } from '@/components/create-group-dialog'
import { useSessions } from '@/lib/hooks/use-sessions'

function ChatContent() {
  const { sessions, activeId, setActiveId, create, remove, refresh } = useSessions()
  const [showCreateGroup, setShowCreateGroup] = useState(false)

  return (
    <div className="flex h-screen">
      <SessionSidebar
        sessions={sessions}
        activeId={activeId}
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
      <div className="flex-1 flex">
        <ChatArea sessionId={activeId} sessionType={sessions.find(s => s.id === activeId)?.type} />
        <AgentPanel
          sessionId={activeId}
          onPrivateChat={async (agentId, agentName) => {
            const session = await create(`私聊: ${agentName}`, 'private')
            await fetch(`/api/sessions/${session.id}/members`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ agentId }),
            })
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
