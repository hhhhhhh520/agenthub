import { readFileSync, copyFileSync, existsSync, mkdirSync, statSync, writeFileSync, unlinkSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, resolve, basename } from 'node:path'
import { createClient, type Client } from '@libsql/client'
import { TASKS } from './tasks'

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
    // 【T4 携带观察项闭环】多于一个未占用候选命中同一 runId 即抛——find() 静默取首个 = 潜在错配（签名张冠李戴）
    const cands = sessions.filter(s => !usedSession.has(s.id) && basename(s.projectDir).startsWith(r.runId))
    if (cands.length > 1) throw new Error(`[p11-probe fail-closed] runId 多于一个未占用会话命中（前缀歧义，防静默错配）: ${r.runId}`)
    if (!cands.length) throw new Error(`[p11-probe fail-closed] runId 无唯一会话命中: ${r.runId}`)
    const hit = cands[0]
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

// ── Task 10：口径锚点哨兵——探针重算的四桶分布对 §0 权威数的对账闸门 ──
// 硬约束：③≤4（③⊆defect/error 行）/ skip==9 / defect==4（§0 权威锚点，重算漂移即红）/ ①+② ≤ skip+defect 上限；
// ⓪+①+②+③==13 是构造恒等、恒真，仅作实现 bug 的 sanity，不得当口径正确性判据；
// 近似带宽（超限仅警告不阻断）：③∈[2,4]、①+②∈[9,11]。ok===false 时调用方（Task 12）不得落任何靶点结论。
export interface BucketTally { zero: number; one: number; two: number; three: number }
export interface SentinelResult { ok: boolean; violations: string[]; warnings?: string[] }
/** §0 权威数（口径锚点）：13 行失败 = 9 skip + 4 defect；③ 上界 4 = defect 行数。 */
export const SENTINEL_AUTHORITY = { skip: 9, defect: 4, threeMax: 4, total: 13 } as const
export function assertSentinel(t: BucketTally, metricsTruth: { skip: number; defect: number }): SentinelResult {
  const v: string[] = []
  const sum = t.zero + t.one + t.two + t.three
  if (sum !== SENTINEL_AUTHORITY.total) v.push(`⓪+①+②+③=${sum} ≠ 13（构造恒等破坏=实现 bug sanity，非口径判据）`)
  if (t.three > SENTINEL_AUTHORITY.threeMax) v.push(`③=${t.three} > 4（③⊆defect/error 行）`)
  const onePlusTwo = t.one + t.two
  if (onePlusTwo > metricsTruth.skip + metricsTruth.defect) v.push(`①+②=${onePlusTwo} 超出 skip+defect 上限`)
  if (metricsTruth.skip !== SENTINEL_AUTHORITY.skip) v.push(`skip=${metricsTruth.skip} ≠ §0 权威 9（口径锚点漂移）`)
  if (metricsTruth.defect !== SENTINEL_AUTHORITY.defect) v.push(`defect=${metricsTruth.defect} ≠ §0 权威 4（口径锚点漂移）`)
  // 带宽（近似，超限仅警告不阻断，仅记录供报告）
  const warnings: string[] = []
  if (t.three < 2) warnings.push(`③=${t.three} 低于带宽[2,4]（①/③切分依赖末决策签名，可接受）`)
  if (onePlusTwo < 9 || onePlusTwo > 11) warnings.push(`①+②=${onePlusTwo} 出带宽[9,11]`)
  const out: SentinelResult = { ok: v.length === 0, violations: v }
  if (warnings.length) out.warnings = warnings
  return out
}

// ── Task 11：四桶失败地图（§2.5）+ 红/绿裁决（§2.4）──
// 裁决语义（§2.4 verbatim）：绿（唯一升级出口）= ∃ confirm-state=confirmed 的②签名，两 band 各≥1 presence
// （presence≠配对）；红（默认）=否则。confirmed 仅单带 → 红不翻绿（跨带 presence 是硬条件）。
// 探针只判「有没有理论未预见的 confirmed 群」；「能否验出」全交 P11b。
export interface SigRow { band: string; arm: string; task: string; bucket: Bucket; signature: string; confirmState: 'confirmed' | 'candidate'; n: number; pct: number }
export function verdict(rows: SigRow[]): 'green' | 'red' {
  const conf = rows.filter(r => r.bucket === '②' && r.confirmState === 'confirmed')
  const bands = new Set(conf.map(r => r.band))
  return bands.size >= 2 ? 'green' : 'red'
}
/** §2.5：同一签名跨带分列（各自带行）——合并总数呈分布、翻绿用各 band presence（verdict 按 band 集合大小判定）。
 *  pct = n ÷ 该 (task,band) 非⓪分母（分母计算是 Task 12 编排职责，渲染直接用传入 pct）。 */
