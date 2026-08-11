/**
 * A方向 P1: 显式状态机 -- 转移表 + 中央 phase 校验函数
 *
 * 代码管"哪些转移合法"，LLM 仍提议 action；命中 Hybrid 纠正规则 -> redirect、
 * 表中合法 -> 执行、真非法 -> escalate（决策点处理，不静默）。
 *
 * 治理节点强制化（align 不可跳序列）、correction 两套合一、idle->execute 确定性闸门为 P2，
 * 本模块职责：转移表校验（applyTransition，非法 fail-closed 不写库）+ Hybrid 纠正（canonicalCorrect）
 * + 集中 phase 写入（transitionPhase，替代散点 set phase）。
 *
 * P4 T1: transitionPhase 补记"代码驱动转移"（redo/0-task 补拆/QA 直发 exec/自动 done 走 transitionPhase
 * 不经决策点，P3 不记 → directly-follows 图在这些边断裂）。默认记；LLM 决策路径（chat-router 的
 * done/align_confirm/align_decompose/align_qa/execute 五个 case，决策点已记同一条转移）显式
 * recordTrace:false 防双记（决策点 append 失败时转 true 兜底补记）。核心不变量：每个实际 phase
 * 写入都入 trace，且不双记。
 *
 * 注意：本模块 import decision-trace（appendDecisionTrace）与其 import 本模块（checkConformance 用
 * TRANSITIONS/NON_TRANSITIONING）构成循环依赖——但两侧都只在函数体内引用（非模块求值期），ESM 安全。
 *
 * 详见 D:\ai全栈挑战赛\A方向-显式状态机-规划.md §5.1（转移表草案）。
 */

import { prisma } from '@/lib/db'
import { appendDecisionTrace, type DecisionTraceEntry } from './decision-trace'

/** 复合状态 = phase × phaseStep（§5.1 状态集） */
export type State = 'idle' | 'align_pm' | 'align_arch' | 'align_qa' | 'exec' | 'done'

/** LLM 可提议的 9 种 action（escalate 为代码触发，不经转移表） */
export type Action = 'self' | 'delegate' | 'discuss' | 'align_confirm' | 'align_decompose' | 'align_qa' | 'execute' | 'verify' | 'done'

/** 不转 phase 的旁路 action：合法于任何状态，nextState = 当前态（side interaction） */
export const NON_TRANSITIONING: ReadonlySet<Action> = new Set(['self', 'delegate', 'discuss', 'verify'])

/**
 * correction 统一重试上限（P2 合一：review.ts 委派路径与 execution.ts batch 路径共用；
 * 上限数字合一，cliSessionId 失效等生命周期语义仍分路径，属既有设计）。
 * 消费点：execution.ts 纠偏点（retryCount < MAX）与 review.ts 委派内层重试。
 * 取宽 max 3（已拍板决定，见规划文档附录第 4 条）。
 */
export const MAX_CORRECTION_RETRIES = 3

/** State -> DB (phase, phaseStep) 映射 */
export const STATE_PHASE: Record<State, { phase: string; phaseStep: string }> = {
  idle: { phase: 'idle', phaseStep: '' },
  align_pm: { phase: 'alignment', phaseStep: 'pm_confirm' },
  align_arch: { phase: 'alignment', phaseStep: 'architect_plan' },
  align_qa: { phase: 'alignment', phaseStep: 'agent_qa' },
  exec: { phase: 'execution', phaseStep: '' },
  done: { phase: 'done', phaseStep: '' },
}

/** 转移表（仅转 phase 的 action）：TRANSITIONS[from][action] = to。
 *  P3 checkConformance 消费：校验实际转移是否落表内（同时服务 A"是否走非法转移"与 B 流程挖掘）。 */
export const TRANSITIONS: Record<State, Partial<Record<Action, State>>> = {
  idle: {
    align_confirm: 'align_pm',
    align_decompose: 'align_arch',
    execute: 'exec',
    done: 'done',
  },
  align_pm: {
    align_decompose: 'align_arch',
    align_confirm: 'align_pm', // 容错：重复确认
  },
  align_arch: {
    align_qa: 'align_qa',
    execute: 'exec',
    align_decompose: 'align_arch', // 容错：重复拆解
  },
  align_qa: {
    execute: 'exec',
    align_qa: 'align_qa', // 容错：再问一轮
    align_decompose: 'align_arch', // back-edge：任务为空时补拆（transitionToExecution fallback）
  },
  exec: {
    done: 'done',
    execute: 'exec', // 自环：已执行中再次提议 execute（no-op）
    align_decompose: 'align_arch', // back-edge：任务为空时补拆（transitionToExecution fallback）
  },
  done: {
    align_confirm: 'align_pm', // 新对话轮
    align_decompose: 'align_arch',
    execute: 'exec',
    done: 'done', // 容错
  },
}

