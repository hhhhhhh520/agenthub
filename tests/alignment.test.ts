import { describe, it, expect } from 'vitest'

// Reference copy of validateDecision from src/app/api/sessions/[id]/chat/route.ts:802
// Source function is not exported (private to the route handler), so we maintain
// an identical copy here. If the source changes, this copy must be updated.

function validateDecision(
  decision: { action: string; target?: string | null; targets?: string[] | null; message: string; reason: string },
  currentPhase: string,
  history: Array<{ role: string; agentId?: string | null; rawContent: string }>
): { action: string; target?: string | null; targets?: string[] | null; message: string; reason: string } {
  // alignment 中不允许直接 done
  if (currentPhase === 'alignment' && decision.action === 'done') {
    return { ...decision, action: 'align_confirm', reason: '对齐尚未完成，继续确认需求' }
  }

  // execution 中不允许回到 align_*
  if (currentPhase === 'execution' && decision.action.startsWith('align_')) {
    return { ...decision, action: 'execute', reason: '已在执行阶段' }
  }

  // Q&A 循环硬上限：如果已有 Agent 提问且用户已回答，强制执行
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

// Helper to create a minimal decision
function dec(action: string, overrides?: Partial<{ target: string | null; targets: string[] | null; message: string; reason: string }>) {
  return { action, message: '', reason: '', ...overrides }
}

describe('validateDecision — phase guards', () => {
  it('blocks done during alignment phase', () => {
    const result = validateDecision(dec('done'), 'alignment', [])
    expect(result.action).toBe('align_confirm')
    expect(result.reason).toContain('对齐')
  })

  it('allows done during execution phase', () => {
    const result = validateDecision(dec('done'), 'execution', [])
    expect(result.action).toBe('done')
  })

  it('blocks align_confirm during execution phase', () => {
    const result = validateDecision(dec('align_confirm'), 'execution', [])
    expect(result.action).toBe('execute')
  })

  it('blocks align_decompose during execution phase', () => {
    const result = validateDecision(dec('align_decompose'), 'execution', [])
    expect(result.action).toBe('execute')
  })

  it('blocks align_qa during execution phase', () => {
    const result = validateDecision(dec('align_qa'), 'execution', [])
    expect(result.action).toBe('execute')
  })

  it('allows align_* during alignment phase', () => {
    expect(validateDecision(dec('align_confirm'), 'alignment', []).action).toBe('align_confirm')
    expect(validateDecision(dec('align_decompose'), 'alignment', []).action).toBe('align_decompose')
    expect(validateDecision(dec('align_qa'), 'alignment', []).action).toBe('align_qa')
  })

  it('does not interfere during idle phase', () => {
    const result = validateDecision(dec('align_confirm'), 'idle', [])
    expect(result.action).toBe('align_confirm')
  })

  it('does not interfere during other phases', () => {
    const result = validateDecision(dec('done'), 'planning', [])
    expect(result.action).toBe('done')
  })
})

describe('validateDecision — Q&A loop detection', () => {
  it('forces execute when agent asked and user answered', () => {
    const history = [
      { role: 'user', agentId: null, rawContent: '搭建博客' },
      { role: 'agent', agentId: '产品经理', rawContent: '确认需求...' },
      { role: 'agent', agentId: '前端工程师', rawContent: '用 React 还是 Vue？' },
      { role: 'user', agentId: null, rawContent: '用 React' },
    ]
    const result = validateDecision(dec('align_qa'), 'alignment', history)
    expect(result.action).toBe('execute')
    expect(result.reason).toContain('Q&A已完成')
  })

  it('allows align_qa when no agent questions yet', () => {
    const history = [
      { role: 'user', agentId: null, rawContent: '搭建博客' },
      { role: 'agent', agentId: '架构师', rawContent: '方案...' },
    ]
    const result = validateDecision(dec('align_qa'), 'alignment', history)
    expect(result.action).toBe('align_qa')
  })

  it('allows align_qa when agent asked but user has not answered', () => {
    const history = [
      { role: 'user', agentId: null, rawContent: '搭建博客' },
      { role: 'agent', agentId: '前端工程师', rawContent: '用 React 还是 Vue？' },
    ]
    const result = validateDecision(dec('align_qa'), 'alignment', history)
    expect(result.action).toBe('align_qa')
  })

  it('allows align_qa when only PM/architect messages exist', () => {
    // PM and 架构师 are excluded from agent question detection
    const history = [
      { role: 'user', agentId: null, rawContent: '搭建博客' },
      { role: 'agent', agentId: '产品经理', rawContent: '需求确认...' },
      { role: 'agent', agentId: '架构师', rawContent: '技术方案...' },
    ]
    const result = validateDecision(dec('align_qa'), 'alignment', history)
    expect(result.action).toBe('align_qa')
  })

  it('forces execute when multiple agent Q&A rounds completed', () => {
    const history = [
      { role: 'user', agentId: null, rawContent: '搭建博客' },
      { role: 'agent', agentId: '前端工程师', rawContent: '用什么框架？' },
      { role: 'user', agentId: null, rawContent: 'React' },
      { role: 'agent', agentId: '后端工程师', rawContent: '用什么数据库？' },
      { role: 'user', agentId: null, rawContent: 'PostgreSQL' },
    ]
    const result = validateDecision(dec('align_qa'), 'alignment', history)
    expect(result.action).toBe('execute')
  })
})

describe('validateDecision — passthrough', () => {
  it('preserves self action', () => {
    const result = validateDecision(dec('self', { message: '好的' }), 'alignment', [])
    expect(result.action).toBe('self')
  })

  it('preserves delegate action', () => {
    const result = validateDecision(dec('delegate'), 'alignment', [])
    expect(result.action).toBe('delegate')
  })

  it('preserves discuss action', () => {
    const result = validateDecision(dec('discuss'), 'alignment', [])
    expect(result.action).toBe('discuss')
  })

  it('preserves execute action during execution', () => {
    const result = validateDecision(dec('execute'), 'execution', [])
    expect(result.action).toBe('execute')
  })

  it('preserves message and reason fields', () => {
    const d = dec('self', { message: 'hello', reason: 'chat' })
    const result = validateDecision(d, 'idle', [])
    expect(result.message).toBe('hello')
    expect(result.reason).toBe('chat')
  })

  it('preserves target and targets fields', () => {
    const d = dec('delegate', { target: 'frontend', targets: ['frontend', 'backend'] })
    const result = validateDecision(d, 'execution', [])
    expect(result.target).toBe('frontend')
    expect(result.targets).toEqual(['frontend', 'backend'])
  })
})

describe('validateDecision — reduce-based index lookup', () => {
  it('finds the last agent question index correctly', () => {
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

  it('returns -1 when no qualifying agent questions exist', () => {
    const history = [
      { role: 'user', agentId: null, rawContent: '搭建博客' },
      { role: 'agent', agentId: '产品经理', rawContent: '确认...' },
      { role: 'agent', agentId: '架构师', rawContent: '方案...' },
    ]
    const lastIdx = history.reduce((last, m, i) =>
      (m.role === 'agent' && m.agentId && m.agentId !== '产品经理' && m.agentId !== '架构师') ? i : last, -1
    )
    expect(lastIdx).toBe(-1)
  })

  it('returns -1 for empty history', () => {
    const lastIdx = ([] as Array<{ role: string; agentId?: string | null }>).reduce((last, m, i) =>
      (m.role === 'agent' && m.agentId && m.agentId !== '产品经理' && m.agentId !== '架构师') ? i : last, -1
    )
    expect(lastIdx).toBe(-1)
  })
})