export function renderMap(rows: SigRow[], cal: Calibration, sent: { ok: boolean; violations: string[] }): string {
  const L: string[] = []
  L.push('# P11 A 方向：四桶失败地图（作用面有界预测证伪）', '')
  L.push('> 本文件在 results/（gitignored）。可提交产物只允许聚合数字 + 裁决号（F8）。', '')
  L.push('| band | arm | task | bucket | signature | confirm-state | n | % |')
  L.push('|---|---|---|---|---|---|---|---|')
  const sorted = [...rows].sort((a, b) => (a.band + a.arm + a.bucket).localeCompare(b.band + b.arm + b.bucket) || b.n - a.n)
  for (const r of sorted) L.push(`| ${r.band} | ${r.arm} | ${r.task} | ${r.bucket} | ${r.signature} | ${r.confirmState} | ${r.n} | ${r.pct.toFixed(1)}% |`)
  L.push('', `**裁决：${verdict(rows) === 'green' ? '绿（有界预测被证伪 → 立项 P11b）' : '红（有界预测证实 → 作用面边界落档；地图为描述性交付）'}**`)
  if (cal.degraded) L.push(`> ⚠️ 标定降级：${cal.reason}`)
  if (!sent.ok) L.push(`> ❌ 哨兵违例：${sent.violations.join('；')}`)
  L.push('', '> 图例：单带 presence / 亚阈值 / 仅 candidate 的②签名 → 「不足以翻色，仅呈分布」（§2.4）。')
  return L.join('\n')
}

// ── Task 12：main() 端到端编排 + Step-0 fail-closed + 报告落盘 ──
const HERE = import.meta.dirname
const WEAK_FILE = join(HERE, 'results', 'metrics.p10-weak-frozen-20260904.bak.jsonl')
const STRONG_FILE = join(HERE, 'results', 'metrics.p9b-strong-20260829.bak.jsonl')
export const REPORT_PATH = join(HERE, 'results', 'report-a-surface-probe.md')
const STATE_SET: ReadonlySet<string> = new Set(Object.keys(TRANSITIONS))

/** §2.5-1 签名表示法：`<末态>/<提议>/<缺失必需边集(排序)>` 三段确定串（缺失边集按串排序，同签名⇒同缺失边集）。 */
export function signatureOf(terminal: { state: string; action: string } | null, missingEdges: Array<{ action: string; from: string; to: string }>): string {
  const head = terminal ? `${terminal.state}/${terminal.action}` : 'null/-'
  return `${head}/${missingEdges.map(e => `${e.action}@${e.from}->${e.to}`).sort().join(',')}`
}

/** 【T10 携带①】metricsTruth 必须来自 metrics 真实重算（数 skip/defect 行），禁硬编码常量；failKind 缺口（非 skip/defect 的 ¬pass 行）= 口径漂移，fail-closed 抛错。 */
export function metricsTruthFromRows(rows: MetricsRow[]): { skip: number; defect: number; total: number } {
  let skip = 0; let defect = 0
  for (const r of rows) {
    if (r.failKind === 'skipped-spec-edge') skip++
    else if (r.failKind === 'defect') defect++
    else throw new Error(`[p11-probe fail-closed] ¬pass 行 failKind 缺口（skip/defect 口径漂移）: runId=${r.runId} failureMode=${r.failureMode} failKind=${String(r.failKind)}`)
  }
  return { skip, defect, total: rows.length }
}