/**
 * DB 字段 -> State（兼容老会话：未知组合 -> idle 兜底）。
 * 在途会话 phase 值组合有限，idle 兜底安全（下次 action 走合法转移）。
 */
export function stateFromSession(phase: string, phaseStep: string): State {
  if (phase === 'idle') return 'idle'
  if (phase === 'execution') return 'exec'
  if (phase === 'done') return 'done'
  if (phase === 'alignment') {
    if (phaseStep === 'pm_confirm') return 'align_pm'
    if (phaseStep === 'architect_plan') return 'align_arch'
    if (phaseStep === 'agent_qa') return 'align_qa'
    return 'idle' // alignment + 未知 step -> idle 兜底
  }
  return 'idle' // 未知 phase -> idle
}

/** 历史条目（规则3 判定 Q&A 已答用） */
export type HistoryEntry = { role: string; agentId?: string | null; rawContent: string }

/** 纯校验：不写库。合法 -> {ok, nextState}；非法 -> {ok:false, reason} */
export function applyTransition(state: State, action: string): { ok: true; nextState: State } | { ok: false; reason: string } {
  if (NON_TRANSITIONING.has(action as Action)) {
    return { ok: true, nextState: state }
  }
  // 自有属性查找：`TRANSITIONS[state]?.[action]` 的属性链查找会被 Object.prototype 成员名
  // （toString/constructor/valueOf 等）命中继承属性而绕过 fail-closed（P3 攻击者审查抓出，
  // 静默吞消息 + 污染 trace）。Object.hasOwn 只认表内自有 action。
  const row = TRANSITIONS[state]
  if (row && Object.hasOwn(row, action)) {
    return { ok: true, nextState: row[action as Action] as State }
  }
  return { ok: false, reason: `非法转移：${state} + ${action}` }
}

/**
 * idle→execute 确定性闸门（P2，已拍板决定 3）：跳步不是"LLM 说简单就简单"，
 * 是代码看任务数据决定——与 ISSUE-008（LLM 自证"验证过了"）同构，不可自证。
 * - 无任务：连"简单"都无从证明 → 拒绝跳步（须先对齐拆解）
 * - 有任务且全非代码（isCodeTask：declaredFiles 与 description 均无代码后缀）→ 允许简单任务跳步
 * 非 idle 态的 execute 不走此闸门（由决策点 0-task 守卫兜底）。
 */
export function idleExecuteGate(taskCount: number, hasCodeTask: boolean): boolean {
  if (taskCount === 0) return false
  return !hasCodeTask
}

/**
 * Hybrid 规范化纠正（3 条，决策点对 LLM 提议用）。命中 -> {redirect}；不命中 -> null。
 *
 * 1. align_* + done -> 推进到下一对齐步（align_pm->align_decompose / align_arch|align_qa->execute）
 * 2. exec + align_* -> execute（继续执行，别回退对齐；代码 fallback 的 align_decompose 直发不经此处）
 * 3. align_qa（提议）且 history 显示已答 -> execute（Q&A 完成推进）
 *
 * 这 3 条不是"静默忽略"（有可见 reason），符合"绝不静默"；真非法（表中不存在）才 escalate。
 * P2 拿 trace 数据后可收紧为纯 escalate。
 */
export function canonicalCorrect(
  state: State,
  action: string,
  history?: HistoryEntry[]
): { redirect: Action } | null {
  // 规则1：对齐中提议 done -> 推进
  if (action === 'done' && (state === 'align_pm' || state === 'align_arch' || state === 'align_qa')) {
    if (state === 'align_pm') return { redirect: 'align_decompose' }
    return { redirect: 'execute' } // align_arch / align_qa -> 执行
  }
  // 规则2：执行中提议 align_* -> 继续执行
  if (state === 'exec' && action.startsWith('align_')) {
    return { redirect: 'execute' }
  }
  // 规则3：对齐中提议 align_qa 但 Q&A 已答 -> 执行（限定对齐态，避免跨态误纠正成假 escalate）
  if (action === 'align_qa' && (state === 'align_qa' || state === 'align_arch') && history && qaAlreadyAnswered(history)) {
    return { redirect: 'execute' }
  }
  return null
}

