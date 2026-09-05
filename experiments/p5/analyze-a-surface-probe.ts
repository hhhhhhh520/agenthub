import { readFileSync, copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, resolve, basename } from 'node:path'
import { createClient, type Client } from '@libsql/client'

export type State = 'idle' | 'align_pm' | 'align_arch' | 'align_qa' | 'exec' | 'done'
export type Action = 'self' | 'delegate' | 'discuss' | 'align_confirm' | 'align_decompose' | 'align_qa' | 'execute' | 'verify' | 'done'
export const MAX_TRACE = 500
export const NON_TRANSITIONING: ReadonlySet<Action> = new Set(['self', 'delegate', 'discuss', 'verify'])
// 内联副本：与 src/lib/orchestrator/state-machine.ts TRANSITIONS 逐字一致（漂移测试守护）
export const TRANSITIONS: Record<State, Partial<Record<Action, State>>> = {
  idle: { align_confirm: 'align_pm', align_decompose: 'align_arch', execute: 'exec', done: 'done' },
  align_pm: { align_decompose: 'align_arch', align_confirm: 'align_pm' },
  align_arch: { align_qa: 'align_qa', execute: 'exec', align_decompose: 'align_arch' },
  align_qa: { execute: 'exec', align_qa: 'align_qa', align_decompose: 'align_arch' },
  exec: { done: 'done', execute: 'exec', align_decompose: 'align_arch' },
  done: { align_confirm: 'align_pm', align_decompose: 'align_arch', execute: 'exec', done: 'done' },
}
export function seqgatePredicate(state: string, action: string, taskCount: number): boolean {
  return state === 'idle' && action === 'done' && taskCount === 0
}

export interface MetricsRow { runId: string; config: string; taskId: 'A'|'B'|'C'; seed: number; pass: boolean; failureMode: string; failKind?: string; rounds: number; escalateCount: number; correctionCount: number; illegalProposalCount: number; totalTransitions: number; latencyMs: number }
export const PROBE_BATCH = {
  arms: ['off+verify', 'on+verify', 'on-seqgate+verify'],
  weakFrozenSha: 'af6e590a2878e80585dafd726fc7a857af589c48a4047814ed625f6fed620ba6',
  excluded: ['metrics.p9b-aborted-21.bak.jsonl', 'metrics.p10-matrix-attempt1-37rows.bak.jsonl', 'metrics.auto-sentinel-20260902-110740.jsonl', 'metrics.auto-sentinel-20260902-202552.jsonl'],
}
export function loadMetricsRows(file: string): { rows: MetricsRow[]; badLines: number } {
  const rows: MetricsRow[] = []; let badLines = 0
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const t = line.trim(); if (!t) continue
    try { const r = JSON.parse(t); if (typeof r !== 'object' || r === null || Array.isArray(r)) { badLines++; continue }; rows.push(r as MetricsRow) } catch { badLines++ }
  }
  return { rows, badLines }
}
export function assertWeakFrozenSha(file: string, expectSha: string): void {
  const sha = createHash('sha256').update(readFileSync(file)).digest('hex')
  if (sha !== expectSha) throw new Error(`[p11-probe] 弱批冻结副本 sha256 不符（锚点漂移）: ${sha} !== ${expectSha}`)
}
export function selectProbeCells(rows: MetricsRow[]): { A: MetricsRow[]; strongCOff: MetricsRow[] } {
  const arms = PROBE_BATCH.arms
  return {
    A: rows.filter(r => r.taskId === 'A' && arms.includes(r.config)),
    strongCOff: rows.filter(r => r.taskId === 'C' && r.config === 'off+verify'),
  }
}

/** F6：wal 非空=应用可能在写 → 拒；只拷主文件（wal 为空无未 checkpoint 提交） */
export function prepareSnapshot(dbPath: string, outDir: string): { copyPath: string; sha256: string } {
  const src = resolve(dbPath)
  if (!existsSync(src)) throw new Error(`p5.db 不存在: ${src}`)
  const wal = src + '-wal'
  if (existsSync(wal) && statSync(wal).size > 0) throw new Error(`p5.db-wal 非空（可能有实验进程在写）——拒拷，先停实验: ${wal}`)
  mkdirSync(outDir, { recursive: true })
  const copyPath = join(outDir, basename(src))          // 只拷主文件，绝不拷 -wal/-shm
  copyFileSync(src, copyPath)
  return { copyPath, sha256: createHash('sha256').update(readFileSync(copyPath)).digest('hex') }
}