/** 【T9 携带】标定选样管道守卫：弱带桶混入即拒（只钉强带 C-off；防御落点在 Task 12 选样管道，calibrate 纯 Bucket[] 签名不变）。 */
export function calibrationBuckets(rows: Array<{ band: string; bucket: Bucket }>): Bucket[] {
  for (const r of rows) if (r.band !== 'strong') throw new Error(`[p11-probe fail-closed] 标定基线混入非强带桶（band=${r.band}）——只钉强带 C-off`)
  return rows.map(r => r.bucket)
}

/** 【T11 携带 B】pct 分母对账（构造恒等断言）：每 (task,band) Σn == 该格非⓪分母 ∧ 每行 pct == n/分母×100。破坏即抛（fail-closed）。 */
export function assertPctLedger(rows: SigRow[], denominators: Record<string, number>): void {
  const sum: Record<string, number> = {}
  for (const r of rows) {
    const key = `${r.task}|${r.band}`
    sum[key] = (sum[key] ?? 0) + r.n
    const den = denominators[key]
    if (den == null || den <= 0) throw new Error(`[p11-probe fail-closed] pct 分母缺失/非正: ${key}`)
    if (Math.abs(r.pct - (r.n / den) * 100) > 1e-9) throw new Error(`[p11-probe fail-closed] pct 对账破坏: ${key} ${r.signature} pct=${r.pct} ≠ n=${r.n}/分母=${den}×100`)
  }
  for (const [key, den] of Object.entries(denominators)) {
    if ((sum[key] ?? 0) !== den) throw new Error(`[p11-probe fail-closed] Σn(${key})=${sum[key] ?? 0} ≠ 非⓪分母 ${den}`)
  }
}

export interface SessionClassification {
  /** null = 损坏/拒收（classifyBucket 抛错），独立计数列不入桶（哨兵合计校验将自然阻断结论） */
  bucket: Bucket | null
  signature: string
  terminalState: string
  missingEdges: Array<{ action: string; from: string; to: string }>
  taskCountAtTerminal: number
  /** 解析失败/必需字段缺失/state∉State/决策 ts 非法 → 计数后 exit 1（§2.2-4/F8） */
  schemaBad: string | null
  /** classifyBucket 拒收（空串签名等）→ 损坏/拒收列，不炸整批（T6 携带降级策略） */
  corruptReason: string | null
}
export function probeSession(j: JoinedRun, sessionTasks: TaskRow[], requiredEdges: Array<{ action: string; from: string; to: string }>): SessionClassification {
  const entries = parseEntries(j.session.decisionTrace)
  if (entries === null) return { bucket: null, signature: 'null/-/', terminalState: 'null', missingEdges: [], taskCountAtTerminal: 0, schemaBad: `decisionTrace 解析失败（非数组 JSON）: runId=${j.row.runId}`, corruptReason: null }
  // §2.2-4 必需字段存在性：decisionPoint ∧ inputState.state（字符串∧∈State）∧ llmProposal.action（键在）∧ actualTransition。
  // 注意：action 键在即可（'' 由 classifyBucket 空串守卫拒收→损坏列，T6 契约）；state 空串∉State 在此拦（exit-1 语义优先）。
  for (const e of entries) {
    if (!(e && e.decisionPoint && e.inputState && typeof e.inputState.state === 'string' && STATE_SET.has(e.inputState.state) && e.llmProposal && e.llmProposal.action !== undefined && e.actualTransition)) {
      return { bucket: null, signature: 'null/-/', terminalState: 'null', missingEdges: [], taskCountAtTerminal: 0, schemaBad: `条目必需字段缺失/state∉State: runId=${j.row.runId} entry=${JSON.stringify(e).slice(0, 160)}`, corruptReason: null }
    }
  }
  const dec = entries.filter(e => e.decisionPoint === 'handleOrchestratorDecision')
  const last = dec.length ? dec[dec.length - 1] : null
  if (last) {
    const ts = Date.parse(String(last.ts ?? ''))
    // 决策条目 ts 非法 → Date.parse NaN → taskCount 恒 0 → 虚增①命中（F2 假绿主通路）——fail-closed
    if (!Number.isFinite(ts)) return { bucket: null, signature: 'null/-/', terminalState: 'null', missingEdges: [], taskCountAtTerminal: 0, schemaBad: `末决策条目 ts 缺失/非法（防 NaN→tc=0 虚增①，F2）: runId=${j.row.runId}`, corruptReason: null }
  }
  const terminal = terminalDecision(entries)
  const ts = last ? Date.parse(String(last.ts)) : 0
  // 【传递约束 2·Task 5】taskCountAtDecision 不按 sessionId 过滤——先按本会话过滤再传入
  const tc = taskCountAtDecision(sessionTasks.filter(t => t.sessionId === j.session.id), ts)
  const applied = appliedEdgesOf(entries)
  const missing = missingRequired(applied, requiredEdges)
  const sig = signatureOf(terminal, missing)
  try {
    const bucket = classifyBucket({ entries, appliedEdges: applied, failureMode: j.row.failureMode, failKind: j.row.failKind, terminal, taskCountAtTerminal: tc })
    return { bucket, signature: sig, terminalState: terminal?.state ?? 'null', missingEdges: missing, taskCountAtTerminal: tc, schemaBad: null, corruptReason: null }
  } catch (e) {
    // 【T6 携带】损坏会话降级为独立计数列，勿让单个损坏会话炸整批报告
    return { bucket: null, signature: sig, terminalState: terminal?.state ?? 'null', missingEdges: missing, taskCountAtTerminal: tc, schemaBad: null, corruptReason: String((e as Error)?.message ?? e) }
  }
}

