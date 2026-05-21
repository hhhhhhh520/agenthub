'use client'

interface FileCardProps {
  fileName: string
  fileSize?: number
  downloadUrl?: string
}

function formatSize(bytes?: number): string {
  if (!bytes) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function FileCard({ fileName, fileSize, downloadUrl }: FileCardProps) {
  return (
    <div className="border rounded-lg p-3 bg-gray-50 flex items-center gap-3">
      <div className="text-2xl">📄</div>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium truncate">{fileName}</div>
        {fileSize !== undefined && (
          <div className="text-xs text-gray-500">{formatSize(fileSize)}</div>
        )}
      </div>
      {downloadUrl && (
        <a
          href={downloadUrl}
          download
          className="text-sm text-blue-500 hover:underline shrink-0"
        >
          下载
        </a>
      )}
    </div>
  )
}
