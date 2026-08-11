/**
 * A方向 P4（=B）: agent 流程挖掘（规划 §9.1）——消费 Session.decisionTrace 做
 * directly-follows 图 + 变体聚类。借 AgentFlow（跨 run directly-follows 图 + variant 聚类 + conformance）。
 *
 * 定位在"行为/决策"层（决策条目即行为），不是 LLM I/O 层（LangSmith/LangFuse 停在 token/latency/cost）。
 * 零 LLM 开销、纯函数不写库。checkConformance 在 decision-trace.ts 已就位（P4 由 API 消费）。
 *
 * 数据源说明（P3 已知裁剪）：
 * - 只采 applied===true 的 actualTransition 作边——LLM 决策转移 + P4 T1 补记的代码驱动转移都入列
 *   （redo/补拆/QA直发exec/自动done），directly-follows 图不再在这些边断裂
 * - escalate 条目不进边（状态未动），但计入 per-state escalateCount（A 的核心信号叠加在 B 的图上）
 * - corrections 计入 per-state correctionCount（corrections 驱动的变体是天然聚类维度）
 * - 每条按 ts 排序回放（乱序/并发可还原时序）
 *
 * 语义约定（供 UI 消费方对齐，pre-commit 声明vs实现审查）：
 * - nodes = 仅 applied 转移的端点。escalate/correction 状态可能有信号但不在 nodes——
 *   消费方须自行把 stateSignals 里不在 nodes 的状态补画（纯 escalate 会话会出现 nodes=[] 但 escalateCount>0）
 * - stateSignals.visits = "进入次数"（作为 applied 转移 to 被进入，含自环）。idle 结构性无入边恒 0，
 *   exec→exec 自环（redo）会通胀——勿当"活跃度"读
 * - deriveStateSeq 假设同 trace 内 applied 转移是链式的（from 接上一跳的 to，P3/P4 生产者保证）；
 *   非链式（并发/异常写入）会"搭桥"出未记录的序列段，属数据异常非本模块职责
 * - escalateCount 统计 escalated===true 条目（含 escalate_but_legal=代码误拦的漂移信号），
 *   细分（escalate vs escalate_but_legal）见 checkConformance
 */

import type { StoredDecisionTraceEntry } from './decision-trace'
import type { State } from './state-machine'

/** 一条 trace = 一个 session 的决策轨迹（跨会话挖掘的输入单元） */
export interface SessionTrace {
  sessionId: string
  entries: StoredDecisionTraceEntry[]
}

/** directly-follows 边：from -> to 转移的频次（权重） */
export interface ProcessEdge {
  from: State
  to: State
  count: number
}

/** 每状态信号：访问（进入次数）/ 升级 / 纠正 */
export interface StateSignals {
  visits: number
  escalateCount: number
  correctionCount: number
}

export interface ProcessModel {
  /** 出现在实际转移（applied 边）中的状态，按 STATE_ORDER 排序 */
  nodes: State[]
  /** directly-follows 边，按 count 降序 */
  edges: ProcessEdge[]
  /** 实际应用转移总数 */
  totalTransitions: number
  /** escalate 条目总数（含 escalate_but_legal；细分见 checkConformance） */
  escalateCount: number
  /** 发生纠正/守卫 redirect 的条目数 */
  correctionCount: number
  /** 每状态信号（6 个状态全量，0 起） */
  stateSignals: Record<State, StateSignals>
}

/** 变体（流程签名聚类）：同 stateSeq 的 trace 聚一组 */
export interface TraceVariant {
  /** 按 count 降序的频率序号：V1 = 最多 */
  id: string
  /** 去重连续重复后的状态序列（流程签名），如 ['idle','align_pm','align_arch','exec','done'] */
  stateSeq: State[]
  count: number
  sessionIds: string[]
  /** 该变体下发生纠正的条目数（corrections 驱动的子维度） */
  correctionCount: number
  /** 该变体下升级条目数 */
  escalateCount: number
}