export interface ClassifiedRun extends SessionClassification { band: string; arm: string; task: string; runId: string; pass: boolean }
/** 逐会话批量分类：schemaBad/corrupted 独立计数（不在此 exit——exit 语义由编排层判定）。 */
export function probeSessions(joined: Array<JoinedRun & { band: string }>, tasks: TaskRow[], requiredEdgesByTask: Record<string, Array<{ action: string; from: string; to: string }>>): { results: ClassifiedRun[]; schemaBadCount: number; corruptedCount: number } {
  const results: ClassifiedRun[] = []
  let schemaBadCount = 0; let corruptedCount = 0
  for (const j of joined) {
    const req = requiredEdgesByTask[j.row.taskId]
    if (!req) throw new Error(`[p11-probe fail-closed] taskId 无 requiredEdges 表: ${j.row.taskId}`)
    const c = probeSession(j, tasks, req)
    if (c.schemaBad) schemaBadCount++
    if (c.corruptReason) corruptedCount++
    results.push({ ...c, band: j.band, arm: j.row.config, task: j.row.taskId, runId: j.row.runId, pass: j.row.pass })
  }
  return { results, schemaBadCount, corruptedCount }
}

export interface MapRowInput { band: string; arm: string; task: string; bucket: Bucket; signature: string; terminalState: string; missingEdges: Array<{ action: string; from: string; to: string }> }
/**
 * 地图行构造（§2.5）：非⓪输入按 (band,arm,task,bucket,signature) 分组；pct = n ÷ 该 (task,band) 非⓪分母；
 * ② 签名 confirm-state 用跨带 merged 计数（同签名≥2→confirmed 需 (i) 过；真实连通表 (i) 败→candidate=主结局）；
 * ② 的机检 (ii) 非①邻域由 classifyBucket 优先级结构性保证（seqgate/①签名已被①吃）。①/③ 行 confirmState 恒 candidate 占位（绿门 verdict 只认 bucket==='②'）。
 */
export function buildMapRows(inputs: MapRowInput[]): { rows: SigRow[]; denominators: Record<string, number> } {
  const denominators: Record<string, number> = {}
  for (const x of inputs) { const k = `${x.task}|${x.band}`; denominators[k] = (denominators[k] ?? 0) + 1 }
  const groups = new Map<string, MapRowInput & { n: number }>()
  for (const x of inputs) {
    const k = `${x.band}|${x.arm}|${x.task}|${x.bucket}|${x.signature}`
    const g = groups.get(k)
    if (g) g.n++
    else groups.set(k, { ...x, n: 1 })
  }
  const merged: Record<string, number> = {}
  for (const x of inputs) if (x.bucket === '②') merged[x.signature] = (merged[x.signature] ?? 0) + 1
  const rows: SigRow[] = [...groups.values()].map(g => ({
    band: g.band, arm: g.arm, task: g.task, bucket: g.bucket, signature: g.signature,
    confirmState: g.bucket === '②' ? confirmState(g.signature, g.missingEdges, merged[g.signature] ?? 0, g.terminalState) : 'candidate',
    n: g.n,
    pct: (g.n / denominators[`${g.task}|${g.band}`]) * 100,
  }))
  assertPctLedger(rows, denominators)   // 【T11 携带 B】构造恒等自检（复用 assertSentinel 模式）
  return { rows, denominators }
}

