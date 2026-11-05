'use client'

import { useEffect, useState, type FormEvent } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'

const MAX_TITLE_LENGTH = 120

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  initialTitle: string
  onRename: (title: string) => Promise<boolean>
}

export function SessionRenameDialog({ open, onOpenChange, initialTitle, onRename }: Props) {
  const [title, setTitle] = useState(initialTitle)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!open) return
    setTitle(initialTitle)
    setSaving(false)
    setError('')
  }, [open, initialTitle])

  const handleOpenChange = (nextOpen: boolean) => {
    if (saving) return
    onOpenChange(nextOpen)
  }

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault()
    if (saving) return
    const nextTitle = title.trim()
    if (!nextTitle) {
      setError('标题不能为空')
      return
    }
    if (Array.from(nextTitle).length > MAX_TITLE_LENGTH) {
      setError(`标题最多 ${MAX_TITLE_LENGTH} 个字符`)
      return
    }

    setSaving(true)
    setError('')
    try {
      const saved = await onRename(nextTitle)
      if (saved) onOpenChange(false)
      else setError('重命名失败，请重试')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>重命名会话</DialogTitle>
          <DialogDescription>标题只影响列表展示，不会修改聊天记录。</DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit}>
          <Input
            autoFocus
            value={title}
            maxLength={MAX_TITLE_LENGTH}
            onChange={e => setTitle(e.target.value)}
            aria-label="会话标题"
            aria-invalid={!!error}
          />
          <div className="mt-1 flex items-center justify-between text-xs text-muted-foreground">
            <span className={error ? 'text-destructive' : ''}>{error || 'Enter 保存，Esc 取消'}</span>
            <span>{Array.from(title.trim()).length}/{MAX_TITLE_LENGTH}</span>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => handleOpenChange(false)} disabled={saving}>
              取消
            </Button>
            <Button type="submit" disabled={saving || !title.trim()}>
              {saving ? '保存中…' : '保存'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
