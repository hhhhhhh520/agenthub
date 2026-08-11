import { describe, it, expect, vi, beforeEach } from 'vitest'

// --- Mocks ---
const { mockSessionUpdateMany, mockSessionFindUnique } = vi.hoisted(() => ({
  mockSessionUpdateMany: vi.fn(),
  mockSessionFindUnique: vi.fn(),
}))
vi.mock('@/lib/db', () => ({ prisma: { session: { updateMany: mockSessionUpdateMany, findUnique: mockSessionFindUnique } } }))

import { appendDecisionTrace, checkConformance, MAX_DECISION_TRACE_ENTRIES } from '@/lib/orchestrator/decision-trace'
import type { DecisionTraceEntry, StoredDecisionTraceEntry } from '@/lib/orchestrator/decision-trace'

const baseEntry: DecisionTraceEntry = {
  decisionPoint: 'handleOrchestratorDecision',
  inputState: { phase: 'idle', phaseStep: '', state: 'idle' },
  llmProposal: { action: 'align_decompose', reason: 'r' },
  corrections: [],
  validation: { passed: true, validator: 'applyTransition' },
  actualTransition: { from: 'idle', to: 'align_arch', action: 'align_decompose', applied: true, escalated: false },
}

/** 构造存储态条目（补 ts）供 checkConformance 纯函数用 */
function stored(partial: Partial<StoredDecisionTraceEntry>): StoredDecisionTraceEntry {
  return { ts: 't', ...baseEntry, ...partial }
}

beforeEach(() => {
  vi.resetAllMocks()
  mockSessionUpdateMany.mockResolvedValue({ count: 1 })
})

