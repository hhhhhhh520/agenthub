"use client"

import { useRef, useCallback } from "react"
import { Paperclip, X, Loader2 } from "lucide-react"
import { toast } from "sonner"

export interface AttachmentPreview {
  id: string
  filename: string
  mimeType: string
  size: number
  uploading: boolean
  previewUrl?: string
}

interface AttachmentInputProps {
  sessionId: string
  attachments: AttachmentPreview[]
  onAttachmentsChange: (attachments: AttachmentPreview[]) => void
}

export function AttachmentInput({ sessionId, attachments, onAttachmentsChange }: AttachmentInputProps) {
  const fileInputRef = useRef<HTMLInputElement>(null)

  const uploadFiles = useCallback(async (files: File[]) => {
    // Client-side validation
    const maxSize = 10 * 1024 * 1024
    for (const file of files) {
      if (file.size > maxSize) {
        alert(`文件 ${file.name} 超过 10MB 限制`)
        return
      }
    }

    // Add placeholders
    const placeholders: AttachmentPreview[] = files.map(file => ({
      id: crypto.randomUUID(),
      filename: file.name,
      mimeType: file.type,
      size: file.size,
      uploading: true,
      previewUrl: file.type.startsWith('image/') ? URL.createObjectURL(file) : undefined,
    }))
    onAttachmentsChange([...attachments, ...placeholders])

    // Upload
    const formData = new FormData()
    files.forEach(f => formData.append('files', f))

    try {
      const res = await fetch(`/api/sessions/${sessionId}/attachments`, {
        method: 'POST',
        body: formData,
      })
      if (!res.ok) {
        const err = await res.json()
        throw new Error(err.error || 'Upload failed')
      }
      const result: Array<{ id: string; filename: string; mimeType: string; size: number }> = await res.json()

      // Show toast for images
      const hasImages = result.some(r => r.mimeType.startsWith('image/'))
      if (hasImages) {
        toast.info('请确认当前模型支持图片输入')
      }

      // Update placeholders with real IDs
      const updated = attachments.map(a => {
        const match = placeholders.find(p => p.id === a.id)
        if (match) {
          const real = result.find(r => r.filename === a.filename)
          if (real) {
            return { ...a, id: real.id, uploading: false }
          }
        }
        return a
      })
      // Add newly uploaded items that weren't placeholders
      const newItems = result
        .filter(r => !updated.some(u => u.id === r.id))
        .map(r => ({
          id: r.id,
          filename: r.filename,
          mimeType: r.mimeType,
          size: r.size,
          uploading: false,
          previewUrl: r.mimeType.startsWith('image/') ? `/api/attachments/${r.id}` : undefined,
        }))
      onAttachmentsChange([...updated, ...newItems])
    } catch (err) {
      console.error('Upload failed:', err)
      toast.error('附件上传失败')
      // Remove failed placeholders
      onAttachmentsChange(attachments.filter(a => !placeholders.some(p => p.id === a.id)))
    }
  }, [sessionId, attachments, onAttachmentsChange])

  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || [])
    if (files.length > 0) uploadFiles(files)
    e.target.value = ''
  }, [uploadFiles])

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    const files = Array.from(e.dataTransfer.files)
    if (files.length > 0) uploadFiles(files)
  }, [uploadFiles])

  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    const items = Array.from(e.clipboardData.items)
    const imageFiles = items
      .filter(item => item.type.startsWith('image/'))
      .map(item => item.getAsFile())
      .filter((f): f is File => f !== null)
    if (imageFiles.length > 0) {
      e.preventDefault()
      uploadFiles(imageFiles)
    }
  }, [uploadFiles])

  const removeAttachment = useCallback((id: string) => {
    onAttachmentsChange(attachments.filter(a => a.id !== id))
  }, [attachments, onAttachmentsChange])

  return (
    <>
      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={handleFileSelect}
        accept="image/*,.pdf,.txt,.md,.json,.csv,.zip"
      />
      {attachments.length > 0 && (
        <div className="flex flex-wrap gap-2 p-2 border-b">
          {attachments.map(att => (
            <div key={att.id} className="relative group">
              {att.uploading ? (
                <div className="w-16 h-16 rounded border bg-muted flex items-center justify-center">
                  <Loader2 className="h-4 w-4 animate-spin" />
                </div>
              ) : att.previewUrl ? (
                <img
                  src={att.previewUrl}
                  alt={att.filename}
                  className="w-16 h-16 rounded border object-cover"
                />
              ) : (
                <div className="w-16 h-16 rounded border bg-muted flex items-center justify-center text-xs text-center p-1 truncate">
                  {att.filename}
                </div>
              )}
              <button
                onClick={() => removeAttachment(att.id)}
                className="absolute -top-1 -right-1 h-4 w-4 rounded-full bg-destructive text-destructive-foreground flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          ))}
        </div>
      )}
      <button
        type="button"
        onClick={() => fileInputRef.current?.click()}
        className="p-1.5 text-muted-foreground hover:text-foreground transition-colors"
        title="添加附件"
      >
        <Paperclip className="h-4 w-4" />
      </button>
    </>
  )
}
