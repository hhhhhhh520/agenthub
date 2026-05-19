'use client'
export function ChatArea({ sessionId }: { sessionId: string | null }) {
  if (!sessionId) {
    return <div className="flex-1 flex items-center justify-center text-gray-400">选择或创建一个会话</div>
  }
  return <div className="flex-1 flex flex-col">Chat Area (TODO)</div>
}
