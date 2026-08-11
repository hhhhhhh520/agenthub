import { describe, it, expect } from 'vitest'
import { discoverProcess, findVariants, deriveStateSeq } from '@/lib/orchestrator/process-mining'
import type { SessionTrace } from '@/lib/orchestrator/process-mining'
import type { StoredDecisionTraceEntry } from '@/lib/orchestrator/decision-trace'

/** 构造存储态条目（补 ts 等默认字段）供纯函数测试 */
function stored(partial: Partial<StoredDecisionTraceEntry>): StoredDecisionTraceEntry {
  return {
    ts: 't',
    decisionPoint: 'handleOrchestratorDecision',
    inputState: { phase: 'idle', phaseStep: '', state: 'idle' },
    llmProposal: { action: 'execute', reason: 'r' },
    corrections: [],
    validation: { passed: true, validator: 'applyTransition' },
    actualTransition: { from: 'idle', to: 'exec', action: 'execute', applied: true, escalated: false },
    ...partial,
  }
}

const idle2arch = stored({ ts: 't1', actualTransition: { from: 'idle', to: 'align_arch', action: 'align_decompose', applied: true, escalated: false } })
const arch2exec = stored({ ts: 't2', actualTransition: { from: 'align_arch', to: 'exec', action: 'execute', applied: true, escalated: false } })
const idle2exec = stored({ ts: 't3', actualTransition: { from: 'idle', to: 'exec', action: 'execute', applied: true, escalated: false } })
const exec2done = stored({ ts: 't4', actualTransition: { from: 'exec', to: 'done', action: 'done', applied: true, escalated: false } })

describe('deriveStateSeq（流程签名）', () => {
  it('applied 转移导出状态序列,连续重复(自环)去重', () => {
    const redo = stored({ ts: 't2.5', actualTransition: { from: 'exec', to: 'exec', action: 'execute', applied: true, escalated: false } })
    // idle→align_arch → align_arch→exec → exec→exec(redo 自环) → exec→done
    expect(deriveStateSeq([idle2arch, arch2exec, redo, exec2done])).toEqual(['idle', 'align_arch', 'exec', 'done'])
  })

  it('按 ts 排序回放（乱序输入不影响序列）', () => {
    // 输入乱序,ts 保证时序
    expect(deriveStateSeq([exec2done, idle2arch, arch2exec])).toEqual(['idle', 'align_arch', 'exec', 'done'])
  })

  it('escalate/未应用条目不进序列', () => {
    const esc = stored({ actualTransition: { from: 'align_pm', to: 'align_pm', action: 'align_qa', applied: false, escalated: true } })
    expect(deriveStateSeq([idle2arch, esc, arch2exec])).toEqual(['idle', 'align_arch', 'exec'])
  })

  it('畸形条目跳过不击穿', () => {
    expect(deriveStateSeq([null as unknown as StoredDecisionTraceEntry, idle2arch])).toEqual(['idle', 'align_arch'])
  })

  it('无 applied 转移 → 空序列', () => {
    const esc = stored({ actualTransition: { from: 'idle', to: 'idle', action: 'done', applied: false, escalated: true } })
    expect(deriveStateSeq([esc])).toEqual([])
  })
})

