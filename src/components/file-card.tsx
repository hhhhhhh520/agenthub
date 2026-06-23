'use client'

import { isValidDownloadUrl } from '@/lib/url-safety'

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
  // #43: agent 输出的 artifact downloadUrl 可被注入(javascript:fetch(...) 等),
  // 必须经过 scheme 白名单校验后才渲染为 <a href>,否则只展示禁用文本。
  const safeUrl = isValidDownloadUrl(downloadUrl) ? downloadUrl : undefined
  return (
    <div className="border rounded-lg p-3 bg-gray-50 flex items-center gap-3">
      <div className="text-2xl">📄</div>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium truncate">{fileName}</div>
        {fileSize !== undefined && (
          <div className="text-xs text-gray-500">{formatSize(fileSize)}</div>
        )}
      </div>
      {safeUrl && (
        <a
          href={safeUrl}
          download
          className="text-sm text-blue-500 hover:underline shrink-0"
        >
          下载
        </a>
      )}
    </div>
  )
}
