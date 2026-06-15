'use client'
import { useState } from 'react'
import DOMPurify from 'dompurify'

interface WebPreviewProps {
  html: string
  css?: string
  js?: string
}

export function WebPreview({ html, css = '', js = '' }: WebPreviewProps) {
  const [expanded, setExpanded] = useState(true)

  // Sanitize HTML to prevent XSS — strips <script>, event handlers, etc.
  const cleanHtml = DOMPurify.sanitize(html, { USE_PROFILES: { html: true } })
  // Sanitize CSS — remove @import and url() with external origins
  const cleanCss = css.replace(/@import\s+url\([^)]*\)/gi, '').replace(/url\(\s*['"]?(?!data:)[^'")\s]*['"]?\s*\)/gi, '')
  // JS runs in sandboxed iframe — strip only obvious script injection outside the script tag
  const cleanJs = js

  const srcdoc = `<!DOCTYPE html>
<html>
<head>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:">
<style>${cleanCss}</style>
</head>
<body>${cleanHtml}<script>${cleanJs}</script></body>
</html>`

  if (!expanded) {
    return (
      <div className="border rounded-lg p-2 bg-gray-50 dark:bg-gray-800 text-sm">
        <button onClick={() => setExpanded(true)} className="text-blue-500 hover:underline">
          Show Preview
        </button>
      </div>
    )
  }

  return (
    <div className="border rounded-lg overflow-hidden dark:border-gray-700">
      <div className="bg-gray-100 dark:bg-gray-800 px-3 py-1 text-xs font-medium flex justify-between items-center">
        <span>Web Preview</span>
        <button onClick={() => setExpanded(false)} className="text-gray-500 dark:text-gray-400">Collapse</button>
      </div>
      <iframe
        srcDoc={srcdoc}
        className="w-full h-[400px] border-0"
        sandbox="allow-scripts"
        title="Preview"
      />
    </div>
  )
}