describe('discoverProcess（directly-follows 图）', () => {
  it('跨 trace 聚合边权,节点按 STATE_ORDER 排序', () => {
    const traceA: SessionTrace = { sessionId: 'A', entries: [idle2arch, arch2exec] }
    const traceB: SessionTrace = { sessionId: 'B', entries: [idle2exec] }
    const model = discoverProcess([traceA, traceB])
    expect(model.totalTransitions).toBe(3)
    expect(model.edges).toContainEqual({ from: 'idle', to: 'align_arch', count: 1 })
    expect(model.edges).toContainEqual({ from: 'align_arch', to: 'exec', count: 1 })
    expect(model.edges).toContainEqual({ from: 'idle', to: 'exec', count: 1 })
    expect(model.nodes).toEqual(['idle', 'align_arch', 'exec'])
    // 边按 count 降序
    expect(model.edges[0].count).toBeGreaterThanOrEqual(model.edges[model.edges.length - 1].count)
  })

  it('同向边跨 trace 累加权值', () => {
    const trace = (id: string): SessionTrace => ({ sessionId: id, entries: [idle2exec] })
    const model = discoverProcess([trace('A'), trace('B'), trace('C')])
    expect(model.edges).toContainEqual({ from: 'idle', to: 'exec', count: 3 })
  })

  it('escalate 不进边但计入 escalateCount 与 per-state 信号（A 信号叠加在 B 图上）', () => {
    const esc = stored({ actualTransition: { from: 'align_pm', to: 'align_pm', action: 'align_qa', applied: false, escalated: true } })
    const model = discoverProcess([{ sessionId: 'S', entries: [idle2exec, esc] }])
    expect(model.totalTransitions).toBe(1)
    expect(model.escalateCount).toBe(1)
    expect(model.stateSignals.align_pm.escalateCount).toBe(1)
    expect(model.edges.some(e => e.from === 'align_pm')).toBe(false) // escalate 不进边
  })

  it('redo 自环（exec→exec）保留为边', () => {
    const redo = stored({ actualTransition: { from: 'exec', to: 'exec', action: 'execute', applied: true, escalated: false } })
    const model = discoverProcess([{ sessionId: 'S', entries: [idle2exec, redo] }])
    expect(model.edges).toContainEqual({ from: 'exec', to: 'exec', count: 1 })
  })

  it('corrections 计入 correctionCount 与 per-state 信号', () => {
    const corrected = stored({ corrections: [{ from: 'execute', to: 'align_decompose', reason: '确定性闸门' }], actualTransition: { from: 'idle', to: 'align_arch', action: 'align_decompose', applied: true, escalated: false } })
    const model = discoverProcess([{ sessionId: 'S', entries: [idle2exec, corrected] }])
    expect(model.correctionCount).toBe(1)
    expect(model.stateSignals.idle.correctionCount).toBe(1)
    expect(model.stateSignals.idle.visits).toBe(0) // idle 从没被"进入"(它是起点),exec 被进入 1 次
    expect(model.stateSignals.exec.visits).toBe(1)
  })

  it('空输入 → 空模型,stateSignals 全 0', () => {
    const model = discoverProcess([])
    expect(model.totalTransitions).toBe(0)
    expect(model.escalateCount).toBe(0)
    expect(model.nodes).toEqual([])
    expect(model.edges).toEqual([])
    expect(model.stateSignals.idle).toEqual({ visits: 0, escalateCount: 0, correctionCount: 0 })
  })

  it('畸形条目跳过不击穿', () => {
    const model = discoverProcess([{ sessionId: 'S', entries: [null as unknown as StoredDecisionTraceEntry, { ts: 'x' } as unknown as StoredDecisionTraceEntry, idle2exec] }])
    expect(model.totalTransitions).toBe(1)
  })
})

describe('findVariants（流程变体聚类）', () => {
  it('同流程签名聚一组,count + sessionIds 正确', () => {
    const traceA: SessionTrace = { sessionId: 'A', entries: [idle2exec] }
    const traceB: SessionTrace = { sessionId: 'B', entries: [idle2exec] }
    const traceC: SessionTrace = { sessionId: 'C', entries: [idle2arch, arch2exec] }
    const variants = findVariants([traceA, traceB, traceC])
    expect(variants).toHaveLength(2)
    expect(variants[0].stateSeq).toEqual(['idle', 'exec']) // count 2 优先
    expect(variants[0].count).toBe(2)
    expect(variants[0].sessionIds).toEqual(['A', 'B'])
    expect(variants[1].stateSeq).toEqual(['idle', 'align_arch', 'exec'])
    expect(variants[1].count).toBe(1)
  })

  it('corrections 维度: 同签名有/无纠正分属不同信号（聚类维度）', () => {
    const withCorrection: SessionTrace = { sessionId: 'A', entries: [stored({ corrections: [{ from: 'execute', to: 'align_decompose', reason: 'r' }], actualTransition: { from: 'idle', to: 'exec', action: 'execute', applied: true, escalated: false } })] }
    const clean: SessionTrace = { sessionId: 'B', entries: [idle2exec] }
    const variants = findVariants([withCorrection, clean])
    expect(variants[0].stateSeq).toEqual(['idle', 'exec'])
    expect(variants[0].count).toBe(2) // 同签名仍聚一组
    expect(variants[0].correctionCount).toBe(1) // 该组 1 条带纠正
    expect(variants[0].escalateCount).toBe(0)
  })

  it('单 trace → 1 个变体', () => {
    const variants = findVariants([{ sessionId: 'A', entries: [idle2arch, arch2exec] }])
    expect(variants).toHaveLength(1)
    expect(variants[0].stateSeq).toEqual(['idle', 'align_arch', 'exec'])
    expect(variants[0].sessionIds).toEqual(['A'])
  })

  it('无 applied 转移的 trace → 空签名变体', () => {
    const esc = stored({ actualTransition: { from: 'idle', to: 'idle', action: 'done', applied: false, escalated: true } })
    const variants = findVariants([{ sessionId: 'A', entries: [esc] }])
    expect(variants).toHaveLength(1)
    expect(variants[0].stateSeq).toEqual([])
    expect(variants[0].escalateCount).toBe(1)
  })

  it('空输入 → 空变体', () => {
    expect(findVariants([])).toEqual([])
  })
})

