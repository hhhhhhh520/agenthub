import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

interface Props {
  title: string
  description?: string
  action?: ReactNode
  compact?: boolean
  className?: string
}

/** 统一空状态：一句现状 + 一句下一步，避免只显示「暂无」。 */
export function EmptyState({ title, description, action, compact = false, className }: Props) {
  return (
    <div className={cn('flex flex-col items-center justify-center text-center', compact ? 'px-3 py-6' : 'px-6 py-12', className)}>
      <p className={cn('font-medium text-foreground', compact ? 'text-xs' : 'text-sm')}>{title}</p>
      {description && (
        <p className={cn('mt-1 text-xs text-muted-foreground', compact ? 'max-w-none' : 'max-w-sm leading-relaxed')}>
          {description}
        </p>
      )}
      {action && <div className="mt-3">{action}</div>}
    </div>
  )
}
