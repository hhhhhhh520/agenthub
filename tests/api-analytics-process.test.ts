import { describe, it, expect, vi, beforeEach } from 'vitest'

// --- Mocks ---
const { mockCount, mockFindMany } = vi.hoisted(() => ({
  mockCount: vi.fn(),
  mockFindMany: vi.fn(),
}))
vi.mock('@/lib/db', () => ({ prisma: { session: { count: mockCount, findMany: mockFindMany } } }))

import { GET } from '@/app/api/analytics/process/route'

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

describe('GET /api/analytics/process（跨会话流程挖掘聚合）', () => {
  it('聚合 conformance + discoverProcess + findVariants,统计 total/tracedSessions + sessions', async () => {
    mockCount.mockResolvedValueOnce(3) // totalSessions 用 count(),不再全量 findMany
    mockFindMany.mockResolvedValueOnce([
      { id: 'a', title: 'A', decisionTrace: JSON.stringify([entry('idle', 'exec', 'execute', 't1')]) },
      { id: 'b', title: 'B', decisionTrace: JSON.stringify([entry('idle', 'align_arch', 'align_decompose', 't1'), entry('align_arch', 'exec', 'execute', 't2')]) },
      { id: 'c', title: 'C', decisionTrace: JSON.stringify([entry('idle', 'exec', 'execute', 't1')]) },
    ]) // tracedSessions
    const res = await GET()
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.totalSessions).toBe(3)
    expect(json.tracedSessions).toBe(3)
    // sessions 数组只含被计入的 session（声明vs实现 Q3: 此前零断言,push 位置回归会漏）
    expect(json.sessions).toEqual([
      { id: 'a', title: 'A' },
      { id: 'b', title: 'B' },
      { id: 'c', title: 'C' },
    ])
    // 聚合 conformance
    expect(json.conformance.total).toBe(4)
    expect(json.conformance.conforming).toBe(4)
    // 聚合 discoverProcess: idle>exec ×2, idle>align_arch ×1, align_arch>exec ×1
    expect(json.process.totalTransitions).toBe(4)
    expect(json.process.edges).toContainEqual({ from: 'idle', to: 'exec', count: 2 })
    expect(json.process.edges).toContainEqual({ from: 'align_arch', to: 'exec', count: 1 })
    // findVariants: [idle,exec] 变体 count 2 优先
    expect(json.variants[0].stateSeq).toEqual(['idle', 'exec'])
    expect(json.variants[0].count).toBe(2)
    expect(json.variants[0].sessionIds).toEqual(['a', 'c'])
    expect(json.variants[1].stateSeq).toEqual(['idle', 'align_arch', 'exec'])
    expect(json.variants[1].sessionIds).toEqual(['b'])
  })

  it('decisionTrace=[] 的 session 不计入 tracedSessions,不进挖掘,不进 sessions', async () => {
    mockCount.mockResolvedValueOnce(2)
    mockFindMany.mockResolvedValueOnce([
      { id: 'a', title: 'A', decisionTrace: '[]' },
      { id: 'b', title: 'B', decisionTrace: JSON.stringify([entry('idle', 'exec', 'execute', 't1')]) },
    ])
    const json = await (await GET()).json()
    expect(json.totalSessions).toBe(2)
    expect(json.tracedSessions).toBe(1)
    expect(json.sessions).toEqual([{ id: 'b', title: 'B' }])
    expect(json.process.totalTransitions).toBe(1)
    expect(json.variants[0].sessionIds).toEqual(['b'])
  })

  it('畸形 trace → 跳过不击穿,不 500', async () => {
    mockCount.mockResolvedValueOnce(1)
    mockFindMany.mockResolvedValueOnce([{ id: 'a', title: 'A', decisionTrace: 'not json' }])
    const res = await GET()
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.totalSessions).toBe(1)
    expect(json.tracedSessions).toBe(0)
    expect(json.sessions).toEqual([])
    expect(json.process.totalTransitions).toBe(0)
    expect(json.variants).toEqual([])
  })

  // §4.1 G2（phase3-4.1-visualization-gap.md）：violations 无 sessionId 则"哪次协作跑偏"无法定位
  // （route.ts:15 已知边界"消费方需自行定位归属"——G2 把归属做进 API）。跨 session 拍平后
  // violations[].index 是 allEntries 全局下标，sessionId 需由 index→session 映射补齐。
  it('G2：violations 每条补 sessionId（跨 session 拍平下归属可定位）', async () => {
    mockCount.mockResolvedValueOnce(2)
    mockFindMany.mockResolvedValueOnce([
      // session a：1 条 escalate 违规（index 0）
      { id: 'a', title: 'A', decisionTrace: JSON.stringify([
        entry('align_pm', 'align_pm', 'align_qa', 't1', {
          validation: { passed: false, validator: 'applyTransition', reason: '非法' },
          actualTransition: { from: 'align_pm', to: 'align_pm', action: 'align_qa', applied: false, escalated: true },
        }),
      ]) },
      // session b：先 1 条 conforming（占 index 1），再 1 条 escalate（index 2）——验证映射不串位
      { id: 'b', title: 'B', decisionTrace: JSON.stringify([
        entry('idle', 'exec', 'execute', 't1'),
        entry('exec', 'exec', 'done', 't2', {
          validation: { passed: false, validator: 'applyTransition', reason: '非法' },
          actualTransition: { from: 'exec', to: 'exec', action: 'done', applied: false, escalated: true },
        }),
      ]) },
    ])
    const json = await (await GET()).json()
    expect(json.conformance.violations).toHaveLength(2)
    expect(json.conformance.violations[0]).toMatchObject({ index: 0, kind: 'escalate', sessionId: 'a' })
    expect(json.conformance.violations[1]).toMatchObject({ index: 2, kind: 'escalate', sessionId: 'b' })
  })
})
