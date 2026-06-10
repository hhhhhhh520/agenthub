'use client'
import { useMemo } from 'react'
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

function getTimeGroup(updatedAt: string): string {
  const now = new Date()
  const date = new Date(updatedAt)
  const diffMs = now.getTime() - date.getTime()
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24))

  if (diffDays === 0) return '今天'
  if (diffDays === 1) return '昨天'
  if (diffDays < 7) return '本周'
  return '更早'
}

export function SessionSidebar({ sessions, activeId, onSelect, onCreateGroup, onQuickStart, onDelete }: Props) {
  const handleDelete = (id: string, title: string) => {
    if (window.confirm(`确定删除会话「${title}」吗？`)) {
      onDelete(id)
    }
  }

  const groupedSessions = useMemo(() => {
    const groups: { label: string; sessions: Session[] }[] = []
    const groupMap = new Map<string, Session[]>()

    for (const session of sessions) {
      const group = getTimeGroup(session.updatedAt)
      if (!groupMap.has(group)) {
        groupMap.set(group, [])
      }
      groupMap.get(group)!.push(session)
    }

    // Maintain order: 今天, 昨天, 本周, 更早
    const order = ['今天', '昨天', '本周', '更早']
    for (const label of order) {
      const items = groupMap.get(label)
      if (items && items.length > 0) {
        groups.push({ label, sessions: items })
      }
    }

    return groups
  }, [sessions])

  return (
    <div className="w-64 border-r bg-gray-50 flex flex-col min-h-0 overflow-hidden">
      <div className="p-3 border-b space-y-2">
        <Button onClick={onQuickStart} variant="outline" className="w-full" size="sm" aria-label="开始对话">
          开始对话
        </Button>
        <Button onClick={onCreateGroup} className="w-full" size="sm" aria-label="创建群聊">
          创建群聊
        </Button>
      </div>
      <ScrollArea className="flex-1 min-h-0 overflow-hidden">
        <div className="p-2 space-y-3">
          {groupedSessions.map(group => (
            <div key={group.label}>
              <div className="text-xs text-gray-400 font-medium px-2 mb-1">{group.label}</div>
              <div className="space-y-1">
                {group.sessions.map(session => (
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
            </div>
          ))}
        </div>
      </ScrollArea>
    </div>
  )
}