/** F1 实证配方：独立连接 + query_only + write-self-test（UPDATE 必须被拦；拦不住=假只读，中止） */
export async function openGuardedReadonly(copyPath: string): Promise<Client> {
  const client = createClient({ url: 'file:' + copyPath })
  await client.execute('PRAGMA query_only=ON;')
  let blocked = false
  try { await client.execute('UPDATE Session SET phase = phase WHERE 1=0') } catch (e) { blocked = /readonly|query only/i.test(String((e as Error)?.message)) }
  if (!blocked) { client.close(); throw new Error('[p11-probe] write-self-test 未拦写——中止') }
  return client
}

/** 路径白名单：只认 snapshot-xxx/p5.db 结尾，禁原地开 experiments/p5/p5.db */
export function assertSnapshotPath(p: string): void {
  if (!/snapshot-[^/\\]+[/\\]p5\.db$/.test(p.replace(/\\/g, '/'))) throw new Error(`[p11-probe] 非法库路径（须 snapshot-*/p5.db，禁原地开库）: ${p}`)
}

export interface SessionRow { id: string; title: string; projectDir: string; phase: string; createdAt: string; decisionTrace: string | null }
export interface TaskRow { id: string; sessionId: string; createdAt: string }

/** 只读取 journal_mode 值，永不发 PRAGMA journal_mode=<设置> */
export async function readAll(client: Client): Promise<{ journalMode: string; sessions: SessionRow[]; tasks: TaskRow[] }> {
  const jm = await client.execute('PRAGMA journal_mode;')
  const s = await client.execute({ sql: 'SELECT id, title, projectDir, phase, createdAt, decisionTrace FROM Session', args: [] })
  const t = await client.execute({ sql: 'SELECT id, sessionId, createdAt FROM Task', args: [] })
  return { journalMode: String((jm.rows[0] as any)?.journal_mode ?? ''), sessions: s.rows as any, tasks: t.rows as any }
}

export interface JoinedRun { row: MetricsRow; session: SessionRow }
export function joinRuns(rows: MetricsRow[], sessions: SessionRow[], expectCounts: Record<string, number>): JoinedRun[] {
  const joined: JoinedRun[] = []
  const usedSession = new Set<string>(); const seenKey = new Set<string>()
  for (const r of rows) {
    const hit = sessions.find(s => !usedSession.has(s.id) && basename(s.projectDir).startsWith(r.runId))
    if (!hit) throw new Error(`[p11-probe fail-closed] runId 无唯一会话命中: ${r.runId}`)
    usedSession.add(hit.id)
    const key = `${r.config}|${r.taskId}|${r.seed}`
    if (seenKey.has(key)) throw new Error(`[p11-probe fail-closed] 重复 (config,task,seed): ${key}`)
    seenKey.add(key)
    joined.push({ row: r, session: hit })
  }
  for (const [cell, exp] of Object.entries(expectCounts)) {
    const n = joined.filter(j => j.row.taskId === cell).length
    if (n !== exp) throw new Error(`[p11-probe fail-closed] ${cell} 会话计数 ${n} !== 期望 ${exp}`)
  }
  return joined
}

