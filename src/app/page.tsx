'use client'
import { SessionSidebar } from '@/components/session-sidebar'
import { ChatArea } from '@/components/chat-area'
import { AgentPanel } from '@/components/agent-panel'
import { useSessions } from '@/lib/hooks/use-sessions'

export default function Home() {
  const { sessions, activeId, setActiveId, create, remove } = useSessions()

  return (
    <div className="flex h-screen">
      <SessionSidebar
        sessions={sessions}
        activeId={activeId}
        onSelect={setActiveId}
        onCreate={() => create()}
        onDelete={remove}
      />
      <div className="flex-1 flex">
        <ChatArea sessionId={activeId} />
        <AgentPanel sessionId={activeId} />
      </div>
    </div>
  )
}
