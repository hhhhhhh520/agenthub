/**
 * A方向 P3: 决策轨迹（decision trace）-- 补"决策输入"字段，回答"为什么"
 *
 * 现有 trace（Task.trace）只记执行结果（start/error/success/correction/blocked），
 * 回答不了"为什么会走这一步"。本模块补"决策输入"（§5.6 六字段）：
 *   路由决策点（哪个 LLM call 做了转移决策）/ 决策时 input state / LLM 提议的 next action /
 *   代码校验结果 / 实际转移 / 被否决的备选。
 *
 * 借 Temporal 精神：LLM 每轮提议 + 实际转移记进历史——重试/恢复时复用同一转移
 * （避免 LLM 重提议给不同值导致状态漂移）。P3 落地"记进历史"（数据就位），
 * 重试复用机制是 P4/P5 消费（重放/恢复路径存在后才有"复用"的对象）。
 *
 * conformance 指标（AgentFlow checkConformance）：同时服务
 *   A（是否走非法转移：escalate=LLM 提议非法被拦下；escalate_but_legal=合法转移被代码误拦，属漂移 bug；
 *      illegal_transition=记录的实际转移不在转移表内，属代码漂移 bug）
 *   B（流程挖掘：决策条目里的 actualTransition 即"LLM 决策转移"的 directly-follows 数据；
 *      代码驱动的转移——redo/0-task 补拆/QA 直发 exec——走 transitionPhase 不经决策点，P3 不记，
 *      若 B 需要全量 directly-follows 图，P4 在 transitionPhase 内补记）
 *
 * 已拍板的 P3 裁剪（相对 §5.6 来源列）：
 *   - 字段②只记 (phase, phaseStep, state)，不记上游 consumed outputs 全文——决策基于的上下文
 *     即 Message 历史，可经同 sessionId 从 Message 表还原，记全量会无限撑大 trace
 *   - 字段③只记 action/target/targets/reason，不记 message 全文（LLM 指令文本见 orchestrator 的 [决策] 事件）
 *   - 字段④ validator 当前唯一是 applyTransition；ReacTOD 式约束分类（schema/coreference）是 P4 消费的扩展
 *
 * 详见 D:\ai全栈挑战赛\A方向-显式状态机-规划.md §5.6。
 */

import { prisma } from '@/lib/db'
import { TRANSITIONS, NON_TRANSITIONING, type State, type Action } from './state-machine'

/** 决策轨迹条目（§5.6 六字段 + ts 时间戳） */
export interface DecisionTraceEntry {
  /** ① 路由决策点：哪个 LLM call 做了转移决策 */
  decisionPoint: string
  /** ② 决策时 input state：entry 时的 (phase, phaseStep) + 解析出的复合态（上下文可从 Message 历史还原） */
  inputState: { phase: string; phaseStep: string; state: State }
  /** ③ LLM 提议的 next action（getOrchestratorDecision 原始返回的 action/target/targets/reason） */
  llmProposal: { action: string; target?: string | null; targets?: string[] | null; reason: string }
  /** ⑥ 被否决的备选：规范化纠正 + 业务守卫把提议 redirect 到其他 action（每条记原提议与去向） */
  corrections: Array<{ from: string; to: string; reason: string }>
  /** ④ 代码校验结果：最终 applyTransition 校验是否通过、违反什么约束（纠正/守卫的"为什么"在 corrections） */
  validation: { passed: boolean; validator: string; reason?: string }
  /** ⑤ 实际转移：from_state → to_state；escalate 时 applied=false（未写库，to 保持 from） */
  actualTransition: { from: State; to: State; action: string; applied: boolean; escalated: boolean }
}

/** 写入时补的时间戳（ISO，保证乱序/回放可排序） */
export type StoredDecisionTraceEntry = DecisionTraceEntry & { ts: string }

