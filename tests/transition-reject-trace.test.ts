import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ── ISSUE-025：决策点 trace 记 applied:true 而 transitionPhase 拒写（拒绝型 trace/DB 分歧）──
//
// 决策点（chat-router）先落库 applied:true 再派发 handler；handler 内 transitionPhase 在
// 并发下会 fail-closed 拒写（合法性翻转 / CAS 快照冲突超限）——此前两个失败路径静默 ok:false，
// trace 全绿而 DB 未动，checkConformance 看不见拒绝。
//
// 修法（工单方案 A 变体）：transitionPhase 内部在两个"提议未落地"失败路径补记拒绝回执条目
// （decisionPoint:'transitionPhase'，actualTransition {applied:false, escalated:false,
// casRejected:true}）——recordTrace:false 只抑制成功路径的双记，不抑制拒绝回执（回执是
// 与预记条目不同的事件，正是本工单要补的可见性）。
//
// 🔑 分类纪律（checkConformance 约束）：拒绝回执绝不能伪装成 escalated=true——
// 合法转移被拒会被标 escalate_but_legal（代码漂移 bug），污染 ON 口径 oracle。
// casRejected 条目单独成桶（casRejectCount），既非 violation 也非 conforming。

import { transitionPhase } from '@/lib/orchestrator/state-machine'
import { checkConformance } from '@/lib/orchestrator/decision-trace'

const mocks = vi.hoisted(() => ({
  mockSessionFindUnique: vi.fn(),
  mockSessionUpdateMany: vi.fn(),
}))

vi.mock('@/lib/db', () => ({
  prisma: {
    session: {
      findUnique: mocks.mockSessionFindUnique,
      updateMany: mocks.mockSessionUpdateMany,
    },
  },
}))

describe('transitionPhase 拒绝回执（ISSUE-025 修法 A）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    delete process.env.EXPERIMENT_STATE_MACHINE
  })

  it('CAS 快照冲突超限 → ok:false + 拒绝回执条目（recordTrace:false 不抑制回执）', async () => {
    // phase 写恒 count=0（僵尸流持续占用快照），trace 写 count=1（append 成功）
    mocks.mockSessionFindUnique.mockResolvedValue({ phase: 'execution', phaseStep: '', decisionTrace: '[]' })
    mocks.mockSessionUpdateMany.mockImplementation(async (args: { where: Record<string, unknown> }) => {
      if ('decisionTrace' in args.where) return { count: 1 }
      return { count: 0 } // phase 快照恒冲突
    })

    const res = await transitionPhase('s-1', 'done', { recordTrace: false })

    expect(res.ok).toBe(false)
    // 3 次 phase 尝试，全部 where 携带读时快照（B2 纪律回归）
    const phaseWrites = mocks.mockSessionUpdateMany.mock.calls.filter(c => 'phase' in c[0].where)
    expect(phaseWrites.length).toBe(3)
    // 拒绝回执恰 1 条（变异锚点：去掉回执 → 此断言红；trace/DB 分歧回到不可见）
    const traceWrites = mocks.mockSessionUpdateMany.mock.calls.filter(c => 'decisionTrace' in c[0].where)
    expect(traceWrites.length).toBe(1)
    expect(traceWrites[0][0].where).toEqual({ id: 's-1', decisionTrace: '[]' })
    const entries = JSON.parse(traceWrites[0][0].data.decisionTrace) as Array<Record<string, unknown>>
    const last = entries.at(-1) as { decisionPoint: string; actualTransition: Record<string, unknown>; llmProposal: { action: string } }
    expect(last.decisionPoint).toBe('transitionPhase')
    expect(last.llmProposal.action).toBe('done')
    expect(last.actualTransition).toMatchObject({
      from: 'exec', to: 'exec', action: 'done',
      applied: false, escalated: false, casRejected: true,
    })
  })

  it('合法性翻转（决策时合法、执行时并发漂移为非法）→ ok:false + 拒绝回执（validation 记未过原因）', async () => {
    // 决策点在 exec 预记 done（合法）；handler 的 transitionPhase 读到已被并发改写的 align_pm
    mocks.mockSessionFindUnique.mockResolvedValue({ phase: 'alignment', phaseStep: 'pm_confirm', decisionTrace: '[{"decisionPoint":"handleOrchestratorDecision"}]' })
    mocks.mockSessionUpdateMany.mockResolvedValue({ count: 1 })

    const res = await transitionPhase('s-2', 'done', { recordTrace: false })

    expect(res.ok).toBe(false)
    // 非法转移不写 phase（fail-closed 回归）
    const phaseWrites = mocks.mockSessionUpdateMany.mock.calls.filter(c => 'phase' in c[0].where)
    expect(phaseWrites.length).toBe(0)
    const traceWrites = mocks.mockSessionUpdateMany.mock.calls.filter(c => 'decisionTrace' in c[0].where)
    expect(traceWrites.length).toBe(1)
    // 乐观锁 where 携带重读到的决策轨迹快照（不是空数组）
    expect(traceWrites[0][0].where).toEqual({ id: 's-2', decisionTrace: '[{"decisionPoint":"handleOrchestratorDecision"}]' })
    const entries = JSON.parse(traceWrites[0][0].data.decisionTrace) as Array<Record<string, unknown>>
    expect(entries.length).toBe(2) // 原决策点条目 + 拒绝回执（追加不覆盖）
    const last = entries.at(-1) as { actualTransition: Record<string, unknown>; validation: { passed: boolean } }
    expect(last.actualTransition).toMatchObject({
      from: 'align_pm', to: 'align_pm', action: 'done',
      applied: false, escalated: false, casRejected: true,
    })
    expect(last.validation.passed).toBe(false)
  })

  it('成功路径零变化：ok:true + recordTrace:false → 无任何 decisionTrace 写（不双记回归）', async () => {
    mocks.mockSessionFindUnique.mockResolvedValue({ phase: 'execution', phaseStep: '', decisionTrace: '[]' })
    mocks.mockSessionUpdateMany.mockResolvedValue({ count: 1 })

    const res = await transitionPhase('s-3', 'done', { recordTrace: false })

    expect(res.ok).toBe(true)
    expect(res.nextState).toBe('done')
    const traceWrites = mocks.mockSessionUpdateMany.mock.calls.filter(c => 'decisionTrace' in c[0].where)
    expect(traceWrites.length).toBe(0)
  })
})