export interface TraceEntry { decisionPoint?: string; inputState?: { state?: string }; llmProposal?: { action?: string }; corrections?: Array<{ from?: string; to?: string }>; actualTransition?: { action?: string; from?: string; to?: string; applied?: boolean; escalated?: boolean }; ts?: string }
export function parseEntries(raw: string | null): TraceEntry[] | null {
  if (raw == null || raw === '' || raw === '[]') return []
  let v: unknown; try { v = JSON.parse(raw) } catch { return null }
  return Array.isArray(v) ? (v as TraceEntry[]) : null
}
export function terminalDecision(entries: TraceEntry[]): { state: string; action: string } | null {
  const dec = entries.filter(e => e?.decisionPoint === 'handleOrchestratorDecision')
  if (!dec.length) return null
  const last = dec[dec.length - 1]
  const state = last.inputState?.state ?? ''; const action = last.llmProposal?.action ?? ''
  return { state, action }
}
/**
 * 【上游已知偏差·Task 5 审查传递约束 3】非法 createdAt（Date.parse→NaN）被静默排除（NaN<=ts 恒 false）
 * → taskCount 少计 → 虚增①命中（污染偏向 gate 侧）。测试已钉住该行为。
 * 【传递约束 2】本函数不按 sessionId 过滤（设计如此）——调用方必须先 tasks.filter(t => t.sessionId === session.id) 再传入。
 */
export function taskCountAtDecision(tasks: TaskRow[], ts: number): number {
  return tasks.filter(t => Date.parse(String(t.createdAt)) <= ts).length
}
export function appliedEdgesOf(entries: TraceEntry[]): Array<{ action: string; from: string; to: string }> {
  const out: Array<{ action: string; from: string; to: string }> = []
  for (const e of entries) {
    const at = e.actualTransition
    if (at?.applied === true && at.action && !NON_TRANSITIONING.has(at.action as Action)) out.push({ action: at.action, from: at.from ?? '', to: at.to ?? '' })
  }
  return out
}

/**
 * Task 7：缺失规范边（保持 required 原顺序）。等价性黄金测试见 analyze-a-surface-probe.test.ts（独立参考实现对拍）。
 * 口径（brief 定版）：a.action===req.action && a.to===req.to && (req.from==='*' || a.from===req.from)。
 * 与 metrics.ts:27 hasRequiredEdges 的差异：真 oracle 另支持 to==='*' 通配；当前 TASKS 数据无 to:'*' 边，行为等价——
 * 若 tasks.ts 未来引入 to:'*' 必须先改此处（探针禁 import metrics.ts，见设计约束 F4）。
 */
export function missingRequired(applied: Array<{ action: string; from: string; to: string }>, required: Array<{ action: string; from: string; to: string }>) {
  return required.filter(req => !applied.some(a => a.action === req.action && a.to === req.to && (req.from === '*' || a.from === req.from)))
}

export type Bucket = '⓪' | '①' | '②' | '③'
export interface ClassifyInput {
  entries: TraceEntry[]
  appliedEdges: Array<{ action: string; from: string; to: string }>
  failureMode: string
  failKind?: string
  terminal: { state: string; action: string } | null
  /**
   * 【传递约束 2·Task 5 审查】必须按会话先过滤：调用方（Task 12）须先
   * `tasks.filter(t => t.sessionId === session.id)`，再喂 `taskCountAtDecision(filtered, ts)` 的结果传入本字段。
   * taskCountAtDecision 本身不按 sessionId 过滤（Task 5 设计如此）——混入其他会话的任务会虚增计数、压低①命中。
   * 另：taskCountAtDecision 对非法 createdAt（Date.parse→NaN）静默排除 → taskCount 少计 → 虚增①命中
   * （污染偏向 gate 侧，上游已知偏差方向，见其 JSDoc）。
   */
  taskCountAtTerminal: number
}
export function classifyBucket(x: ClassifyInput): Bucket {
  // 传递约束 1：空串签名拒收——terminalDecision 对缺失字段回退 ''，空串不得滑入任何正桶（尤其防「非 idle→②」否定式谓词误吸空串）
  if (x.terminal && (x.terminal.state === '' || x.terminal.action === '')) throw new Error(`[p11-probe fail-closed] terminal 签名含空串（terminalDecision 缺字段回退）——不可分类，拒收: ${JSON.stringify(x.terminal)}`)
  // ⓪ 未推进（最先）
  if (x.entries.length === 0 || x.appliedEdges.length === 0) return '⓪'
  // ① 老靶（限末决策；两支）
  const t = x.terminal
  const lastDec = [...x.entries].reverse().find(e => e.decisionPoint === 'handleOrchestratorDecision')
  const fired = (lastDec?.corrections ?? []).some(c => c.from === 'done' && c.to === 'align_decompose') && lastDec?.inputState?.state === 'idle'
  const predA = !!t && seqgatePredicate(t.state, t.action, x.taskCountAtTerminal)
  if (predA || fired) return '①'
  // ③ 内容/流程不可救（∧非⓪ 已过）
  const isDefect = ['error', 'stuck', 'escalate-exhausted'].includes(x.failureMode) || x.failKind === 'defect'
  if (isDefect) return '③'
  // ② 构造性残差（兜底）
  return '②'
}

