'use client'
import { useState } from 'react'

interface WebPreviewProps {
  html: string
  css?: string
  js?: string
}

export function WebPreview({ html, css = '', js = '' }: WebPreviewProps) {
  const [expanded, setExpanded] = useState(true)
  const srcdoc = `<!DOCTYPE html>
<html>
<head><style>${css}</style></head>
<body>${html}<script>${js}</script></body>
</html>`

  if (!expanded) {
    return (
      <div className="border rounded-lg p-2 bg-gray-50 text-sm">
        <button onClick={() => setExpanded(true)} className="text-blue-500 hover:underline">
          Show Preview
        </button>
      </div>
    )
  }

  return (
    <div className="border rounded-lg overflow-hidden">
      <div className="bg-gray-100 px-3 py-1 text-xs font-medium flex justify-between items-center">
        <span>Web Preview</span>
        <button onClick={() => setExpanded(false)} className="text-gray-500">Collapse</button>
      </div>
      <iframe
        srcDoc={srcdoc}
        className="w-full h-[400px] border-0"
        sandbox="allow-scripts allow-same-origin"
        title="Preview"
      />
    </div>
  )
}
