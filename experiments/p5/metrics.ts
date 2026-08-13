import { CONFIG } from './config'
import { TASKS, type P5Task } from './tasks'
import { appendFileSync, readFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

export interface RunMetrics {
  runId: string
  config: 'on' | 'off'
  taskId: 'A' | 'B' | 'C'
  seed: number
  pass: boolean
  failureMode: 'pass' | 'escalate-exhausted' | 'stuck' | 'error' | 'no-pass'
  rounds: number
  escalateCount: number
  correctionCount: number
  illegalProposalCount: number   // OFF: 表外提议数（applied:false&&escalated:false）；ON: 恒 0（ON 用 escalateCount/correctionCount 表达）
  totalTransitions: number
  latencyMs: number
  tracePath: string
}

/** oracle（Spec §4.1）：② 规范序列边存在性匹配 */
function hasRequiredEdges(entries: any[], task: P5Task): boolean {
  const applied = entries.filter(e => e.actualTransition?.applied === true)
  return task.requiredEdges.every(edge =>
    applied.some(a =>
      a.actualTransition.action === edge.action &&
      (edge.from === '*' || a.actualTransition.from === edge.from) &&
      (edge.to === '*' || a.actualTransition.to === edge.to)
    )
  )
}

/**
 * OFF 非法尝试率口径（Spec §4.3/§5.3 + 计划扫描修正②）：
 * OFF 表外提议 = 决策点条目 actualTransition.applied:false && escalated:false（T2 标记），
 * 直接计数即"LLM 表外尝试数"。brief 的"非旁路"口径会把合法 align/execute/done 也计入，已按修正改对。
 */
export function countIllegalProposals(entries: any[], isOff: boolean): number {
  if (!isOff) return 0 // ON 用 escalateCount/correctionCount 表达
  return entries.filter(e =>
    e.decisionPoint === 'handleOrchestratorDecision' &&
    e.actualTransition?.applied === false &&
    e.actualTransition?.escalated === false
  ).length
}

/**
 * 失效模式判定（review I1 修正）：显式支持 error/stuck，不再依赖 rounds > maxRounds 永假表达式。
 * - error：runOne 异常击穿时落 'error' 行（防格子 N 从 5 变 4 破坏配对）
 * - pass：oracle 全过
 * - escalate-exhausted：escalate 超过上限（提前 break）
 * - stuck：循环撞 maxRounds 上界且未 done（rounds >= maxRounds）
 * - 其余（no-progress break / snap null）：no-pass
 * 纯函数，便于单测。
 */
export function resolveFailureMode(
  pass: boolean,
  escalateCount: number,
  rounds: number,
  error?: boolean
): RunMetrics['failureMode'] {
  if (error) return 'error'
  if (pass) return 'pass'
  if (escalateCount > CONFIG.escalateLimit) return 'escalate-exhausted'
  if (rounds >= CONFIG.maxRounds) return 'stuck'
  return 'no-pass'
}

export async function collectMetrics(
  runId: string, sessionId: string, config: 'on'|'off', taskId: 'A'|'B'|'C', seed: number,
  rounds: number, escalateCount: number, latencyMs: number,
  error?: boolean
): Promise<RunMetrics> {
  const { prisma } = await import('@/lib/db')
  const session = await prisma.session.findUnique({ where: { id: sessionId } })
  const task = TASKS.find(t => t.id === taskId)!
  let entries: any[] = []
  try { entries = JSON.parse(session?.decisionTrace ?? '[]') } catch { entries = [] }
  const applied = entries.filter(e => e.actualTransition?.applied === true)
  const totalTransitions = applied.length

  const done = session?.phase === 'done'
  const requiredEdgesOk = hasRequiredEdges(entries, task)
  // ③ 仅 ON：零 illegal_transition / escalate_but_legal（用 checkConformance）
  let onConformanceOk = true
  if (config === 'on' && entries.length > 0) {
    const { checkConformance } = await import('../../src/lib/orchestrator/decision-trace')
    const c = checkConformance(entries as any)
    // 字段核对（brief 假设 c.illegalTransitions/escalateButLegal）：实际 ConformanceResult 只有 violations 数组，
    // 按 kind 分类统计；'escalate' 是 ON 模式预期内的"LLM 非法被拦"，不算违规
    const illegalTransitions = c.violations.filter(v => v.kind === 'illegal_transition').length
    const escalateButLegal = c.violations.filter(v => v.kind === 'escalate_but_legal').length
    onConformanceOk = illegalTransitions === 0 && escalateButLegal === 0
  }

  const pass = error ? false : (done && requiredEdgesOk && (config === 'off' ? true : onConformanceOk))
  const failureMode = resolveFailureMode(pass, escalateCount, rounds, error)

  const correctionCount = entries.reduce((n, e) => n + (e.corrections?.length ?? 0), 0)
  const illegalProposalCount = countIllegalProposals(entries, config === 'off')

  return {
    runId, config, taskId, seed, pass, failureMode, rounds, escalateCount,
    correctionCount, illegalProposalCount, totalTransitions, latencyMs,
    tracePath: `${CONFIG.resultsDir}/trace-${runId}.json`,
  }
}

// —— JSONL 落盘（Spec §7.3：每 run 立即写，崩溃不丢前 N-1）——
const METRICS_FILE = join(CONFIG.resultsDir, 'metrics.jsonl')
export function appendMetrics(m: RunMetrics): void {
  mkdirSync(CONFIG.resultsDir, { recursive: true })
  appendFileSync(METRICS_FILE, JSON.stringify(m) + '\n', 'utf8')
}
export function loadMetrics(): RunMetrics[] {
  try {
    return readFileSync(METRICS_FILE, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
  } catch { return [] }
}
