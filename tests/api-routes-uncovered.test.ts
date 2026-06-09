import { describe, it, expect } from 'vitest'

// ── Attachment cleanup logic tests ──────────────────────────────────────────
describe('attachment-cleanup — orphan detection logic', () => {
  const ONE_HOUR_MS = 60 * 60 * 1000

  function findOrphans(attachments: Array<{ id: string; messageId: string | null; createdAt: Date }>) {
    return attachments.filter(a =>
      !a.messageId && a.createdAt.getTime() < Date.now() - ONE_HOUR_MS
    )
  }

  it('identifies attachments older than 1 hour without messageId', () => {
    const oneHourAgo = new Date(Date.now() - 61 * 60 * 1000)
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000)

    const attachments = [
      { id: 'a1', messageId: null, createdAt: oneHourAgo },
      { id: 'a2', messageId: 'msg-1', createdAt: oneHourAgo },
      { id: 'a3', messageId: null, createdAt: fiveMinutesAgo },
    ]

    const orphans = findOrphans(attachments)
    expect(orphans).toHaveLength(1)
    expect(orphans[0].id).toBe('a1')
  })

  it('does not flag attachments with messageId as orphans', () => {
    const old = new Date(Date.now() - 2 * ONE_HOUR_MS)
    const attachments = [
      { id: 'a1', messageId: 'msg-1', createdAt: old },
    ]
    expect(findOrphans(attachments)).toHaveLength(0)
  })

  it('does not flag recent attachments without messageId', () => {
    const recent = new Date(Date.now() - 10 * 1000) // 10 seconds ago
    const attachments = [
      { id: 'a1', messageId: null, createdAt: recent },
    ]
    expect(findOrphans(attachments)).toHaveLength(0)
  })

  it('handles empty list', () => {
    expect(findOrphans([])).toHaveLength(0)
  })

  it('finds multiple orphans', () => {
    const old = new Date(Date.now() - 2 * ONE_HOUR_MS)
    const attachments = [
      { id: 'a1', messageId: null, createdAt: old },
      { id: 'a2', messageId: null, createdAt: old },
      { id: 'a3', messageId: 'msg-1', createdAt: old },
    ]
    expect(findOrphans(attachments)).toHaveLength(2)
  })
})

// ── validateDecision edge cases ──────────────────────────────────────────
describe('validateDecision — comprehensive edge cases', () => {
  async function loadValidateDecision() {
    const mod = await import('@/lib/services/chat-router')
    return mod.validateDecision
  }

  it('passes through self action in any phase', async () => {
    const validate = await loadValidateDecision()
    const result = validate({ action: 'self', message: 'hi', reason: 'chat' }, 'alignment', [])
    expect(result.action).toBe('self')
  })

  it('passes through delegate action in any phase', async () => {
    const validate = await loadValidateDecision()
    const result = validate({ action: 'delegate', target: 'PM', message: 'do it', reason: 'delegating' }, 'alignment', [])
    expect(result.action).toBe('delegate')
  })

  it('passes through discuss action in any phase', async () => {
    const validate = await loadValidateDecision()
    const result = validate({ action: 'discuss', targets: ['PM', 'Arch'], message: 'discuss', reason: 'need opinions' }, 'execution', [])
    expect(result.action).toBe('discuss')
  })

  it('overrides done to align_confirm during alignment', async () => {
    const validate = await loadValidateDecision()
    const result = validate({ action: 'done', message: '', reason: 'all done' }, 'alignment', [])
    expect(result.action).toBe('align_confirm')
    expect(result.reason).toContain('对齐尚未完成')
  })

  it('overrides align_* to execute during execution phase', async () => {
    const validate = await loadValidateDecision()
    for (const action of ['align_confirm', 'align_decompose', 'align_qa']) {
      const result = validate({ action, message: '', reason: '' }, 'execution', [])
      expect(result.action).toBe('execute')
    }
  })

  it('forces execute when Q&A already answered (multi-turn Q&A)', async () => {
    const validate = await loadValidateDecision()
    const history = [
      { role: 'agent', agentId: '前端工程师', rawContent: 'UI 用什么框架？' },
      { role: 'user', rawContent: '用 React' },
    ]
    const result = validate({ action: 'align_qa', message: '', reason: '' }, 'alignment', history)
    expect(result.action).toBe('execute')
    expect(result.reason).toContain('Q&A已完成')
  })

  it('keeps align_qa when questions not yet answered', async () => {
    const validate = await loadValidateDecision()
    const history = [
      { role: 'agent', agentId: '前端工程师', rawContent: 'UI 用什么框架？' },
    ]
    const result = validate({ action: 'align_qa', message: '', reason: '' }, 'alignment', history)
    expect(result.action).toBe('align_qa')
  })

  it('ignores questions from PM and 架构师 when checking Q&A completion', async () => {
    const validate = await loadValidateDecision()
    const history = [
      { role: 'agent', agentId: '产品经理', rawContent: '需求确认' },
      { role: 'agent', agentId: '架构师', rawContent: '技术方案' },
      { role: 'agent', agentId: '前端工程师', rawContent: 'UI 框架？' },
    ]
    const result = validate({ action: 'align_qa', message: '', reason: '' }, 'alignment', history)
    expect(result.action).toBe('align_qa')
  })

  it('passes through execute action without modification', async () => {
    const validate = await loadValidateDecision()
    const result = validate({ action: 'execute', message: '', reason: 'go' }, 'alignment', [])
    expect(result.action).toBe('execute')
  })

  it('preserves target and targets fields through validation', async () => {
    const validate = await loadValidateDecision()
    const result = validate({
      action: 'delegate', target: '前端工程师', targets: null, message: 'msg', reason: 'r',
    }, 'alignment', [])
    expect(result.target).toBe('前端工程师')
  })
})
