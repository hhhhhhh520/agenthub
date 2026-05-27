import { describe, it, expect, vi } from 'vitest'

// Mock prisma only
vi.mock('@/lib/prisma', () => ({
  prisma: {
    session: { update: vi.fn(), findUnique: vi.fn() },
    message: { create: vi.fn(), findMany: vi.fn() },
    task: { create: vi.fn() },
    agent: { create: vi.fn(), findUnique: vi.fn() },
    sessionMember: { create: vi.fn(), findMany: vi.fn() },
  },
}))

vi.mock('@/lib/orchestrator/prompts', () => ({
  buildMonitoringPrompt: vi.fn(),
  PM_CONFIRMATION_PROMPT: 'PM确认：{userMessage}',
  buildAgentQuestionPrompt: vi.fn(),
}))

vi.mock('@/lib/orchestrator/scheduler', () => ({
  enforceFileOverlap: vi.fn(),
}))

// ─── validateDecision logic (mirrored from route.ts) ───
function validateDecision(
  decision: { action: string; message: string; reason: string },
  currentPhase: string,
  history: Array<{ role: string; agentId?: string | null; rawContent: string }>
) {
  if (currentPhase === 'alignment' && decision.action === 'done') {
    return { ...decision, action: 'align_confirm', reason: '对齐尚未完成，继续确认需求' }
  }
  if (currentPhase === 'execution' && decision.action.startsWith('align_')) {
    return { ...decision, action: 'execute', reason: '已在执行阶段' }
  }
  if (decision.action === 'align_qa') {
    const agentQuestions = history.filter(
      m => m.role === 'agent' && m.agentId && m.agentId !== '产品经理' && m.agentId !== '架构师'
    )
    if (agentQuestions.length > 0) {
      const lastAgentQuestionIdx = history.reduce((last, m, i) =>
        (m.role === 'agent' && m.agentId && m.agentId !== '产品经理' && m.agentId !== '架构师') ? i : last, -1
      )
      const userAnswersAfter = history.slice(lastAgentQuestionIdx + 1).filter(m => m.role === 'user')
      if (userAnswersAfter.length > 0) {
        return { ...decision, action: 'execute', reason: 'Q&A已完成，开始执行' }
      }
    }
  }
  return decision
}

describe('validateDecision', () => {
  it('should block done during alignment phase', () => {
    const result = validateDecision({ action: 'done', message: '', reason: '完成' }, 'alignment', [])
    expect(result.action).toBe('align_confirm')
  })

  it('should block align_* during execution phase', () => {
    const result = validateDecision({ action: 'align_confirm', message: '', reason: '重新对齐' }, 'execution', [])
    expect(result.action).toBe('execute')
  })

  it('should block align_decompose during execution phase', () => {
    const result = validateDecision({ action: 'align_decompose', message: '', reason: '拆解' }, 'execution', [])
    expect(result.action).toBe('execute')
  })

  it('should allow self during alignment', () => {
    const result = validateDecision({ action: 'self', message: '好的', reason: '闲聊' }, 'alignment', [])
    expect(result.action).toBe('self')
  })

  it('should allow align_confirm during alignment', () => {
    const result = validateDecision({ action: 'align_confirm', message: '', reason: '确认需求' }, 'alignment', [])
    expect(result.action).toBe('align_confirm')
  })

  it('should force execute when align_qa after agent Q&A with user answer', () => {
    const history = [
      { role: 'user', agentId: null, rawContent: '搭建博客' },
      { role: 'agent', agentId: '产品经理', rawContent: '确认需求...' },
      { role: 'agent', agentId: '前端工程师', rawContent: '用 React 还是 Vue？' },
      { role: 'user', agentId: null, rawContent: '用 React' },
    ]
    const result = validateDecision({ action: 'align_qa', message: '', reason: '再问一轮' }, 'alignment', history)
    expect(result.action).toBe('execute')
  })

  it('should allow align_qa when no previous agent questions', () => {
    const history = [
      { role: 'user', agentId: null, rawContent: '搭建博客' },
      { role: 'agent', agentId: '架构师', rawContent: '方案...' },
    ]
    const result = validateDecision({ action: 'align_qa', message: '', reason: '让Agent提问' }, 'alignment', history)
    expect(result.action).toBe('align_qa')
  })

  it('should allow align_qa when agent asked but user has not answered', () => {
    const history = [
      { role: 'user', agentId: null, rawContent: '搭建博客' },
      { role: 'agent', agentId: '前端工程师', rawContent: '用 React 还是 Vue？' },
    ]
    const result = validateDecision({ action: 'align_qa', message: '', reason: '等用户回答' }, 'alignment', history)
    expect(result.action).toBe('align_qa')
  })

  it('should not interfere during idle phase', () => {
    const result = validateDecision({ action: 'align_confirm', message: '', reason: '开发任务' }, 'idle', [])
    expect(result.action).toBe('align_confirm')
  })

  it('should preserve delegate action during alignment', () => {
    const result = validateDecision({ action: 'delegate', message: '', reason: '委派' }, 'alignment', [])
    expect(result.action).toBe('delegate')
  })

  it('should allow done during execution phase', () => {
    const result = validateDecision({ action: 'done', message: '', reason: '完成' }, 'execution', [])
    expect(result.action).toBe('done')
  })

  it('should use reduce instead of findLastIndex for compatibility', () => {
    const history = [
      { role: 'user', agentId: null, rawContent: '搭建博客' },
      { role: 'agent', agentId: '前端工程师', rawContent: '用 React？' },
      { role: 'user', agentId: null, rawContent: '用 React' },
      { role: 'agent', agentId: '后端工程师', rawContent: '用 Node？' },
    ]
    const lastIdx = history.reduce((last, m, i) =>
      (m.role === 'agent' && m.agentId && m.agentId !== '产品经理' && m.agentId !== '架构师') ? i : last, -1
    )
    expect(lastIdx).toBe(3)
  })

  it('should return -1 when no agent questions exist in reduce', () => {
    const history = [
      { role: 'user', agentId: null, rawContent: '搭建博客' },
      { role: 'agent', agentId: '产品经理', rawContent: '确认...' },
    ]
    const lastIdx = history.reduce((last, m, i) =>
      (m.role === 'agent' && m.agentId && m.agentId !== '产品经理' && m.agentId !== '架构师') ? i : last, -1
    )
    expect(lastIdx).toBe(-1)
  })
})