/** §2.5-2 群/孤例分区：②签名跨带合并 n<2 → 孤例（仍②桶不成群）；①/③ 行不进孤例表（主表照常）。 */
export function partitionSingles(rows: SigRow[]): { groups: SigRow[]; singles: SigRow[] } {
  const merged: Record<string, number> = {}
  for (const r of rows) merged[r.signature] = (merged[r.signature] ?? 0) + r.n
  const groups: SigRow[] = []; const singles: SigRow[] = []
  for (const r of rows) (r.bucket === '②' && merged[r.signature] === 1 ? singles : groups).push(r)
  return { groups, singles }
}

export interface ReportStep0 { snapshotPath: string; snapshotSha: string; journalMode: string; join: string; titleCoarse: string; parseOk: number; parseTotal: number; schemaBad: number; cellMismatch: number; zeroRatio: string; strongFile: string; weakFile: string }
export interface ReportParts { groups: SigRow[]; singles: SigRow[]; cal: Calibration; sent: SentinelResult; tally: BucketTally; aNotPass: number; corrupted: number; strongCOffBuckets: Bucket[]; metricsTruth: { skip: number; defect: number }; step0: ReportStep0 }
/**
 * 报告装配（main 的装配核心，独立导出供测试）：
 * - 【T10 携带③】哨兵违例 ∨ 标定降级 → 顶部「先自查口径（选样/taskCount/join）」横幅；
 * - 【T10 携带②】哨兵 ok===false → 阻断全部靶点结论：renderMap 输出剥离「**裁决：**」行，报告不得出现红/绿裁决行；
 * - 【T11 携带 A】孤例表独立段（②单例分区渲染，不改 renderMap）。
 */