/** Task 9：强带 C-off 正对照/标定（只钉强带，弱带 C-off 不参与——Task 12 选样纪律）。①复现率 <4/5 或 ⓪占比 ≥0.4 任一触发即降级（⓪ 优先，正对照退化软证据）。 */
export interface Calibration { reproRate: number; zeroCount: number; degraded: boolean; reason: string }
export function calibrate(strongCOffBuckets: Bucket[]): Calibration {
  const n = strongCOffBuckets.length || 1
  const ones = strongCOffBuckets.filter(b => b === '①').length
  const zeros = strongCOffBuckets.filter(b => b === '⓪').length
  const reproRate = ones / n
  let degraded = false; let reason = ''
  if (zeros / n >= 0.4) { degraded = true; reason = `强带 C-off ${zeros}/${n} 为⓪（未推进），正对照退化软证据` }
  else if (reproRate < 4 / 5) { degraded = true; reason = `强带 C-off ①复现率 ${ones}/${n} < 4/5，尺子未干净校准，A-null 证据强度降级` }
  return { reproRate, zeroCount: zeros, degraded, reason }
}

/** 从 state 出发、沿 TRANSITIONS 是否存在可达续作能走通 edge（edge.from==='*' 则 from-agnostic）。判定转移表可达性，非会话序列回放。 */
export function edgeCoverableFromT(state: State, edge: { action: string; from: string; to: string }, T: Record<State, Partial<Record<Action, State>>>): boolean {
  const seen = new Set<State>(); const queue: State[] = [state]
  while (queue.length) {
    const s = queue.shift()!
    if (seen.has(s)) continue; seen.add(s)
    const row = T[s] ?? {}
    for (const [action, to] of Object.entries(row)) {
      if (action === edge.action && to === edge.to && (edge.from === '*' || s === edge.from)) return true
      queue.push(to as State)
    }
  }
  return false
}
export function edgeCoverableFrom(state: string, edge: { action: string; from: string; to: string }): boolean {
  return edgeCoverableFromT(state as State, edge, TRANSITIONS)
}
/** (i)：各缺失必需边均不可被转移表从末态续作覆盖 → 结构性缺口 → true */
export function machineCheckIT(state: State, missingEdges: Array<{ action: string; from: string; to: string }>, T: Record<State, Partial<Record<Action, State>>>): boolean {
  return missingEdges.every(e => !edgeCoverableFromT(state, e, T))
}
export function machineCheckI(state: string, missingEdges: Array<{ action: string; from: string; to: string }>): boolean {
  return machineCheckIT(state as State, missingEdges, TRANSITIONS)
}
/** confirm-state 带表参变体（镜像 machineCheckIT/edgeCoverableFromT 成对模式）：(i) 结构可复现 ∧ 同签名≥2 → confirmed；否则 candidate。绿门另需跨带 presence（§2.4）。 */
export function confirmStateT(signature: string, missingEdges: Array<{ action: string; from: string; to: string }>, count: number, terminalState: string, T: Record<State, Partial<Record<Action, State>>>): 'confirmed' | 'candidate' {
  const passI = machineCheckIT(terminalState as State, missingEdges, T)
  return passI && count >= 2 ? 'confirmed' : 'candidate'
}
/** confirm-state：(i) 结构可复现 ∧ 同签名≥2 → confirmed；否则 candidate。绿门另需跨带 presence（§2.4）。 */
export function confirmState(signature: string, missingEdges: Array<{ action: string; from: string; to: string }>, count: number, terminalState: string): 'confirmed' | 'candidate' {
  return confirmStateT(signature, missingEdges, count, terminalState, TRANSITIONS)
}
