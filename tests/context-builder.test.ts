import { describe, it, expect, vi } from 'vitest'

vi.mock('@/lib/message-parser', () => ({
  parseMessage: vi.fn((raw: string) => {
    // Simple mock: treat raw as text, no code blocks or artifacts
    return { text: raw, codeBlocks: [], artifacts: [] }
  }),
}))

import { buildContextFromHistory } from '@/lib/services/context-builder'
import { parseMessage } from '@/lib/message-parser'

describe('buildContextFromHistory', () => {
  it('returns empty string for empty history', () => {
    const result = buildContextFromHistory([])
    expect(result).toBe('')
  })

  it('formats normal messages with role label', () => {
    const history = [
      { role: 'user', rawContent: 'hello', isPinned: false },
      { role: 'assistant', agentId: 'PM', rawContent: 'hi there', isPinned: false },
    ]
    const result = buildContextFromHistory(history)
    expect(result).toContain('--- User ---')
    expect(result).toContain('hello')
    expect(result).toContain('--- PM ---')
    expect(result).toContain('hi there')
  })

  it('formats pinned messages under "重要上下文" section', () => {
    const history = [
      { role: 'user', rawContent: 'important note', isPinned: true },
      { role: 'assistant', agentId: 'PM', rawContent: 'normal reply', isPinned: false },
    ]
    const result = buildContextFromHistory(history)
    expect(result).toContain('=== 重要上下文（用户标记） ===')
    expect(result).toContain('important note')
    expect(result).toContain('=== 对话历史 ===')
    expect(result).toContain('normal reply')
  })

  it('pinned section comes before normal section', () => {
    const history = [
      { role: 'user', rawContent: 'normal', isPinned: false },
      { role: 'user', rawContent: 'pinned', isPinned: true },
    ]
    const result = buildContextFromHistory(history)
    const pinnedIdx = result.indexOf('=== 重要上下文')
    const normalIdx = result.indexOf('=== 对话历史 ===')
    expect(pinnedIdx).toBeLessThan(normalIdx)
  })

  it('no pinned section when no pinned messages', () => {
    const history = [
      { role: 'user', rawContent: 'hello', isPinned: false },
    ]
    const result = buildContextFromHistory(history)
    expect(result).not.toContain('=== 重要上下文')
    expect(result).toContain('--- User ---')
  })

  it('uses agentId as role label for assistant messages', () => {
    const history = [
      { role: 'assistant', agentId: '架构师', rawContent: 'design plan', isPinned: false },
    ]
    const result = buildContextFromHistory(history)
    expect(result).toContain('--- 架构师 ---')
  })

  it('uses "Agent" as fallback when agentId is null', () => {
    const history = [
      { role: 'assistant', agentId: null, rawContent: 'reply', isPinned: false },
    ]
    const result = buildContextFromHistory(history)
    expect(result).toContain('--- Agent ---')
  })

  it('appends code blocks from parsed message', () => {
    vi.mocked(parseMessage).mockReturnValueOnce({
      text: 'some text',
      codeBlocks: [{ language: 'typescript', code: 'const x = 1', lineStart: 0 }],
      artifacts: [],
    })
    const history = [
      { role: 'user', rawContent: 'code here', isPinned: false },
    ]
    const result = buildContextFromHistory(history)
    expect(result).toContain('[代码块]')
    expect(result).toContain('const x = 1')
  })

  it('appends artifacts from parsed message', () => {
    vi.mocked(parseMessage).mockReturnValueOnce({
      text: 'some text',
      codeBlocks: [],
      artifacts: [{ type: 'file', content: '...', meta: { filePath: 'src/app.ts' } }],
    })
    const history = [
      { role: 'user', rawContent: 'file artifact', isPinned: false },
    ]
    const result = buildContextFromHistory(history)
    expect(result).toContain('[工件: src/app.ts]')
  })
})
