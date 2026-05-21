'use client'
import { MoreHorizontal } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

interface MessageActionMenuProps {
  role: string
  onReply: () => void
  onCopy: () => void
  onQuote: () => void
  onRegenerate?: () => void
}

export function MessageActionMenu({ role, onReply, onCopy, onQuote, onRegenerate }: MessageActionMenuProps) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="opacity-0 group-hover:opacity-100 transition-opacity p-1 rounded hover:bg-gray-200">
        <MoreHorizontal className="w-4 h-4 text-gray-500" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={onReply}>回复</DropdownMenuItem>
        <DropdownMenuItem onClick={onCopy}>复制</DropdownMenuItem>
        <DropdownMenuItem onClick={onQuote}>引用</DropdownMenuItem>
        {(role === 'agent' || role === 'orchestrator') && onRegenerate && (
          <DropdownMenuItem onClick={onRegenerate}>重新生成</DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