describe('appendDecisionTrace（P3 §5.6 safe-append + 乐观锁）', () => {
  it('追加一条并写入 ts 时间戳（条件写 where 带当前值）', async () => {
    const next = await appendDecisionTrace('s1', '[]', baseEntry)
    expect(next).not.toBeNull()
    const arr = JSON.parse(next!)
    expect(arr).toHaveLength(1)
    expect(arr[0]).toMatchObject({ decisionPoint: 'handleOrchestratorDecision', ts: expect.any(String) })
    expect(mockSessionUpdateMany).toHaveBeenCalledWith({
      where: { id: 's1', decisionTrace: '[]' },
      data: { decisionTrace: next },
    })
  })

  it('畸形既有 trace（坏 JSON/非数组）→ 丢弃旧值只留本条，不击穿', async () => {
    for (const bad of ['not json', '{"a":1}', 'null', '123']) {
      const next = await appendDecisionTrace('s1', bad, baseEntry)
      expect(JSON.parse(next!)).toHaveLength(1)
    }
  })

  it('undefined/null/空串既有 trace → 从空数组开始', async () => {
    for (const cur of [undefined, null, '']) {
      const next = await appendDecisionTrace('s1', cur, baseEntry)
      expect(JSON.parse(next!)).toHaveLength(1)
    }
  })

  it('既有合法数组 → 追加到末尾保留旧条目', async () => {
    const old = JSON.stringify([{ ts: 'old', ...baseEntry }])
    const next = await appendDecisionTrace('s1', old, baseEntry)
    expect(JSON.parse(next!)).toHaveLength(2)
    expect(JSON.parse(next!)[0]).toMatchObject({ ts: 'old' })
  })

  it('乐观锁冲突（count=0）→ 重读最新值重试，不丢并发条目', async () => {
    // 并发请求已把 trace 从 '[]' 推进到 old 数组；本请求基于过期快照 '[]' 写入 → 冲突 → 重读重试
    const old = JSON.stringify([{ ts: 'concurrent', ...baseEntry }])
    mockSessionUpdateMany.mockResolvedValueOnce({ count: 0 }) // 第一次（过期快照）冲突
    mockSessionFindUnique.mockResolvedValueOnce({ decisionTrace: old })
    mockSessionUpdateMany.mockResolvedValueOnce({ count: 1 }) // 重试成功
    const next = await appendDecisionTrace('s1', '[]', baseEntry)
    const arr = JSON.parse(next!)
    expect(arr).toHaveLength(2) // 并发写入的旧条目 + 本条，都没丢
    expect(arr[0]).toMatchObject({ ts: 'concurrent' })
  })

  it('乐观锁冲突持续（count=0 3 次）→ 重试超限返回 null 不抛出', async () => {
    mockSessionUpdateMany.mockResolvedValue({ count: 0 })
    mockSessionFindUnique.mockResolvedValue({ decisionTrace: '[]' })
    const next = await appendDecisionTrace('s1', '[]', baseEntry)
    expect(next).toBeNull()
    expect(mockSessionUpdateMany).toHaveBeenCalledTimes(3)
  })

  it('写库异常 → 返回 null 不抛出（不击穿决策点）', async () => {
    mockSessionUpdateMany.mockRejectedValue(new Error('db down'))
    const next = await appendDecisionTrace('s1', '[]', baseEntry)
    expect(next).toBeNull()
  })

  it('P4 T2: 超过封顶 → 保留最近 N 条,丢弃最旧（O(n²) 退化为 O(N) 常量）', async () => {
    // 预置满 N 条,再追加 1 条 -> 共 N+1 -> 封顶 slice(-N),最旧 t0 被丢
    const full = JSON.stringify(
      Array.from({ length: MAX_DECISION_TRACE_ENTRIES }, (_, i) => ({ ts: `t${i}`, ...baseEntry }))
    )
    const next = await appendDecisionTrace('s1', full, baseEntry)
    const arr = JSON.parse(next!)
    expect(arr).toHaveLength(MAX_DECISION_TRACE_ENTRIES)
    expect(arr[0]).toMatchObject({ ts: 't1' }) // t0 被丢弃
    expect(arr[arr.length - 1]).toMatchObject({ ts: expect.any(String) }) // 新条目保留
    // 乐观锁 where 用传入 base(未封顶满数组),data 是封顶后的 next
    expect(mockSessionUpdateMany).toHaveBeenCalledWith({
      where: { id: 's1', decisionTrace: full },
      data: { decisionTrace: next },
    })
  })

  it('P4 T2 审查整改: 乐观锁冲突 → 重读 fresh(满 500) → 重试封顶收敛（声明vs实现 Finding 7 覆盖）', async () => {
    // base 是调用方长快照(501 条),DB 已是封顶 500 → 首写 where=长串 count=0 冲突 → 重读 fresh=封顶 → 重写成功
    const longBase = JSON.stringify(Array.from({ length: MAX_DECISION_TRACE_ENTRIES + 1 }, (_, i) => ({ ts: `b${i}`, ...baseEntry })))
    const full = JSON.stringify(Array.from({ length: MAX_DECISION_TRACE_ENTRIES }, (_, i) => ({ ts: `c${i}`, ...baseEntry })))
    mockSessionUpdateMany.mockResolvedValueOnce({ count: 0 }) // 基于过期长快照冲突
    mockSessionFindUnique.mockResolvedValueOnce({ decisionTrace: full }) // DB 已是封顶 500
    mockSessionUpdateMany.mockResolvedValueOnce({ count: 1 }) // 重试基于 fresh 封顶值成功
    const next = await appendDecisionTrace('s1', longBase, baseEntry)
    const arr = JSON.parse(next!)
    expect(arr).toHaveLength(MAX_DECISION_TRACE_ENTRIES) // 封顶生效
    // 重试写: where 用 fresh(封顶值)而非旧长快照——与 DB 匹配,收敛
    const [retryArg] = mockSessionUpdateMany.mock.calls[1]
    expect(retryArg.where).toEqual({ id: 's1', decisionTrace: full })
  })
})

