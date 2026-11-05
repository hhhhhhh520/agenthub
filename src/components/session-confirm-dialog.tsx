'use client'

import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description: string
  confirmLabel?: string
  destructive?: boolean
  onConfirm: () => void | Promise<void>
}

export function SessionConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = '确认',
  destructive = false,
  onConfirm,
}: Props) {
  const [working, setWorking] = useState(false)

  useEffect(() => {
    if (open) setWorking(false)
  }, [open])

  const handleOpenChange = (nextOpen: boolean) => {
    if (working) return
    onOpenChange(nextOpen)
  }

  const handleConfirm = async () => {
    if (working) return
    setWorking(true)
    try {
      await onConfirm()
      onOpenChange(false)
    } finally {
      setWorking(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => handleOpenChange(false)} disabled={working}>
            取消
          </Button>
          <Button
            type="button"
            variant={destructive ? 'destructive' : 'default'}
            onClick={handleConfirm}
            disabled={working}
          >
            {working ? '处理中…' : confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