/** 状态规范序（节点排序/流程签名稳定用） */
const STATE_ORDER: State[] = ['idle', 'align_pm', 'align_arch', 'align_qa', 'exec', 'done']
const VALID_STATES = new Set<string>(STATE_ORDER)

/**
 * 条目按 ts 升序（乱序/并发写入可回放）。
 * 容器级守卫（攻击者审查 F1）：entries 非数组 -> []（不击穿，兑现"畸形不击穿"承诺）。
 * 过滤畸形条目（null/非对象/缺 ts），防 comparator 崩。
 */
function sortByTs(entries: StoredDecisionTraceEntry[] | null | undefined): StoredDecisionTraceEntry[] {
  if (!Array.isArray(entries)) return []
  return entries
    .filter((e): e is StoredDecisionTraceEntry => !!e && typeof e === 'object' && typeof e.ts === 'string')
    .sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0))
}

/** trace 级守卫：非对象/缺 entries 数组 -> 跳过（攻击者审查 F1） */
function isValidTrace(t: unknown): t is SessionTrace {
  return !!t && typeof t === 'object' && Array.isArray((t as SessionTrace).entries)
}

/** 安全取实际转移；畸形/非对象/缺字段 -> null（不击穿，防御） */
function safeTransition(e: StoredDecisionTraceEntry): { from: State; to: State; action: string; applied: boolean; escalated: boolean } | null {
  const at = e?.actualTransition
  if (!at || typeof at !== 'object') return null
  if (typeof at.from !== 'string' || typeof at.to !== 'string' || typeof at.action !== 'string') return null
  if (!VALID_STATES.has(at.from) || !VALID_STATES.has(at.to)) return null
  return { from: at.from as State, to: at.to as State, action: at.action, applied: at.applied === true, escalated: at.escalated === true }
}

/**
 * 从一条 trace 导出状态序列（仅 applied 且非 escalate，去重连续重复）。
 * 如 entries: idle→align_arch / align_arch→exec / exec→exec(redo) / exec→done
 * -> [idle, align_arch, exec, done]（exec→exec 自环被连续去重吸收）。
 * 供 discoverProcess 的节点覆盖与 findVariants 的流程签名共用。
 * 声明vs实现审查 F9: escalated 条目与 collectSignals 语义对齐（升级=未应用,不进序列）。
 * 链式假设: from 接上一跳 to（生产者保证）；非链式会搭桥出未记录序列段,属数据异常。
 */
export function deriveStateSeq(entries: StoredDecisionTraceEntry[] | null | undefined): State[] {
  const seq: State[] = []
  for (const e of sortByTs(entries)) {
    const t = safeTransition(e)
    if (!t || !t.applied || t.escalated) continue
    // 首条：记录 from，之后只追加 to（from 已在上一跳的 to 里，除首条外）
    if (seq.length === 0) seq.push(t.from)
    // 连续去重：与 seq 尾相同则跳过（自环/原地不动）
    if (seq[seq.length - 1] !== t.to) seq.push(t.to)
  }
  return seq
}