describe('P4 T3 pre-commit 审查整改守卫', () => {
  it('容器级畸形（entries null/非数组、trace null、traces null）→ 不击穿（攻击者 F1）', () => {
    expect(discoverProcess([{ sessionId: 'S', entries: null as unknown as StoredDecisionTraceEntry[] }]).totalTransitions).toBe(0)
    expect(discoverProcess([null as unknown as SessionTrace])).toMatchObject({ totalTransitions: 0 })
    expect(discoverProcess(null as unknown as SessionTrace[])).toMatchObject({ totalTransitions: 0 })
    expect(deriveStateSeq(null as unknown as StoredDecisionTraceEntry[])).toEqual([])
    expect(findVariants([null as unknown as SessionTrace])).toEqual([])
  })

  it('矛盾标志位（applied:true && escalated:true）→ 按 escalate 处理: 不进边、不进签名（攻击者 F9）', () => {
    const weird = stored({ actualTransition: { from: 'idle', to: 'exec', action: 'execute', applied: true, escalated: true } })
    expect(deriveStateSeq([weird])).toEqual([]) // 不产生幻影流
    const model = discoverProcess([{ sessionId: 'S', entries: [weird] }])
    expect(model.edges).toEqual([]) // 不进边
    expect(model.escalateCount).toBe(1)
  })

  it('边按 count 降序（差异化权重,防"全 1 恒真"走过场——声明vs实现 Q2）', () => {
    const trace: SessionTrace = { sessionId: 'S', entries: [idle2exec, idle2exec, idle2arch, arch2exec] }
    const model = discoverProcess([trace])
    // idle>exec ×2, idle>align_arch ×1, align_arch>exec ×1 → 严格降序
    expect(model.edges.map(e => `${e.from}>${e.to}:${e.count}`)).toEqual(['idle>exec:2', 'idle>align_arch:1', 'align_arch>exec:1'])
  })

  it('空输入 → 6 个 stateSignals 全量 0 起（声明vs实现 Q2）', () => {
    const model = discoverProcess([])
    for (const s of ['idle', 'align_pm', 'align_arch', 'align_qa', 'exec', 'done'] as const) {
      expect(model.stateSignals[s]).toEqual({ visits: 0, escalateCount: 0, correctionCount: 0 })
    }
  })

  it('同空签名多 trace 聚一组,escalateCount 跨 trace 累加（声明vs实现 Q2 覆盖）', () => {
    const esc1 = stored({ actualTransition: { from: 'idle', to: 'idle', action: 'done', applied: false, escalated: true } })
    const esc2 = stored({ actualTransition: { from: 'align_pm', to: 'align_pm', action: 'align_qa', applied: false, escalated: true } })
    const variants = findVariants([
      { sessionId: 'A', entries: [esc1] },
      { sessionId: 'B', entries: [esc2] },
    ])
    expect(variants).toHaveLength(1)
    expect(variants[0].stateSeq).toEqual([])
    expect(variants[0].count).toBe(2)
    expect(variants[0].sessionIds).toEqual(['A', 'B'])
    expect(variants[0].escalateCount).toBe(2)
  })

  it('变体 id 按频率序: V1=最多（声明vs实现审查 1.3）', () => {
    const variants = findVariants([
      { sessionId: 'A', entries: [idle2arch, arch2exec] },
      { sessionId: 'B', entries: [idle2exec] },
      { sessionId: 'C', entries: [idle2exec] },
    ])
    expect(variants[0].id).toBe('V1')
    expect(variants[0].stateSeq).toEqual(['idle', 'exec']) // 频率最高
    expect(variants[1].id).toBe('V2')
    expect(variants[1].stateSeq).toEqual(['idle', 'align_arch', 'exec'])
  })

  it('首条即自环 → 序列 [from]（生命周期审查 2.1 覆盖）', () => {
    const redo = stored({ actualTransition: { from: 'exec', to: 'exec', action: 'execute', applied: true, escalated: false } })
    expect(deriveStateSeq([redo])).toEqual(['exec'])
  })
})
