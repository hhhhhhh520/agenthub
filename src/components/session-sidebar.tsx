'use client'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'

interface Session {
  id: string
  title: string
  type?: string
  updatedAt: string
  members?: Array<{ agentId: string; agent?: { name: string; accentColor: string } }>
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
              className={`p-2 rounded cursor-pointer text-sm flex justify-between items-center group select-none ${
                activeId === session.id ? 'bg-blue-100 text-blue-900' : 'hover:bg-gray-100'
              }`}
              onClick={() => onSelect(session.id)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onSelect(session.id) }}
            >
              {session.type === 'group' && session.members && session.members.length > 0 && (
                <div className="flex -space-x-1.5 mr-2 shrink-0">
                  {session.members.slice(0, 3).map(m => {
                    const name = m.agent?.name || m.agentId
                    const color = m.agent?.accentColor || '#6366f1'
                    return (
                      <div
                        key={m.agentId}
                        className="w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-medium border border-white"
                        style={{ backgroundColor: color, color: '#fff' }}
                        title={name}
                      >
                        {name.charAt(0)}
                      </div>
                    )
                  })}
                  {session.members.length > 3 && (
                    <div className="w-5 h-5 rounded-full flex items-center justify-center text-[10px] bg-gray-200 text-gray-600 border border-white">
                      +{session.members.length - 3}
                    </div>
                  )}
                </div>
              )}
              <span className="truncate flex-1 min-w-0">{session.title}</span>
              <button
                onClick={(e) => { e.stopPropagation(); handleDelete(session.id, session.title) }}
                className="opacity-0 group-hover:opacity-100 text-gray-400 hover:text-red-500 text-xs shrink-0 ml-1"
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
