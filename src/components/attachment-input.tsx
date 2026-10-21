"use client"

import { useRef, useCallback, type Dispatch, type SetStateAction } from "react"
import { Paperclip, X, Loader2 } from "lucide-react"
import { toast } from "sonner"
import {
  appendPlaceholders,
  mergeUploaded,
  removePlaceholders,
  type AttachmentUploadState,
  type UploadedAttachment,
} from '@/lib/attachment-upload'

export type AttachmentPreview = AttachmentUploadState

interface AttachmentInputProps {
  sessionId: string
  attachments: AttachmentPreview[]
  onAttachmentsChange: Dispatch<SetStateAction<AttachmentPreview[]>>
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
    onAttachmentsChange(prev => appendPlaceholders(prev, placeholders))

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
      const result: UploadedAttachment[] = await res.json()
      if (result.length !== placeholders.length) {
        throw new Error(`上传结果数量不一致：期望 ${placeholders.length}，实际 ${result.length}`)
      }

      // Show toast for images
      const hasImages = result.some(r => r.mimeType.startsWith('image/'))
      if (hasImages) {
        toast.info('请确认当前模型支持图片输入')
      }

      // 函数式合并：两个并发上传各自只更新自己的占位，不覆盖对方的批次。
      onAttachmentsChange(prev => mergeUploaded(prev, placeholders, result))
    } catch (err) {
      console.error('Upload failed:', err)
      toast.error('附件上传失败')
      onAttachmentsChange(prev => removePlaceholders(prev, placeholders))
    }
  }, [sessionId, onAttachmentsChange])

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
