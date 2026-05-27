'use client'
import { useState, useEffect } from 'react'
import { SessionSidebar } from '@/components/session-sidebar'
import { ChatArea } from '@/components/chat-area'
import { AgentPanel } from '@/components/agent-panel'
import { CreateGroupDialog } from '@/components/create-group-dialog'
import { SetupWizard } from '@/components/setup-wizard'
import { useSessions } from '@/lib/hooks/use-sessions'

export default function Home() {
  const { sessions, activeId, setActiveId, create, remove, refresh } = useSessions()
  const [showCreateGroup, setShowCreateGroup] = useState(false)
  const [showSetup, setShowSetup] = useState(false)
  const [setupChecked, setSetupChecked] = useState(false)

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

  return (
    <div className="flex h-screen">
      <SessionSidebar
        sessions={sessions}
        activeId={activeId}
        onSelect={setActiveId}
        onCreateGroup={() => setShowCreateGroup(true)}
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
      <SetupWizard open={showSetup} onOpenChange={setShowSetup} onComplete={() => { refresh(); setShowSetup(false) }} />
      <div className="flex-1 flex">
        <ChatArea sessionId={activeId} />
        <AgentPanel
          sessionId={activeId}
          onPrivateChat={async (agentId, agentName) => {
            const session = await create(`私聊: ${agentName}`, 'private')
            // Add the agent to the session
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
