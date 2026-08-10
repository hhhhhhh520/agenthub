import { describe, it, expect, vi, beforeEach } from 'vitest'

// --- Mocks ---
const { mockSessionFindUnique, mockSessionUpdate } = vi.hoisted(() => ({
  mockSessionFindUnique: vi.fn(),
  mockSessionUpdate: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/lib/db', () => ({
  prisma: {
    session: { findUnique: mockSessionFindUnique, update: mockSessionUpdate },
  },
}))

import {
  stateFromSession,
  applyTransition,
  canonicalCorrect,
  transitionPhase,
  STATE_PHASE,
  type State,
} from '@/lib/orchestrator/state-machine'

describe('state-machine: stateFromSession', () => {
  it('7 个已知组合各返回正确 State', () => {
    expect(stateFromSession('idle', '')).toBe('idle')
    expect(stateFromSession('alignment', 'pm_confirm')).toBe('align_pm')
    expect(stateFromSession('alignment', 'architect_plan')).toBe('align_arch')
    expect(stateFromSession('alignment', 'agent_qa')).toBe('align_qa')
    expect(stateFromSession('execution', '')).toBe('exec')
    expect(stateFromSession('done', '')).toBe('done')
    // phaseStep 非空但 phase 是非 alignment 的已知 phase -> 仍按 phase 归位（容忍脏数据）
    expect(stateFromSession('execution', 'pm_confirm')).toBe('exec')
  })

  it('未知组合 -> idle 兜底（在途会话兼容）', () => {
    expect(stateFromSession('alignment', '')).toBe('idle') // alignment 无 step
    expect(stateFromSession('alignment', 'unknown_step')).toBe('idle')
    expect(stateFromSession('weird', '')).toBe('idle') // 未知 phase
    expect(stateFromSession('', '')).toBe('idle')
  })
})

describe('state-machine: applyTransition', () => {
  it('旁路 action（self/delegate/discuss/verify）合法于任何状态，不转 phase', () => {
    for (const state of ['idle', 'align_pm', 'align_arch', 'align_qa', 'exec', 'done'] as State[]) {
      const r = applyTransition(state, 'self')
      expect(r.ok).toBe(true)
      if (r.ok) expect(r.nextState).toBe(state)
    }
    const r = applyTransition('align_pm', 'delegate')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.nextState).toBe('align_pm')
  })

  it('表中合法转移返回 ok+nextState', () => {
    expect(applyTransition('idle', 'align_confirm')).toEqual({ ok: true, nextState: 'align_pm' })
    expect(applyTransition('idle', 'align_decompose')).toEqual({ ok: true, nextState: 'align_arch' })
    expect(applyTransition('idle', 'execute')).toEqual({ ok: true, nextState: 'exec' })
    expect(applyTransition('align_pm', 'align_decompose')).toEqual({ ok: true, nextState: 'align_arch' })
    expect(applyTransition('align_arch', 'align_qa')).toEqual({ ok: true, nextState: 'align_qa' })
    expect(applyTransition('align_arch', 'execute')).toEqual({ ok: true, nextState: 'exec' })
    expect(applyTransition('align_qa', 'execute')).toEqual({ ok: true, nextState: 'exec' })
    expect(applyTransition('exec', 'done')).toEqual({ ok: true, nextState: 'done' })
    expect(applyTransition('done', 'align_confirm')).toEqual({ ok: true, nextState: 'align_pm' })
  })

  it('exec back-edge：align_decompose 合法（任务为空时补拆 fallback）', () => {
    expect(applyTransition('exec', 'align_decompose')).toEqual({ ok: true, nextState: 'align_arch' })
    expect(applyTransition('align_qa', 'align_decompose')).toEqual({ ok: true, nextState: 'align_arch' })
  })

  it('exec 自环：execute no-op', () => {
    expect(applyTransition('exec', 'execute')).toEqual({ ok: true, nextState: 'exec' })
  })

  it('容错自环：重复 align_confirm/align_decompose/align_qa', () => {
    expect(applyTransition('align_pm', 'align_confirm')).toEqual({ ok: true, nextState: 'align_pm' })
    expect(applyTransition('align_arch', 'align_decompose')).toEqual({ ok: true, nextState: 'align_arch' })
    expect(applyTransition('align_qa', 'align_qa')).toEqual({ ok: true, nextState: 'align_qa' })
  })

  it('真非法转移返回 ok:false+reason', () => {
    const r1 = applyTransition('align_pm', 'execute')
    expect(r1.ok).toBe(false)
    if (!r1.ok) expect(r1.reason).toContain('align_pm')
    if (!r1.ok) expect(r1.reason).toContain('execute')

    // align_pm + done 非法（表中无，由 canonicalCorrect 纠正）
    expect(applyTransition('align_pm', 'done').ok).toBe(false)
    // exec + align_qa 非法（由 canonicalCorrect 纠正）
    expect(applyTransition('exec', 'align_qa').ok).toBe(false)
    // done + verify 是旁路（合法），done + delegate 旁路合法
    expect(applyTransition('done', 'verify').ok).toBe(true)
  })
})

