'use client'
import { useState } from 'react'
import dynamic from 'next/dynamic'

const MonacoDiff = dynamic(() => import('@monaco-editor/react').then(mod => {
  const { DiffEditor } = mod
  return (props: any) => <DiffEditor {...props} />
}), { ssr: false })

interface CodeDiffProps {
  original: string
  modified: string
  language?: string
  onAccept?: () => void
  onReject?: () => void
}

export function CodeDiff({ original, modified, language = 'javascript', onAccept, onReject }: CodeDiffProps) {
  const [expanded, setExpanded] = useState(true)

  if (!expanded) {
    return (
      <div className="border rounded-lg p-2 bg-gray-50 text-sm">
        <button onClick={() => setExpanded(true)} className="text-blue-500 hover:underline">
          Show Code Diff
        </button>
      </div>
    )
  }

  return (
    <div className="border rounded-lg overflow-hidden">
      <div className="bg-gray-100 px-3 py-1 text-xs font-medium flex justify-between items-center">
        <span>Code Changes</span>
        <div className="flex gap-2">
          {onAccept && <button onClick={onAccept} className="text-green-600 hover:underline">Accept</button>}
          {onReject && <button onClick={onReject} className="text-red-600 hover:underline">Reject</button>}
          <button onClick={() => setExpanded(false)} className="text-gray-500">Collapse</button>
        </div>
      </div>
      <MonacoDiff
        height="300px"
        language={language}
        original={original}
        modified={modified}
        options={{
          readOnly: false,
          renderSideBySide: true,
          minimap: { enabled: false },
        }}
      />
    </div>
  )
}
