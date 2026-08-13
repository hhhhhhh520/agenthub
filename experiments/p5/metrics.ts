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

export async function collectMetrics(
  runId: string, sessionId: string, config: 'on'|'off', taskId: 'A'|'B'|'C', seed: number,
  rounds: number, escalateCount: number, latencyMs: number
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

  const pass = done && requiredEdgesOk && (config === 'off' ? true : onConformanceOk)

  let failureMode: RunMetrics['failureMode'] = 'no-pass'
  if (pass) failureMode = 'pass'
  else if (escalateCount > CONFIG.escalateLimit) failureMode = 'escalate-exhausted'
  else if (rounds > CONFIG.maxRounds) failureMode = 'stuck'

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
