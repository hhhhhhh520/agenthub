export interface AttachmentUploadState {
  id: string
  filename: string
  mimeType: string
  size: number
  uploading: boolean
  previewUrl?: string
}

export interface UploadedAttachment {
  id: string
  filename: string
  mimeType: string
  size: number
}

export function appendPlaceholders<T extends AttachmentUploadState>(prev: T[], placeholders: T[]): T[] {
  return [...prev, ...placeholders]
}

export function mergeUploaded<T extends AttachmentUploadState>(
  prev: T[],
  placeholders: T[],
  results: UploadedAttachment[],
): T[] {
  if (results.length !== placeholders.length) {
    throw new Error(`上传结果数量不一致：期望 ${placeholders.length}，实际 ${results.length}`)
  }

  const indexById = new Map(placeholders.map((placeholder, index) => [placeholder.id, index]))
  return prev.map(item => {
    const index = indexById.get(item.id)
    if (index === undefined) return item
    const result = results[index]
    return {
      ...item,
      id: result.id,
      filename: result.filename,
      mimeType: result.mimeType,
      size: result.size,
      uploading: false,
      previewUrl: result.mimeType.startsWith('image/') ? `/api/attachments/${result.id}` : undefined,
    }
  })
}

export function removePlaceholders<T extends AttachmentUploadState>(prev: T[], placeholders: T[]): T[] {
  const ids = new Set(placeholders.map(placeholder => placeholder.id))
  return prev.filter(item => !ids.has(item.id))
}