/** safe-parse：畸形 JSON / 非数组 → []（不击穿；与 Task.trace appendTrace 同构） */
function parseTrace(raw: string | null | undefined): unknown[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

/**
 * 追加一条决策轨迹。
 *
 * 乐观锁条件写：updateMany where 带 decisionTrace 当前值，count=1 → 成功；count=0 →
 * 读改写被并发请求打断（session 锁 60s 超时 < LLM 决策 120s，见规划 §7 P2 待办⑤），
 * 重读最新值重试（至多 3 次）——审计数据丢了不可自愈，宁可多一轮读也不静默丢条目。
 *
 * 返回追加后的 JSON 数组（测试断言用）；写库异常 / 重试超限返回 null（不击穿决策点，决策照常走）。
 */
export async function appendDecisionTrace(
  sessionId: string,
  currentTrace: string | null | undefined,
  entry: DecisionTraceEntry
): Promise<string | null> {
  const stored: StoredDecisionTraceEntry = { ts: new Date().toISOString(), ...entry }
  let base = currentTrace ?? '[]'
  for (let attempt = 0; attempt < 3; attempt++) {
    const next = JSON.stringify([...parseTrace(base), stored])
    try {
      const res = await prisma.session.updateMany({
        where: { id: sessionId, decisionTrace: base },
        data: { decisionTrace: next },
      })
      if (res.count === 1) return next
    } catch (err) {
      console.warn(`[decision-trace] append 失败: ${err instanceof Error ? err.message : String(err)}`)
      return null
    }
    // count===0 → 并发冲突：用最新值重读重试（审查整改: 重读在 try/catch 内,兑现"不抛出"契约——
    // P4 T1 后此函数被 transitionPhase 调用,重试读抛错会传导让"phase 已写"误报失败）
    try {
      const fresh = await prisma.session.findUnique({ where: { id: sessionId }, select: { decisionTrace: true } })
      if (!fresh) return null
      base = fresh.decisionTrace ?? '[]'
    } catch (err) {
      console.warn(`[decision-trace] 重试重读失败: ${err instanceof Error ? err.message : String(err)}`)
      return null
    }
  }
  console.warn(`[decision-trace] 乐观锁重试超限，放弃追加 sessionId=${sessionId}`)
  return null
}

/** conformance 违规：kind 区分三类"非法"（A 的核心信号） */
export interface ConformanceViolation {
  index: number
  kind: 'illegal_transition' | 'escalate' | 'escalate_but_legal' | 'malformed'
  from: State
  action: string
  to: State
  detail: string
}

export interface ConformanceResult {
  total: number
  /** 与转移表一致的实际转移数 */
  conforming: number
  /** LLM 提议非法被代码拦下（escalate）数 */
  escalateCount: number
  /** 发生纠正/守卫 redirect 的条目数 */
  correctionCount: number
  violations: ConformanceViolation[]
  /** conforming / total（空数组时 0） */
  ratio: number
}

/** 自有属性查转移表：防 Object.prototype 成员名（toString/constructor 等）命中继承属性绕过校验 */
function lookupTransition(from: State, action: string): State | null {
  const row = TRANSITIONS[from]
  if (row && Object.hasOwn(row, action)) return row[action as Action] as State
  return null
}

/** 一条转移是否合法：旁路 action 须 to===from；其余须在表内且目标一致 */
function isLegalTransition(from: State, action: string, to: State): boolean {
  if (NON_TRANSITIONING.has(action as Action)) return to === from
  const expected = lookupTransition(from, action)
  return expected !== null && expected === to
}

/**
 * AgentFlow checkConformance：对照转移表校验记录的 actualTransition。
 * - escalated=true -> 校验被拦下的转移是否真非法：真非法记 'escalate'（LLM 提议非法，系统按设计工作）；
 *   合法却被拦记 'escalate_but_legal'（applyTransition 误判 = 代码漂移 bug）
 * - applied=true 但表内非法（旁路须 to===from）-> 'illegal_transition'（记录的实际转移表外 = 代码漂移 bug）
 * - applied=false 且 escalated=false -> 'illegal_transition'（producer 写了异常条目，数据漂移）
 * - 条目非对象 / 缺 actualTransition -> 'malformed'（防御，不击穿；P4 消费真实 trace 时健壮）
 * 纯函数，不写库。
 */
export function checkConformance(entries: StoredDecisionTraceEntry[]): ConformanceResult {
  const violations: ConformanceViolation[] = []
  let conforming = 0
  let escalateCount = 0
  let correctionCount = 0

  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]
    if (!e || typeof e !== 'object' || !e.actualTransition || typeof e.actualTransition !== 'object') {
      violations.push({ index: i, kind: 'malformed', from: 'idle', action: '(malformed)', to: 'idle', detail: '条目非对象或缺 actualTransition' })
      continue
    }
    if (e.corrections && e.corrections.length > 0) correctionCount++
    const { from, to, action, applied, escalated } = e.actualTransition

    if (escalated === true) {
      if (isLegalTransition(from, action, to)) {
        // 合法却被拦 = applyTransition 误判（代码漂移 bug），不混入"LLM 提议非法"指标
        violations.push({ index: i, kind: 'escalate_but_legal', from, action, to, detail: `合法转移被代码误拦（漂移）：${from} + ${action} -> ${to}` })
      } else {
        escalateCount++
        violations.push({ index: i, kind: 'escalate', from, action, to, detail: `LLM 提议非法转移被拦下：${from} + ${action}` })
      }
      continue
    }

    if (!applied) {
      violations.push({ index: i, kind: 'illegal_transition', from, action, to, detail: `记录未应用也未 escalate：${from} + ${action}` })
      continue
    }

    if (isLegalTransition(from, action, to)) {
      conforming++
    } else {
      const expected = lookupTransition(from, action)
      violations.push({ index: i, kind: 'illegal_transition', from, action, to, detail: `记录的实际转移表内非法：${from} + ${action} -> ${to}（应为 ${expected ?? '非法'}）` })
    }
  }

  return {
    total: entries.length,
    conforming,
    escalateCount,
    correctionCount,
    violations,
    ratio: entries.length === 0 ? 0 : conforming / entries.length,
  }
}
