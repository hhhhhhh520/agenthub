import { describe, it, expect } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { OpencodeReadOnlyHint } from '@/components/opencode-readonly-hint'

describe('OpencodeReadOnlyHint', () => {
  it('shows the read-only hint for OpenCode agents', () => {
    const html = renderToStaticMarkup(createElement(OpencodeReadOnlyHint, { platform: 'opencode' }))
    expect(html).toContain('OpenCode 默认模式为只读')
    expect(html).toContain('/permission auto')
  })

  it('does not render for Claude agents or no selection', () => {
    expect(renderToStaticMarkup(createElement(OpencodeReadOnlyHint, { platform: 'claude-code' }))).toBe('')
    expect(renderToStaticMarkup(createElement(OpencodeReadOnlyHint))).toBe('')
  })
})
