import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/message-parser', () => ({
  parseMessage: vi.fn((raw: string) => {
    // Simple mock: treat raw as text, no code blocks or artifacts
    return { text: raw, codeBlocks: [], artifacts: [] }
  }),
}))

// Mock prisma - must use vi.hoisted to avoid hoisting issues
const { mockPrisma } = vi.hoisted(() => {
  const mockPrisma = {
    message: {
      findFirst: vi.fn(),
    },
  }
  return { mockPrisma }
})
vi.mock('@/lib/db', () => ({ prisma: mockPrisma }))

import { buildContextFromHistory, buildDiscussionSummary } from '@/lib/services/context-builder'
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

  it('strips DISCUSSION_SUMMARY prefix from context', () => {
    const history = [
      { role: 'orchestrator', agentId: null, rawContent: '[DISCUSSION_SUMMARY][STATUS:success]前端工程师（第1轮）：建议用 React', isPinned: false },
    ]
    const result = buildContextFromHistory(history)
    expect(result).not.toContain('[DISCUSSION_SUMMARY]')
    expect(result).toContain('前端工程师（第1轮）：建议用 React')
  })
})

describe('buildDiscussionSummary', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns empty string when no discussion message exists', async () => {
    mockPrisma.message.findFirst.mockResolvedValue(null)
    const result = await buildDiscussionSummary('session-1')
    expect(result).toBe('')
  })

  it('returns empty string when discussion failed', async () => {
    mockPrisma.message.findFirst.mockResolvedValue({
      rawContent: '[DISCUSSION_SUMMARY][STATUS:failed]前端工程师（第1轮）：[前端工程师 讨论超时，已跳过]',
    })
    const result = await buildDiscussionSummary('session-1')
    expect(result).toBe('')
  })

  it('extracts successful discussion summary', async () => {
    mockPrisma.message.findFirst.mockResolvedValue({
      rawContent: '[DISCUSSION_SUMMARY][STATUS:success]前端工程师（第1轮）：建议用 React + TypeScript\n\n后端工程师（第1轮）：确认纯前端任务',
    })
    const result = await buildDiscussionSummary('session-1')
    expect(result).toContain('前端工程师（第1轮）：建议用 React + TypeScript')
    expect(result).toContain('后端工程师（第1轮）：确认纯前端任务')
  })

  it('filters out timeout/error content', async () => {
    mockPrisma.message.findFirst.mockResolvedValue({
      rawContent: '[DISCUSSION_SUMMARY][STATUS:success]前端工程师（第1轮）：建议用 React\n\n后端工程师（第1轮）：[后端工程师 讨论超时，已跳过]',
    })
    const result = await buildDiscussionSummary('session-1')
    expect(result).toContain('前端工程师（第1轮）：建议用 React')
    expect(result).not.toContain('讨论超时')
  })

  it('returns empty string when all agents timed out', async () => {
    mockPrisma.message.findFirst.mockResolvedValue({
      rawContent: '[DISCUSSION_SUMMARY][STATUS:success]前端工程师（第1轮）：[前端工程师 讨论超时，已跳过]\n\n后端工程师（第1轮）：[后端工程师 讨论出错，已跳过]',
    })
    const result = await buildDiscussionSummary('session-1')
    expect(result).toBe('')
  })

  it('truncates at sentence boundary when content is too long', async () => {
    // 创建一个超过 500 字的讨论内容
    const longContent = '前端工程师（第1轮）：' + '技术方案内容。'.repeat(100)
    mockPrisma.message.findFirst.mockResolvedValue({
      rawContent: `[DISCUSSION_SUMMARY][STATUS:success]${longContent}`,
    })
    const result = await buildDiscussionSummary('session-1')
    expect(result.length).toBeLessThanOrEqual(500)
    // 应该在句子边界截断
    expect(result.endsWith('。') || result.endsWith('！') || result.endsWith('\n')).toBe(true)
  })

  it('returns empty string on DB error', async () => {
    mockPrisma.message.findFirst.mockRejectedValue(new Error('DB error'))
    const result = await buildDiscussionSummary('session-1')
    expect(result).toBe('')
  })
})