describe('checkConformance（AgentFlow 指标,同时服务 A/B）', () => {
  it('全合法转移 → conforming, 无违规, ratio=1', () => {
    const entries = [
      stored({ actualTransition: { from: 'idle', to: 'align_arch', action: 'align_decompose', applied: true, escalated: false } }),
      stored({ actualTransition: { from: 'align_arch', to: 'exec', action: 'execute', applied: true, escalated: false } }),
      stored({ actualTransition: { from: 'exec', to: 'done', action: 'done', applied: true, escalated: false } }),
    ]
    const r = checkConformance(entries)
    expect(r.total).toBe(3)
    expect(r.conforming).toBe(3)
    expect(r.violations).toEqual([])
    expect(r.ratio).toBe(1)
  })

  it('旁路 action（self/delegate/discuss/verify）→ to===from 即合法', () => {
    const entries = [
      stored({ actualTransition: { from: 'exec', to: 'exec', action: 'self', applied: true, escalated: false } }),
      stored({ actualTransition: { from: 'align_pm', to: 'align_pm', action: 'delegate', applied: true, escalated: false } }),
      stored({ actualTransition: { from: 'align_qa', to: 'align_qa', action: 'verify', applied: true, escalated: false } }),
    ]
    const r = checkConformance(entries)
    expect(r.conforming).toBe(3)
    expect(r.escalateCount).toBe(0)
  })

  it('escalate（非法提议被拦下）→ kind escalate, escalateCount 计入', () => {
    // align_pm + align_qa 表内非法
    const entries = [
      stored({ actualTransition: { from: 'align_pm', to: 'align_pm', action: 'align_qa', applied: false, escalated: true } }),
    ]
    const r = checkConformance(entries)
    expect(r.escalateCount).toBe(1)
    expect(r.conforming).toBe(0)
    expect(r.violations[0].kind).toBe('escalate')
    expect(r.violations[0].detail).toContain('align_pm + align_qa')
  })

  it('escalate 但转移其实合法 → kind escalate_but_legal（applyTransition 误判 = 代码漂移），不计 escalateCount', () => {
    // idle + align_confirm 表内合法（-> align_pm），却被 escalate = 代码 bug
    const entries = [
      stored({ actualTransition: { from: 'idle', to: 'align_pm', action: 'align_confirm', applied: false, escalated: true } }),
    ]
    const r = checkConformance(entries)
    expect(r.violations[0].kind).toBe('escalate_but_legal')
    expect(r.escalateCount).toBe(0) // 非"LLM 提议非法"，不混入指标
  })

  it('记录的实际转移表内非法 → illegal_transition 违规（声明vs实现漂移 bug）', () => {
    // idle + align_confirm 转移表应为 align_pm；记成 done = 表外
    const entries = [
      stored({ actualTransition: { from: 'idle', to: 'done', action: 'align_confirm', applied: true, escalated: false } }),
    ]
    const r = checkConformance(entries)
    expect(r.conforming).toBe(0)
    expect(r.violations[0].kind).toBe('illegal_transition')
    expect(r.violations[0].detail).toContain('align_pm')
  })

  it('P3 回归守卫: Object.prototype 成员名 action 不命中继承属性 → illegal_transition（不误判合法）', () => {
    const entries = [
      stored({ actualTransition: { from: 'idle', to: 'idle', action: 'toString', applied: true, escalated: false } }),
      stored({ actualTransition: { from: 'idle', to: 'idle', action: 'constructor', applied: true, escalated: false } }),
    ]
    const r = checkConformance(entries)
    expect(r.conforming).toBe(0)
    expect(r.violations.every(v => v.kind === 'illegal_transition')).toBe(true)
  })

  it('畸形条目（null/缺 actualTransition）→ kind malformed，不击穿', () => {
    const entries = [null as unknown as StoredDecisionTraceEntry, { ts: 'x' } as unknown as StoredDecisionTraceEntry]
    const r = checkConformance(entries)
    expect(r.violations).toHaveLength(2)
    expect(r.violations.every(v => v.kind === 'malformed')).toBe(true)
  })

  it('纠正条目计入 correctionCount（服务 B：流程变体统计）', () => {
    const entries = [
      stored({ corrections: [{ from: 'done', to: 'execute', reason: '还有 1 个未完成任务' }] }),
      stored({ corrections: [] }),
    ]
    const r = checkConformance(entries)
    expect(r.correctionCount).toBe(1)
  })

  it('空数组 → total 0, ratio 0, 无违规', () => {
    const r = checkConformance([])
    expect(r.total).toBe(0)
    expect(r.ratio).toBe(0)
    expect(r.violations).toEqual([])
  })
})
