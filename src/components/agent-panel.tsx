'use client'
export function AgentPanel({ sessionId }: { sessionId: string | null }) {
  if (!sessionId) return null
  return <div className="w-72 border-l bg-gray-50">Agent Panel (TODO)</div>
}
