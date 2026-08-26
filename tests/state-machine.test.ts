import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// --- Mocks ---
// P4 T1: transitionPhase 补记代码驱动转移 -> appendDecisionTrace 用 session.updateMany,加 mock
const { mockSessionFindUnique, mockSessionUpdate, mockSessionUpdateMany } = vi.hoisted(() => ({
  mockSessionFindUnique: vi.fn(),
  mockSessionUpdate: vi.fn().mockResolvedValue(undefined),
  mockSessionUpdateMany: vi.fn(),
}))

vi.mock('@/lib/db', () => ({
  prisma: {
    session: { findUnique: mockSessionFindUnique, update: mockSessionUpdate, updateMany: mockSessionUpdateMany },
  },
}))

import {
  stateFromSession,
  applyTransition,
  canonicalCorrect,
  transitionPhase,
  idleExecuteGate,
  applyTransitionWithOverride,
  isExperimentOff,
  isSeqgateOn,
  idlePrematureDoneGate,
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

  it('P3 回归守卫: Object.prototype 成员名 action 不被继承属性绕过 fail-closed（自有属性查找）', () => {
    // 攻击者审查抓出：TRANSITIONS[state]?.[action] 属性链查找被 toString/constructor 继承属性命中 → 误判 ok → 静默吞消息
    expect(applyTransition('idle', 'toString').ok).toBe(false)
    expect(applyTransition('idle', 'constructor').ok).toBe(false)
    expect(applyTransition('idle', 'valueOf').ok).toBe(false)
    expect(applyTransition('idle', 'hasOwnProperty').ok).toBe(false)
    expect(applyTransition('exec', '__proto__').ok).toBe(false)
    // 表内 action 不受影响
    expect(applyTransition('idle', 'execute')).toEqual({ ok: true, nextState: 'exec' })
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
    // P4 T1: 默认让补记的 appendDecisionTrace 一次成功(合法写库后走 updateMany 条件写),旧测试不受 retry 噪音影响
    mockSessionUpdateMany.mockResolvedValue({ count: 1 })
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

  // === P4 T1: transitionPhase 补记代码驱动转移（redo/补拆/QA直发exec/自动done 不经决策点） ===

  it('代码驱动转移（无 opts）→ 写库后补记 trace：decisionPoint=transitionPhase, from→to 正确', async () => {
    mockSessionFindUnique.mockResolvedValue({ phase: 'idle', phaseStep: '', decisionTrace: '[]' })
    const r = await transitionPhase('s1', 'align_confirm')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.nextState).toBe('align_pm')
    expect(mockSessionUpdate).toHaveBeenCalledWith({ where: { id: 's1' }, data: STATE_PHASE.align_pm })
    // 补记：乐观锁条件写 where 带当前 decisionTrace，data 含新条目
    expect(mockSessionUpdateMany).toHaveBeenCalledTimes(1)
    const [arg] = mockSessionUpdateMany.mock.calls[0]
    expect(arg.where).toEqual({ id: 's1', decisionTrace: '[]' })
    const arr = JSON.parse(arg.data.decisionTrace)
    expect(arr).toHaveLength(1)
    expect(arr[0]).toMatchObject({
      decisionPoint: 'transitionPhase',
      inputState: { phase: 'idle', phaseStep: '', state: 'idle' },
      llmProposal: { action: 'align_confirm', reason: '代码驱动转移（不经决策点）' },
      corrections: [],
      validation: { passed: true, validator: 'transitionPhase' },
      actualTransition: { from: 'idle', to: 'align_pm', action: 'align_confirm', applied: true, escalated: false },
    })
  })

  it('recordTrace:false（LLM 决策路径抑制）→ 只写 phase 不补记（updateMany 未被调）', async () => {
    mockSessionFindUnique.mockResolvedValue({ phase: 'execution', phaseStep: '', decisionTrace: '[]' })
    const r = await transitionPhase('s1', 'done', { recordTrace: false })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.nextState).toBe('done')
    expect(mockSessionUpdate).toHaveBeenCalledWith({ where: { id: 's1' }, data: STATE_PHASE.done })
    expect(mockSessionUpdateMany).not.toHaveBeenCalled()
  })

  it('补记失败（updateMany 抛错）→ transitionPhase 照常 ok:true（trace 是 best-effort,不击穿主路径）', async () => {
    mockSessionFindUnique.mockResolvedValue({ phase: 'idle', phaseStep: '', decisionTrace: '[]' })
    mockSessionUpdateMany.mockRejectedValue(new Error('db down'))
    const r = await transitionPhase('s1', 'align_confirm')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.nextState).toBe('align_pm')
    expect(mockSessionUpdate).toHaveBeenCalledTimes(1) // phase 写成功,补记失败不击穿
    // 声明vs实现 Finding 2: 必须断言 append 确实被尝试(updateMany 被调)——否则实现若"根本不补记"此测试也绿
    expect(mockSessionUpdateMany).toHaveBeenCalledTimes(1)
  })
})

describe('idleExecuteGate (P2 idle→execute 确定性闸门)', () => {
  it('无任务 -> 拒绝跳步（连"简单"都无从证明）', () => {
    expect(idleExecuteGate(0, false)).toBe(false)
    expect(idleExecuteGate(0, true)).toBe(false)
  })

  it('有任务但含代码任务 -> 拒绝跳步（需先对齐）', () => {
    expect(idleExecuteGate(1, true)).toBe(false)
    expect(idleExecuteGate(3, true)).toBe(false)
  })

  it('有任务且全非代码 -> 允许简单任务跳步', () => {
    expect(idleExecuteGate(1, false)).toBe(true)
    expect(idleExecuteGate(5, false)).toBe(true)
  })
})