/** 规则3 判定：是否有 Agent 提问且用户在最后一条提问后回答过 */
function qaAlreadyAnswered(history: HistoryEntry[]): boolean {
  const agentQuestions = history.filter(
    m => m.role === 'agent' && m.agentId && m.agentId !== '产品经理' && m.agentId !== '架构师'
  )
  if (agentQuestions.length === 0) return false
  const lastAgentQuestionIdx = history.reduce((last, m, i) =>
    (m.role === 'agent' && m.agentId && m.agentId !== '产品经理' && m.agentId !== '架构师') ? i : last, -1)
  const userAnswersAfter = history.slice(lastAgentQuestionIdx + 1).filter(m => m.role === 'user')
  return userAnswersAfter.length > 0
}

/**
 * 中央 phase 写入：读当前 state，applyTransition 校验（不含纠正--纠正在决策点），
 * 合法则写 phase+phaseStep。handler 调用（action 已经决策点校验或代码直发）。
 *
 * - 旁路 action（self/delegate/discuss/verify）-> 不写库，直接 ok（这些 handler 不转 phase）
 * - 合法 transitioning action -> 写 STATE_PHASE[nextState]
 * - 非法（决策点快照与 DB 不一致的并发窗口，或代码直发边界）-> **fail-closed**：不写库，
 *   防把 phase 写到转移表之外的值（回退/跳步），记 warn 可见。phase 保持旧值，下次决策自愈。
 * - DB 异常（findUnique/update 抛错）-> try/catch 记 warn，返回 ok:false 不击穿调用方收尾。
 *
 * P4 T1: 写库成功后默认补记一条 trace（decisionPoint:'transitionPhase'）——代码驱动转移
 * （redo/0-task 补拆/QA 直发 exec/自动 done）不经决策点，只有这里能兜住。LLM 决策路径
 * （chat-router/handler）已由决策点记录同一条转移，传 { recordTrace: false } 防双记。
 * 补记失败（appendDecisionTrace 返回 null）不击穿主路径（trace 是 best-effort 审计）。
 */
export async function transitionPhase(
  sessionId: string,
  action: string,
  opts?: { recordTrace?: boolean }
): Promise<{ ok: boolean; nextState?: State; reason?: string }> {
  if (NON_TRANSITIONING.has(action as Action)) {
    return { ok: true }
  }
  try {
    const session = await prisma.session.findUnique({ where: { id: sessionId }, select: { phase: true, phaseStep: true, decisionTrace: true } })
    if (!session) return { ok: false, reason: 'session 不存在' }
    const state = stateFromSession(session.phase, session.phaseStep)
    const result = applyTransition(state, action)
    if (result.ok) {
      await prisma.session.update({ where: { id: sessionId }, data: STATE_PHASE[result.nextState] })
      if (opts?.recordTrace !== false) {
        const entry: DecisionTraceEntry = {
          decisionPoint: 'transitionPhase',
          // 写前状态 = 决策时 input state（与决策点条目同构）
          inputState: { phase: session.phase, phaseStep: session.phaseStep, state },
          llmProposal: { action, reason: '代码驱动转移（不经决策点）' },
          corrections: [],
          validation: { passed: true, validator: 'transitionPhase' },
          actualTransition: { from: state, to: result.nextState, action, applied: true, escalated: false },
        }
        // 审查整改(生命周期⚠️Q3): append 整体再包一层 try/catch 双保险——即使 append 内部抛错
        // （如重试路径读库异常）也不把"phase 已写成功"误报为失败(redo 会据此 500)
        try {
          await appendDecisionTrace(sessionId, session.decisionTrace, entry)
        } catch (err) {
          console.warn(`[state-machine] 补记 trace 失败: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
      return { ok: true, nextState: result.nextState }
    }
    console.warn(`[state-machine] transitionPhase 拒绝: ${result.reason}（不写库，避免 phase 越界）`)
    return { ok: false, reason: result.reason }
  } catch (err) {
    console.warn(`[state-machine] transitionPhase 异常: ${err instanceof Error ? err.message : String(err)}`)
    return { ok: false, reason: 'transitionPhase 数据库操作失败' }
  }
}