export function assembleReport(p: ReportParts): string {
  const mapMd = renderMap(p.groups, p.cal, p.sent)
  const lines = mapMd.split('\n')
  const tblStart = lines.findIndex(l => l.startsWith('| band |'))
  if (tblStart < 0) throw new Error('[p11-probe] renderMap 输出缺表头——装配中止')
  const L: string[] = lines.slice(0, tblStart)
  const blocked = !p.sent.ok
  if (p.cal.degraded || blocked) {
    const why = [blocked ? '哨兵违例' : null, p.cal.degraded ? '标定降级' : null].filter(Boolean).join(' ∧ ')
    L.push(`> ⚠️ 先自查口径（选样/taskCount/join）：${why}——靶点结论受限`, '')
  }
  let body = lines.slice(tblStart)
  if (blocked) {
    body = body.filter(l => !l.startsWith('**裁决：'))
    L.push(`> ❌ 哨兵违例：${p.sent.violations.join('；')}——全部靶点结论阻断，无红/绿裁决行`, '')
  }
  L.push(...body)
  // 孤例表（§2.5-2）
  L.push('', '## 孤例表（② 单例：同签名跨带合并 n<2，不成群）', '')
  if (p.singles.length === 0) L.push('（无孤例）')
  else {
    L.push('| band | arm | task | bucket | signature | confirm-state | n | % |', '|---|---|---|---|---|---|---|---|')
    for (const r of [...p.singles].sort((a, b) => (a.band + a.arm + a.bucket).localeCompare(b.band + b.arm + b.bucket) || b.n - a.n)) L.push(`| ${r.band} | ${r.arm} | ${r.task} | ${r.bucket} | ${r.signature} | ${r.confirmState} | ${r.n} | ${r.pct.toFixed(1)}% |`)
  }
  // 标定行 + 对账 + §0 权威对照
  const ones = p.strongCOffBuckets.filter(b => b === '①').length
  const zeros = p.strongCOffBuckets.filter(b => b === '⓪').length
  const sum = p.tally.zero + p.tally.one + p.tally.two + p.tally.three
  L.push('', '## 标定行（强带 C-off 正对照）', '')
  L.push(`- 输入=强带 C-off 桶数组 [${p.strongCOffBuckets.join(', ')}]（n=${p.strongCOffBuckets.length}，选样管道守卫：弱带桶混入即拒）；①=${ones} ⓪=${zeros} → ①复现率 ${ones}/${p.strongCOffBuckets.length || 1} → ${p.cal.degraded ? `降级：${p.cal.reason}` : '未降级（阈值 ≥4/5，复现率达标）'}`)
  L.push('', '## 对账（构造恒等 + §0 权威对照）', '')
  L.push(`- 四桶合计：⓪${p.tally.zero} + ①${p.tally.one} + ②${p.tally.two} + ③${p.tally.three} == ${sum} == A ¬pass ${p.aNotPass}${sum === p.aNotPass ? ' ✓ 平' : ' ✗ 不平'}`)
  L.push(`- metrics 真实重算（failKind 计数，非硬编码）：skip=${p.metricsTruth.skip}（§0 权威 9）、defect=${p.metricsTruth.defect}（§0 权威 4）`)
  L.push(`- 损坏/拒收（classifyBucket 拒收·独立计数列，不入桶）：${p.corrupted}；schemaDegraded（超 0 即 exit 1，能出报告应=0）：${p.step0.schemaBad}`)
  // Step-0 证据回显（§2.2-1）
  L.push('', '## Step-0 证据回显', '')
  L.push(`- 快照：${p.step0.snapshotPath} | sha256=${p.step0.snapshotSha} | journal_mode=${p.step0.journalMode} | 只拷主文件（-wal/-shm 未拷）`)
  L.push(`- metrics：strong ${p.step0.strongFile}；weak ${p.step0.weakFile}`)
  L.push(`- join：${p.step0.join}；title 'p5-' 粗筛 ${p.step0.titleCoarse}；taskId 精判串档=${p.step0.cellMismatch}；trace 解析/schema 通过 ${p.step0.parseOk}/${p.step0.parseTotal}（实测）`)
  L.push(`- ⓪ 占比前置（§2.2-5）：A ⓪=${p.step0.zeroRatio} < 0.3 → 通过`)
  L.push('', '> 注：confirm-state 仅对②有意义（①/③ 行恒 candidate 占位）；绿门=confirmed ② ∧ 跨带 presence（§2.4）；孤例=②签名跨带合并 n<2（§2.5-2）。')
  return L.join('\n')
}