describe('state-machine: canonicalCorrect (Hybrid 3 条纠正)', () => {
  it('规则1：align_pm + done -> redirect align_decompose', () => {
    expect(canonicalCorrect('align_pm', 'done')).toEqual({ redirect: 'align_decompose' })
  })

  it('规则1：align_arch/align_qa + done -> redirect execute', () => {
    expect(canonicalCorrect('align_arch', 'done')).toEqual({ redirect: 'execute' })
    expect(canonicalCorrect('align_qa', 'done')).toEqual({ redirect: 'execute' })
  })

  it('规则2：exec + align_* -> redirect execute', () => {
    expect(canonicalCorrect('exec', 'align_confirm')).toEqual({ redirect: 'execute' })
    expect(canonicalCorrect('exec', 'align_decompose')).toEqual({ redirect: 'execute' })
    expect(canonicalCorrect('exec', 'align_qa')).toEqual({ redirect: 'execute' })
  })

  it('规则3：align_qa 提议且 history 显示已答 -> redirect execute', () => {
    const history = [
      { role: 'user', rawContent: '开发todo' },
      { role: 'agent', agentId: '产品经理', rawContent: 'pm确认' },
      { role: 'user', rawContent: '确认' },
      { role: 'agent', agentId: '架构师', rawContent: '方案' },
      { role: 'agent', agentId: '前端工程师', rawContent: '用什么框架？' },
      { role: 'user', rawContent: 'React' },
    ]
    expect(canonicalCorrect('align_qa', 'align_qa', history)).toEqual({ redirect: 'execute' })
  })

  it('规则3：align_qa 提议但未答 -> 不纠正', () => {
    const history = [
      { role: 'user', rawContent: '开发todo' },
      { role: 'agent', agentId: '前端工程师', rawContent: '用什么框架？' },
    ]
    expect(canonicalCorrect('align_qa', 'align_qa', history)).toBeNull()
  })

  it('规则3：非对齐态（idle/align_pm）不触发（state 限定，防跨态假纠正）', () => {
    const answered = [
      { role: 'agent', agentId: '前端工程师', rawContent: 'q' },
      { role: 'user', rawContent: 'a' },
    ]
    expect(canonicalCorrect('idle', 'align_qa', answered)).toBeNull()
    expect(canonicalCorrect('align_pm', 'align_qa', answered)).toBeNull()
    // exec+align_qa 命中规则2（继续执行），非规则3
    expect(canonicalCorrect('exec', 'align_qa', answered)).toEqual({ redirect: 'execute' })
  })

  it('规则3：无 history 不纠正', () => {
    expect(canonicalCorrect('align_qa', 'align_qa')).toBeNull()
  })

  it('合法提议不纠正', () => {
    expect(canonicalCorrect('idle', 'align_confirm')).toBeNull()
    expect(canonicalCorrect('align_pm', 'align_decompose')).toBeNull()
    expect(canonicalCorrect('exec', 'done')).toBeNull()
    expect(canonicalCorrect('idle', 'self')).toBeNull()
  })

  it('idle + done 不纠正（合法，直接放行）', () => {
    expect(canonicalCorrect('idle', 'done')).toBeNull()
  })
})

describe('state-machine: transitionPhase', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('旁路 action 不读不写库，直接 ok', async () => {
    const r = await transitionPhase('s1', 'self')
    expect(r.ok).toBe(true)
    expect(mockSessionFindUnique).not.toHaveBeenCalled()
    expect(mockSessionUpdate).not.toHaveBeenCalled()
  })

  it('合法 transitioning action：读 state + 写 STATE_PHASE[nextState]', async () => {
    mockSessionFindUnique.mockResolvedValue({ phase: 'idle', phaseStep: '' })
    const r = await transitionPhase('s1', 'align_confirm')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.nextState).toBe('align_pm')
    expect(mockSessionUpdate).toHaveBeenCalledWith({
      where: { id: 's1' },
      data: STATE_PHASE.align_pm,
    })
  })

  it('exec + done：写 done', async () => {
    mockSessionFindUnique.mockResolvedValue({ phase: 'execution', phaseStep: '' })
    const r = await transitionPhase('s1', 'done')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.nextState).toBe('done')
    expect(mockSessionUpdate).toHaveBeenCalledWith({
      where: { id: 's1' },
      data: STATE_PHASE.done,
    })
  })

  it('非法（状态与快照不一致）-> fail-closed：不写库，可见 warn', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // align_pm 状态下调用 execute（表中非法：handler 直发边界或并发快照过期）
    mockSessionFindUnique.mockResolvedValue({ phase: 'alignment', phaseStep: 'pm_confirm' })
    const r = await transitionPhase('s1', 'execute')
    expect(r.ok).toBe(false)
    expect(r.nextState).toBeUndefined()
    expect(mockSessionUpdate).not.toHaveBeenCalled() // 不把 phase 写到转移表之外的值
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('拒绝'))
    warnSpy.mockRestore()
  })

  it('DB 异常 -> try/catch 记 warn 返回 ok:false，不击穿调用方', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mockSessionFindUnique.mockRejectedValue(new Error('db down'))
    const r = await transitionPhase('s1', 'align_confirm')
    expect(r.ok).toBe(false)
    expect(mockSessionUpdate).not.toHaveBeenCalled()
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('异常'))
    warnSpy.mockRestore()
  })

  it('session 不存在 -> ok:false 不写库', async () => {
    mockSessionFindUnique.mockResolvedValue(null)
    const r = await transitionPhase('missing', 'align_confirm')
    expect(r.ok).toBe(false)
    expect(mockSessionUpdate).not.toHaveBeenCalled()
  })

  it('老会话未知 phase 组合 -> stateFromSession idle 兜底后正常转移', async () => {
    // alignment + 未知 step -> idle；idle + align_confirm -> align_pm 合法
    mockSessionFindUnique.mockResolvedValue({ phase: 'alignment', phaseStep: '' })
    const r = await transitionPhase('s1', 'align_confirm')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.nextState).toBe('align_pm')
  })
})