describe('checkConformance：casRejected 条目独立成桶（不伪装 escalate/illegal）', () => {
  it('casRejected 条目 → casRejectCount=1、零 violation、不计 conforming', () => {
    const entries = [
      {
        decisionPoint: 'transitionPhase',
        inputState: { phase: 'execution', phaseStep: '', state: 'exec' },
        llmProposal: { action: 'done', reason: 'transitionPhase 拒绝回执' },
        corrections: [],
        validation: { passed: true, validator: 'transitionPhase' },
        actualTransition: { from: 'exec', to: 'exec', action: 'done', applied: false, escalated: false, casRejected: true },
      },
    ] as never[]
    const c = checkConformance(entries)
    expect(c.casRejectCount).toBe(1)
    expect(c.violations).toEqual([])
    expect(c.conforming).toBe(0)
    expect(c.escalateCount).toBe(0)
  })

  it('混合条目：合法 applied + casRejected → 各归其位（oracle 过滤 illegal/escalate_but_legal 不受影响）', () => {
    const entries = [
      {
        decisionPoint: 'transitionPhase',
        inputState: { phase: 'execution', phaseStep: '', state: 'exec' },
        llmProposal: { action: 'done', reason: '代码驱动转移' },
        corrections: [],
        validation: { passed: true, validator: 'transitionPhase' },
        actualTransition: { from: 'exec', to: 'done', action: 'done', applied: true, escalated: false },
      },
      {
        decisionPoint: 'transitionPhase',
        inputState: { phase: 'execution', phaseStep: '', state: 'exec' },
        llmProposal: { action: 'done', reason: 'transitionPhase 拒绝回执' },
        corrections: [],
        validation: { passed: true, validator: 'transitionPhase' },
        actualTransition: { from: 'exec', to: 'exec', action: 'done', applied: false, escalated: false, casRejected: true },
      },
    ] as never[]
    const c = checkConformance(entries)
    expect(c.conforming).toBe(1)
    expect(c.casRejectCount).toBe(1)
    expect(c.violations).toEqual([])
  })
})