export interface RunProbeResult { verdict: string; reportPath: string; tally: BucketTally; sent: SentinelResult; cal: Calibration }
/** 探针主管线（可测核心）：接线顺序固定——prepareSnapshot → assertSnapshotPath → assertWeakFrozenSha → openGuardedReadonly → readAll → joinRuns → 逐会话 → ②confirmState → calibrate → assertSentinel → renderMap → 落盘。任一 fail-closed 抛错即向上传播（main 捕获 → console.error + exit 1，不落结论）。 */
export async function runProbe(): Promise<RunProbeResult> {
  // fail-closed 不落陈旧结论：开跑先移除旧报告——跑挂=无报告，报告在=本次完成产物
  if (existsSync(REPORT_PATH)) unlinkSync(REPORT_PATH)
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
  const outDir = join(HERE, 'results', `snapshot-${stamp}`)
  const { copyPath, sha256 } = prepareSnapshot(join(HERE, 'p5.db'), outDir)
  assertSnapshotPath(copyPath)   // 【T3 携带】先白名单后开库（组合调用，防原地读活库）
  assertWeakFrozenSha(WEAK_FILE, PROBE_BATCH.weakFrozenSha)
  const client = await openGuardedReadonly(copyPath)
  try {
    const { journalMode, sessions, tasks } = await readAll(client)
    // ── metrics 装载 + 批成员闸门（§2.2-2 无 arms 外 config）──
    const strong = loadMetricsRows(STRONG_FILE)
    const weak = loadMetricsRows(WEAK_FILE)
    for (const r of [...strong.rows, ...weak.rows]) if (!PROBE_BATCH.arms.includes(r.config)) throw new Error(`[p11-probe fail-closed] arms 外 config 混入: ${r.config} (${r.runId})`)
    const strongSel = selectProbeCells(strong.rows)
    const weakSel = selectProbeCells(weak.rows)   // 【T9 携带】弱带只取 .A；弱带 C-off 不入样本、不计标定
    // ── join（【T4 携带】expect 全口径 A 各带=15、强带 C-off=5；【T5/T6 携带 c】band 归属按文件来源定，不用 dayGroup）──
    const p5Sessions = sessions.filter(s => String(s.title).startsWith('p5-'))
    const strongJoined = joinRuns([...strongSel.A, ...strongSel.strongCOff], p5Sessions, { A: 15, C: 5 }).map(j => ({ ...j, band: 'strong' }))
    const weakJoined = joinRuns(weakSel.A, p5Sessions, { A: 15 }).map(j => ({ ...j, band: 'weak' }))
    const allJoined = [...strongJoined, ...weakJoined]
    const ids = allJoined.map(j => j.session.id)
    if (new Set(ids).size !== ids.length) throw new Error('[p11-probe fail-closed] 跨带会话重复命中（join 双射破坏）')
    for (const j of allJoined) {   // §2.2-3 精判格：projectDir basename 内 taskId 与 metrics 行一致（断言无串档）
      const m = basename(j.session.projectDir).match(/-(A|B|C)-s\d+/)
      if (!m || m[1] !== j.row.taskId) throw new Error(`[p11-probe fail-closed] taskId 精判串档（§2.2-3）: ${j.row.runId} vs ${j.session.projectDir}`)
    }
    // ── 逐会话分类（parseEntries/terminalDecision/taskCountAtDecision/classifyBucket）──
    const requiredEdgesByTask = Object.fromEntries(TASKS.map(t => [t.id, t.requiredEdges]))
    const probed = probeSessions(allJoined, tasks, requiredEdgesByTask)
    if (probed.schemaBadCount > 0) throw new Error(`[p11-probe fail-closed] schemaDegraded=${probed.schemaBadCount} 超 0（§2.2-4/F8）——exit 1，不落结论`)
    const aFails = probed.results.filter(x => x.task === 'A' && !x.pass)
    // ⓪ 占比前置（§2.2-5）：A ⓪/¬pass ≥ 0.3 → 样本不足以裁 H8，不进裁决
    const zerosA = aFails.filter(x => x.bucket === '⓪').length
    if (aFails.length > 0 && zerosA / aFails.length >= 0.3) throw new Error(`[p11-probe fail-closed] A ⓪ 占比 ${zerosA}/${aFails.length} ≥ 0.3——样本不足以裁 H8（数据不足），不进裁决`)
    // metrics 真实重算（【T10 携带①】数 skip/defect 行，非硬编码）
    const aFailRows = [...strongSel.A, ...weakSel.A].filter(r => !r.pass)
    const metricsTruth = metricsTruthFromRows(aFailRows)
    // ── 标定（【T9 携带】只喂强带 C-off 桶数组；band 守卫拒弱带混入）──
    const cOffRuns = probed.results.filter(x => x.task === 'C' && x.band === 'strong')
    if (cOffRuns.some(x => x.bucket === null)) throw new Error('[p11-probe fail-closed] 强带 C-off 含损坏会话——标定基线不完整，拒')
    if (cOffRuns.some(x => x.pass)) throw new Error('[p11-probe fail-closed] 强带 C-off 含 pass 行——与 §0「5/5 ¬pass」锚漂移，拒')
    const strongCOffBuckets = calibrationBuckets(cOffRuns.map(x => ({ band: x.band, bucket: x.bucket as Bucket })))
    const cal = calibrate(strongCOffBuckets)
    // ── 地图行（非⓪；②confirmState 在 buildMapRows 内）+ 群/孤例分区 ──
    const mapInputs: MapRowInput[] = aFails.filter(x => x.bucket !== null && x.bucket !== '⓪').map(x => ({ band: x.band, arm: x.arm, task: x.task, bucket: x.bucket as Bucket, signature: x.signature, terminalState: x.terminalState, missingEdges: x.missingEdges }))
    const { rows: mapRows } = buildMapRows(mapInputs)
    const { groups, singles } = partitionSingles(mapRows)
    // ── 哨兵（先数后判；ok===false → 装配层阻断红/绿裁决行）──
    const tally: BucketTally = { zero: 0, one: 0, two: 0, three: 0 }
    for (const x of aFails) {
      if (x.bucket === '⓪') tally.zero++
      else if (x.bucket === '①') tally.one++
      else if (x.bucket === '②') tally.two++
      else if (x.bucket === '③') tally.three++
    }
    const sent = assertSentinel(tally, { skip: metricsTruth.skip, defect: metricsTruth.defect })
    const v = sent.ok ? verdict(mapRows) : 'BLOCKED'
    const fileMeta = (f: string) => `${basename(f)} ${loadMetricsRows(f).rows.length}行 sha256=${createHash('sha256').update(readFileSync(f)).digest('hex').slice(0, 12)}… mtime=${statSync(f).mtime.toISOString().slice(0, 19)}`
    const md = assembleReport({
      groups, singles, cal, sent, tally, aNotPass: aFails.length, corrupted: probed.corruptedCount, strongCOffBuckets, metricsTruth,
      step0: {
        snapshotPath: resolve(copyPath), snapshotSha: sha256, journalMode,
        join: `A strong=${strongSel.A.length} / C-off strong=${strongSel.strongCOff.length} / A weak=${weakSel.A.length}；跨带会话无重复命中`,
        titleCoarse: `${p5Sessions.length}/${sessions.length}`,
        parseOk: allJoined.length - probed.schemaBadCount, parseTotal: allJoined.length, schemaBad: probed.schemaBadCount, cellMismatch: 0,
        zeroRatio: `${zerosA}/${aFails.length}`,
        strongFile: fileMeta(STRONG_FILE), weakFile: `${fileMeta(WEAK_FILE)}（==冻结锚点 ✓）`,
      },
    })
    writeFileSync(REPORT_PATH, md)
    return { verdict: v, reportPath: REPORT_PATH, tally, sent, cal }
  } finally { client.close() }
}

