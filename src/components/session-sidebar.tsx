'use client'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'

interface Session {
  id: string
  title: string
  updatedAt: string
}

interface Props {
  sessions: Session[]
  activeId: string | null
  onSelect: (id: string) => void
  onCreateGroup: () => void
  onQuickStart: () => void
  onDelete: (id: string) => void
}

export function SessionSidebar({ sessions, activeId, onSelect, onCreateGroup, onQuickStart, onDelete }: Props) {
  const handleDelete = (id: string, title: string) => {
    if (window.confirm(`确定删除会话「${title}」吗？`)) {
      onDelete(id)
    }
  }

  return (
    <div className="w-64 border-r bg-gray-50 flex flex-col">
      <div className="p-3 border-b space-y-2">
        <Button onClick={onQuickStart} variant="outline" className="w-full" size="sm" aria-label="开始对话">
          开始对话
        </Button>
        <Button onClick={onCreateGroup} className="w-full" size="sm" aria-label="创建群聊">
          创建群聊
        </Button>
      </div>
      <ScrollArea className="flex-1">
        <div className="p-2 space-y-1">
          {sessions.map(session => (
            <div
              key={session.id}
              className={`p-2 rounded cursor-pointer text-sm flex justify-between items-center group ${
                activeId === session.id ? 'bg-blue-100 text-blue-900' : 'hover:bg-gray-100'
              }`}
              onClick={() => onSelect(session.id)}
            >
              <span className="truncate">{session.title}</span>
              <button
                onClick={(e) => { e.stopPropagation(); handleDelete(session.id, session.title) }}
                className="opacity-0 group-hover:opacity-100 text-gray-400 hover:text-red-500 text-xs"
                aria-label={`删除会话 ${session.title}`}
              >
                x
              </button>
            </div>
          ))}
        </div>
      </ScrollArea>
    </div>
  )
}
