import { describe, it, expect, vi, beforeEach } from 'vitest'

// --- Mocks ---
const { mockFindUnique } = vi.hoisted(() => ({ mockFindUnique: vi.fn() }))
vi.mock('@/lib/db', () => ({ prisma: { session: { findUnique: mockFindUnique } } }))

import { GET } from '@/app/api/sessions/[id]/process/route'

const params = { params: Promise.resolve({ id: 's1' }) }
function makeReq() { return new Request('http://localhost/api/sessions/s1/process') }

/** 构造合法决策条目（applied 转移） */
function entry(from: string, to: string, action: string, ts: string, extra?: object) {
  return {
    ts,
    decisionPoint: 'handleOrchestratorDecision',
    inputState: { phase: 'idle', phaseStep: '', state: from },
    llmProposal: { action, reason: 'r' },
    corrections: [],
    validation: { passed: true, validator: 'applyTransition' },
    actualTransition: { from, to, action, applied: true, escalated: false },
    ...extra,
  }
}

beforeEach(() => { vi.resetAllMocks() })

describe('GET /api/sessions/[id]/process（单会话流程挖掘消费方）', () => {
  it('404 when session not found', async () => {
    mockFindUnique.mockResolvedValueOnce(null)
    const res = await GET(makeReq(), params)
    expect(res.status).toBe(404)
  })

  it('返回 conformance + process(directly-follows) + variants', async () => {
    mockFindUnique.mockResolvedValueOnce({ decisionTrace: JSON.stringify([
      entry('idle', 'align_arch', 'align_decompose', 't1'),
      entry('align_arch', 'exec', 'execute', 't2'),
    ]) })
    const res = await GET(makeReq(), params)
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.sessionId).toBe('s1')
    // checkConformance 接线
    expect(json.conformance.total).toBe(2)
    expect(json.conformance.conforming).toBe(2)
    // discoverProcess 接线（edges 精确相等: 防 spurious 边,声明vs实现 Q3）
    expect(json.process.totalTransitions).toBe(2)
    expect(json.process.edges).toEqual([
      { from: 'idle', to: 'align_arch', count: 1 },
      { from: 'align_arch', to: 'exec', count: 1 },
    ])
    // findVariants 接线（单 trace → 1 变体）
    expect(json.variants).toHaveLength(1)
    expect(json.variants[0].stateSeq).toEqual(['idle', 'align_arch', 'exec'])
  })

  it('空/畸形 trace → conformance/process 空,变体为空签名组(不 500)', async () => {
    mockFindUnique.mockResolvedValueOnce({ decisionTrace: 'not json' })
    const res = await GET(makeReq(), params)
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.conformance.total).toBe(0)
    expect(json.process.totalTransitions).toBe(0)
    expect(json.process.edges).toEqual([])
    // findVariants 设计: 无 applied 转移的 trace 归入空签名组(stateSeq:[]),不击穿
    expect(json.variants).toHaveLength(1)
    expect(json.variants[0].stateSeq).toEqual([])
  })

  it('escalate 条目计入 conformance.escalateCount（A 核心信号走通）', async () => {
    mockFindUnique.mockResolvedValueOnce({ decisionTrace: JSON.stringify([
      entry('align_pm', 'align_pm', 'align_qa', 't1', {
        validation: { passed: false, validator: 'applyTransition', reason: '非法' },
        actualTransition: { from: 'align_pm', to: 'align_pm', action: 'align_qa', applied: false, escalated: true },
      }),
    ]) })
    const res = await GET(makeReq(), params)
    const json = await res.json()
    expect(json.conformance.escalateCount).toBe(1)
    expect(json.conformance.violations[0].kind).toBe('escalate')
    expect(json.process.escalateCount).toBe(1)
  })
})