/** --verify-only：复算 §0 实测数（A ¬pass/skip/defect 逐带+池），只读 metrics 冻结副本，不碰快照/库/报告。 */
export function verifyOnly(): void {
  assertWeakFrozenSha(WEAK_FILE, PROBE_BATCH.weakFrozenSha)
  const strong = loadMetricsRows(STRONG_FILE).rows
  const weak = loadMetricsRows(WEAK_FILE).rows
  const pooled: MetricsRow[] = []
  for (const [band, rows] of [['strong', strong], ['weak', weak]] as const) {
    const a = rows.filter(r => r.taskId === 'A')
    const fails = a.filter(r => !r.pass)
    pooled.push(...fails)
    const t = metricsTruthFromRows(fails)
    console.log(`[verify-only] ${band}: A=${a.length} ¬pass=${fails.length} skip=${t.skip} defect=${t.defect}`)
  }
  const pt = metricsTruthFromRows(pooled)
  console.log(`[verify-only] pooled: ¬pass=${pt.total} skip=${pt.skip} defect=${pt.defect}`)
  console.log(`[verify-only] §0 权威对照: ¬pass 13 / skip 9 / defect 4 — ${pt.total === 13 && pt.skip === 9 && pt.defect === 4 ? 'MATCH ✓' : 'DRIFT ✗'}`)
}

/** main：fail-closed 出口——任何抛错 console.error + exit 1，不落任何结论（报告在 runProbe 末尾原子落盘）。 */
export async function main(): Promise<void> {
  if (process.argv.includes('--verify-only')) { verifyOnly(); return }
  const { verdict: v, reportPath, tally, sent, cal } = await runProbe()
  console.log(`报告: ${reportPath}`)
  console.log(`四桶: ⓪${tally.zero} ①${tally.one} ②${tally.two} ③${tally.three} | 标定${cal.degraded ? '降级' : '通过'} | 哨兵${sent.ok ? 'ok' : '违例（结论阻断）'}`)
  console.log(`VERDICT=${v}`)
}
// 仅模块自身为入口时执行（endsWith 精判，防 vitest 装载测试文件时误触发真跑）
if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('analyze-a-surface-probe.ts')) {
  void main().catch((e: unknown) => { console.error(e); process.exit(1) })
}