/** 汇总所有 trace 的 applied 转移/升级/纠正信号（discoverProcess 与 findVariants 共用） */
function collectSignals(traces: SessionTrace[] | null | undefined): {
  edges: Map<string, ProcessEdge>
  totalTransitions: number
  escalateCount: number
  correctionCount: number
  stateSignals: Record<State, StateSignals>
} {
  const edges = new Map<string, ProcessEdge>()
  const key = (from: State, to: State) => `${from}>${to}`
  const signals: Record<State, StateSignals> = Object.fromEntries(STATE_ORDER.map(s => [s, { visits: 0, escalateCount: 0, correctionCount: 0 }])) as Record<State, StateSignals>
  let totalTransitions = 0
  let escalateCount = 0
  let correctionCount = 0

  for (const trace of traces ?? []) {
    if (!isValidTrace(trace)) continue
    for (const e of sortByTs(trace.entries)) {
      // correction: total 先无条件计数(数组守卫),per-state 依赖合法转移（生命周期审查 2.3 对齐 escalate）
      if (e?.corrections && Array.isArray(e.corrections) && e.corrections.length > 0) {
        correctionCount++
        const es = safeTransition(e)
        if (es) signals[es.from].correctionCount++
      }
      const at = e?.actualTransition
      if (!at || typeof at !== 'object') continue
      // escalate: 先计 total（含畸形无合法态），per-state 才依赖合法转移
      if (at.escalated === true) {
        escalateCount++
        const t = safeTransition(e)
        if (t) signals[t.from].escalateCount++
        continue // 未应用，不进边
      }
      const t = safeTransition(e)
      if (!t || !t.applied) continue
      totalTransitions++
      signals[t.to].visits++
      const k = key(t.from, t.to)
      const cur = edges.get(k)
      if (cur) cur.count++
      else edges.set(k, { from: t.from, to: t.to, count: 1 })
    }
  }

  return { edges, totalTransitions, escalateCount, correctionCount, stateSignals: signals }
}

/**
 * discoverProcess：跨 trace 聚合 directly-follows 图。
 * 节点=applied 边端点，边=applied 转移（权重=频次），escalate 不进边但计入 per-state 信号。
 * 消费方注意：escalate/correction 状态可能有信号但不在 nodes（见模块头"语义约定"）。
 */
export function discoverProcess(traces: SessionTrace[] | null | undefined): ProcessModel {
  const { edges, totalTransitions, escalateCount, correctionCount, stateSignals } = collectSignals(traces)
  const nodes = new Set<State>()
  for (const e of edges.values()) {
    nodes.add(e.from)
    nodes.add(e.to)
  }
  return {
    nodes: STATE_ORDER.filter(s => nodes.has(s)),
    edges: [...edges.values()].sort((a, b) => b.count - a.count),
    totalTransitions,
    escalateCount,
    correctionCount,
    stateSignals,
  }
}

/**
 * findVariants：按流程签名（去重连续重复的状态序列）聚类 trace。单遍遍历——
 * 生命周期审查 1.2/1.4 整改：group 内无死字段、deriveStateSeq 不双算。
 * id 按 count 降序赋（V1=最多，声明vs实现审查 1.3）。
 * corrections 驱动的变体是天然聚类维度——同签名有/无纠正分属不同信号（见 TraceVariant.correctionCount）。
 * 空签名 trace（无 applied 转移）归入 { stateSeq: [] } 组。
 */
export function findVariants(traces: SessionTrace[] | null | undefined): TraceVariant[] {
  const groups = new Map<string, { stateSeq: State[]; count: number; sessionIds: string[]; correctionCount: number; escalateCount: number }>()
  for (const trace of traces ?? []) {
    if (!isValidTrace(trace)) continue
    const stateSeq = deriveStateSeq(trace.entries)
    const key = stateSeq.join('>')
    let correction = 0
    let escalate = 0
    for (const e of trace.entries) {
      if (e?.corrections && Array.isArray(e.corrections) && e.corrections.length > 0) correction++
      const t = safeTransition(e)
      if (t?.escalated) escalate++
    }
    const g = groups.get(key)
    if (g) {
      g.count++
      if (typeof trace.sessionId === 'string') g.sessionIds.push(trace.sessionId)
      g.correctionCount += correction
      g.escalateCount += escalate
    } else {
      groups.set(key, {
        stateSeq,
        count: 1,
        sessionIds: typeof trace.sessionId === 'string' ? [trace.sessionId] : [],
        correctionCount: correction,
        escalateCount: escalate,
      })
    }
  }
  return [...groups.values()]
    .sort((a, b) => b.count - a.count || a.stateSeq.join('>').localeCompare(b.stateSeq.join('>')))
    .map((g, i) => ({ id: `V${i + 1}`, ...g }))
}