describe('P5: applyTransitionWithOverride（状态机 off 开关）', () => {
  it('bypass + 表内 action → 表值 + inTable:true', () => {
    expect(applyTransitionWithOverride('idle', 'execute', true)).toEqual({ ok: true, nextState: 'exec', inTable: true })
  })
  it('bypass + 旁路 action → 当前态 + inTable:true（任意状态合法）', () => {
    expect(applyTransitionWithOverride('idle', 'self', true)).toEqual({ ok: true, nextState: 'idle', inTable: true })
  })
  it('bypass + 表外 action → 当前态 + inTable:false（无幻 phase）', () => {
    expect(applyTransitionWithOverride('idle', 'align_qa', true)).toEqual({ ok: true, nextState: 'idle', inTable: false })
  })
  it('非 bypass → 与 applyTransition 完全一致', () => {
    expect(applyTransitionWithOverride('idle', 'execute', false)).toEqual(applyTransition('idle', 'execute'))
    expect(applyTransitionWithOverride('idle', 'align_qa', false)).toEqual(applyTransition('idle', 'align_qa'))
  })
  it('isExperimentOff: off 时 true / 缺省时 false', () => {
    const prev = process.env.EXPERIMENT_STATE_MACHINE
    try {
      process.env.EXPERIMENT_STATE_MACHINE = 'off'
      expect(isExperimentOff()).toBe(true)
      delete process.env.EXPERIMENT_STATE_MACHINE
      expect(isExperimentOff()).toBe(false)
    } finally {
      // 断言失败也恢复 env，防 'off' 残留污染后续测试（审查整改：try/finally）
      if (prev === undefined) delete process.env.EXPERIMENT_STATE_MACHINE
      else process.env.EXPERIMENT_STATE_MACHINE = prev
    }
  })
  it('off 接线：transitionPhase 表外 action 不再 fail-closed（写当前态 + ok:true，无幻 phase）', async () => {
    const prev = process.env.EXPERIMENT_STATE_MACHINE
    try {
      process.env.EXPERIMENT_STATE_MACHINE = 'off'
      // align_pm + execute：转移表非法（applyTransition fail-closed）→ bypass 下变 ok:true + 当前态
      mockSessionFindUnique.mockResolvedValue({ phase: 'alignment', phaseStep: 'pm_confirm', decisionTrace: '[]' })
      const r = await transitionPhase('s1', 'execute')
      expect(r.ok).toBe(true)
      if (r.ok) expect(r.nextState).toBe('align_pm') // 表外 → 当前态，不制造幻 phase
      expect(mockSessionUpdate).toHaveBeenCalledWith({ where: { id: 's1' }, data: STATE_PHASE.align_pm })
    } finally {
      if (prev === undefined) delete process.env.EXPERIMENT_STATE_MACHINE
      else process.env.EXPERIMENT_STATE_MACHINE = prev
    }
  })
  it('P6 A0: transitionPhase 补记 OFF 表外 self-edge 记 applied:false', async () => {
    const prev = process.env.EXPERIMENT_STATE_MACHINE
    process.env.EXPERIMENT_STATE_MACHINE = 'off'
    try {
      // 隔离本用例的 updateMany 调用历史：全文件跑时前面测试（代码驱动转移 applied:true）也写过 trace,
      // find 会命中旧调用导致误判——mockClear 后只剩本用例自生的调用
      mockSessionUpdateMany.mockClear()
      mockSessionFindUnique.mockResolvedValue({ id: 's1', phase: 'idle', phaseStep: '', decisionTrace: '[]' })
      await transitionPhase('s1', 'align_qa')  // idle→align_qa 表外
      const traceCall = mockSessionUpdateMany.mock.calls.find(c => c[0].data?.decisionTrace)
      const entry = JSON.parse(traceCall![0].data.decisionTrace)
      expect(entry[0].actualTransition.applied).toBe(false)
    } finally { if (prev === undefined) delete process.env.EXPERIMENT_STATE_MACHINE; else process.env.EXPERIMENT_STATE_MACHINE = prev }
  })
})

describe('P9-乙 idlePrematureDoneGate', () => {
  afterEach(() => { delete process.env.EXPERIMENT_SEQGATE })

  it('idle+done+零任务 → 拦截', () => {
    expect(idlePrematureDoneGate('idle', 'done', 0)).toBe(true)
  })
  it('idle+done+有任务 → 放行（合法性交还转移表）', () => {
    expect(idlePrematureDoneGate('idle', 'done', 2)).toBe(false)
  })
  it('非 idle 态的 done → 放行', () => {
    expect(idlePrematureDoneGate('exec', 'done', 0)).toBe(false)
    expect(idlePrematureDoneGate('align_pm', 'done', 0)).toBe(false)
  })
  it('idle 态非 done action → 放行', () => {
    expect(idlePrematureDoneGate('idle', 'execute', 0)).toBe(false)
    expect(idlePrematureDoneGate('idle', 'self', 0)).toBe(false)
  })
})

describe('P9-乙 EXPERIMENT_SEQGATE 严格相等语义（F4）', () => {
  afterEach(() => { delete process.env.EXPERIMENT_SEQGATE })
  it("仅 'on' 激活", () => {
    process.env.EXPERIMENT_SEQGATE = 'on'
    expect(isSeqgateOn()).toBe(true)
  })
  it("真值字符串 '1'/'true'/'ON'/空串 均不激活（防残留值 fail-unsafe）", () => {
    for (const v of ['1', 'true', 'ON', '']) {
      process.env.EXPERIMENT_SEQGATE = v
      expect(isSeqgateOn()).toBe(false)
    }
  })
  it('未设 → 不激活（生产行为不变）', () => {
    delete process.env.EXPERIMENT_SEQGATE
    expect(isSeqgateOn()).toBe(false)
  })
})
