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
  onCreate: () => void
  onDelete: (id: string) => void
}

export function SessionSidebar({ sessions, activeId, onSelect, onCreate, onDelete }: Props) {
  return (
    <div className="w-64 border-r bg-gray-50 flex flex-col">
      <div className="p-3 border-b">
        <Button onClick={onCreate} className="w-full" size="sm">
          + 新会话
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
                onClick={(e) => { e.stopPropagation(); onDelete(session.id) }}
                className="opacity-0 group-hover:opacity-100 text-gray-400 hover:text-red-500 text-xs"
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
