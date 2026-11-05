'use client'

import { useRouter } from 'next/navigation'
import { Archive, ArchiveRestore, ExternalLink, MoreHorizontal, Pencil, Trash2 } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

interface Props {
  session: { id: string; title: string; isArchived?: boolean }
  onRename: (id: string, title: string) => void
  onArchive: (id: string, archived: boolean) => void
  onDelete: (id: string) => void
  alwaysVisible?: boolean
}

export function SessionActionsMenu({ session, onRename, onArchive, onDelete, alwaysVisible = false }: Props) {
  const router = useRouter()
  const visibility = alwaysVisible
    ? 'opacity-100'
    : 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100'

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        onClick={event => event.stopPropagation()}
        className={`inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-opacity hover:bg-muted hover:text-foreground ${visibility}`}
        aria-label={`会话操作：${session.title}`}
      >
        <MoreHorizontal className="h-4 w-4" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" onClick={event => event.stopPropagation()}>
        <DropdownMenuItem onClick={() => onRename(session.id, session.title)}>
          <Pencil />
          重命名
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => router.push(`/projects/${session.id}`)}>
          <ExternalLink />
          详情
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => onArchive(session.id, !session.isArchived)}>
          {session.isArchived ? <ArchiveRestore /> : <Archive />}
          {session.isArchived ? '恢复' : '归档'}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onClick={() => onDelete(session.id)}>
          <Trash2 />
          删除
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
