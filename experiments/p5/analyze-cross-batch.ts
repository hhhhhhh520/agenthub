/** P9-丙：跨批分析（spec docs/superpowers/specs/2026-08-23-p9-surface-matrix-design.md §4.1）
 *  纯离线只读。防御性约束（spec §8 F5）：禁 eval/动态 import；路径常量派生；DB 只读。 */
import { readFileSync } from 'node:fs'

export type BatchId = 'P6' | 'P7' | 'P8'
export interface NormRow {
  batch: BatchId; runId: string; config: string; taskId: string; seed: number
  pass: boolean; failureMode: string
  failKind: string | null   // null = 行内无此键（P6 整批 / pass 行），报告记 n/a
  rounds: number; escalateCount: number
  correctionCount: number; illegalProposalCount: number
  totalTransitions: number; latencyMs: number
}
export const BATCH_FILES: Record<BatchId, string> = {
  P6: 'metrics.a-b-43.bak.jsonl',
  P7: 'metrics.p7-60run-20260822.bak.jsonl',
  P8: 'metrics.p8-final-xfyun-20260823.jsonl',
}

function num(v: unknown): number { return typeof v === 'number' && Number.isFinite(v) ? v : 0 }

export function loadBatchRows(batch: BatchId, filePath: string): { rows: NormRow[]; badLines: number } {
  const text = readFileSync(filePath, 'utf-8')
  const rows: NormRow[] = []
  let badLines = 0
  for (const line of text.split('\n')) {
    const t = line.trim()
    if (!t) continue
    try {
      const r = JSON.parse(t) as Record<string, unknown>
      rows.push({
        batch,
        runId: String(r.runId ?? ''), config: String(r.config ?? ''),
        taskId: String(r.taskId ?? ''), seed: num(r.seed),
        pass: r.pass === true, failureMode: String(r.failureMode ?? ''),
        failKind: typeof r.failKind === 'string' ? r.failKind : null, // 缺键=null；不区分显式 undefined（旧 resume 行同型，P7 F6 口径）
        rounds: num(r.rounds), escalateCount: num(r.escalateCount),
        correctionCount: num(r.correctionCount), illegalProposalCount: num(r.illegalProposalCount),
        totalTransitions: num(r.totalTransitions), latencyMs: num(r.latencyMs),
      })
    } catch { badLines++ } // total：坏行跳过计数，不丢批
  }
  return { rows, badLines }
}

export interface CellFingerprint {
  n: number; pass: number; skip: number; defect: number; failKindOther: number; failKindNA: number
  corrSum: number; illSum: number; escSum: number
  sumRounds: number; sumTrans: number
}
export function fingerprintKey(config: string, taskId: string): string { return `${config}|${taskId}` }

export function aggregateFingerprints(rows: NormRow[]): Map<string, CellFingerprint> {
  const m = new Map<string, CellFingerprint>()
  for (const r of rows) {
    const k = fingerprintKey(r.config, r.taskId)
    const c = m.get(k) ?? { n: 0, pass: 0, skip: 0, defect: 0, failKindOther: 0, failKindNA: 0, corrSum: 0, illSum: 0, escSum: 0, sumRounds: 0, sumTrans: 0 }
    c.n++; if (r.pass) c.pass++
    if (r.failKind === 'skipped-spec-edge') c.skip++
    else if (r.failKind === 'defect') c.defect++
    else if (r.failKind === null) c.failKindNA++
    else c.failKindOther++
    c.corrSum += r.correctionCount; c.illSum += r.illegalProposalCount; c.escSum += r.escalateCount
    c.sumRounds += r.rounds; c.sumTrans += r.totalTransitions
    m.set(k, c)
  }
  return m
}

export interface ContaminationResult {
  contaminated: boolean; avgTrans: number; defectRatio: number; roundsFullRatio: number
}

/** 批次污染检测（spec §4.1-5；校准样本=metrics.p8-attempt1-quota-dead 阳性 / p8-final 阴性）。
 *  签名=LLM 死亡后空转：零转移 + rounds 打满 + defect 灌满。三条件 AND 防误伤。 */
export function detectBatchContamination(rows: NormRow[], opts?: {
  avgTransMax?: number; defectRatioMin?: number; roundsFullRatioMin?: number; roundsFullFloor?: number
}): ContaminationResult {
  const avgTransMax = opts?.avgTransMax ?? 1.0
  const defectRatioMin = opts?.defectRatioMin ?? 0.8
  const roundsFullRatioMin = opts?.roundsFullRatioMin ?? 0.5
  const roundsFullFloor = opts?.roundsFullFloor ?? 6
  const n = rows.length || 1
  const avgTrans = rows.reduce((s, r) => s + r.totalTransitions, 0) / n
  const defectRatio = rows.filter(r => r.failKind === 'defect').length / n
  const roundsFullRatio = rows.filter(r => r.rounds >= roundsFullFloor).length / n
  return {
    contaminated: avgTrans < avgTransMax && defectRatio > defectRatioMin && roundsFullRatio > roundsFullRatioMin,
    avgTrans, defectRatio, roundsFullRatio,
  }
}

// ---- DB 回放层（P9-丙 T4：只读包装 + 成分分类器 + 缺边类型学） ----
import { createClient } from '@libsql/client' // 既有依赖；只 SELECT（spec §8 F5c）
import { TASKS } from './tasks'
import { NON_TRANSITIONING, type Action } from '../../src/lib/orchestrator/state-machine' // 只读消费类型常量，非生产改动

export interface ReadonlyDb { select<T = Record<string, unknown>>(sql: string): Promise<T[]> }

export function createReadonlyDb(dbUrl: string): ReadonlyDb {
  const client = createClient({ url: dbUrl })
  return {
    async select<T>(sql: string) {
      if (!/^\s*(select|with)\b/i.test(sql)) throw new Error(`只读违规: ${sql.slice(0, 80)}`)
      const rs = await client.execute(sql)
      return rs.rows as T[]
    },
  }
}

export interface SessionRef { id: string; title: string; createdAt: string; dayGroup: string }

export async function probeExperimentSessions(db: ReadonlyDb): Promise<SessionRef[]> {
  const rows = await db.select<{ id: string; title: string; createdAt: string }>(
    `SELECT id, title, createdAt FROM Session WHERE title LIKE 'p5-%' ORDER BY createdAt`
  )
  return rows.map(r => ({ id: r.id, title: r.title, createdAt: String(r.createdAt), dayGroup: String(r.createdAt).slice(0, 10) }))
}

export type CorrectionSource = 'canonical' | 'gate' | 'done-guard'
export interface TraceEntryLite {
  inputState?: { state?: string }
  llmProposal?: { action?: string }
  corrections?: Array<{ from?: string; to?: string }>
}

/** 结构化定源（spec §8 F7）：不用 reason 子串。逐条模拟 chat-router 决策点顺序，
 *  按 (from,to)+状态定源：execute→align_decompose 唯一来源是闸门；
 *  done→execute 在 exec 态是 done 守卫、在 align_* 态是规则1。分类后 sim=corr.to 继续 redirect 链。
 *  T6 硬化：三字段全部可选链/默认空（decisionTrace 含 LLM 输出，schema 漂移单条不崩全局）。 */
export function classifyCorrections(entry: TraceEntryLite): CorrectionSource[] {
  const out: CorrectionSource[] = []
  let sim = entry.llmProposal?.action ?? ''
  const st = entry.inputState?.state ?? ''
  for (const c of entry.corrections ?? []) {
    const from = c.from ?? ''; const to = c.to ?? ''
    if (from !== sim) continue // 非 redirect 链上的注记条目（如 delegate 补 reason）不计
    if (from === 'execute' && to === 'align_decompose') out.push('gate')
    else if (from === 'done' && to === 'execute' && st === 'exec') out.push('done-guard')
    else out.push('canonical')
    sim = to
  }
  return out
}

export function findMissingEdges(
  appliedEdges: Array<{ action: string; from: string; to: string }>,
  requiredEdges: Array<{ action: string; from: string; to: string }>,
) {
  return requiredEdges.filter(req =>
    !appliedEdges.some(e =>
      e.action === req.action && e.to === req.to &&
      (req.from === '*' || e.from === req.from)
    )
  )
}

export interface MissingEdgeFinding {
  sessionId: string; title: string; dayGroup: string
  appliedEdges: Array<{ action: string; from: string; to: string }>
  missingRequired: Array<{ action: string; from: string; to: string }>
  doneEdgeAppliedFromExec: boolean
  correctionSources: Record<CorrectionSource, number>
}

interface FullTraceEntry extends TraceEntryLite {
  actualTransition?: { action?: string; from?: string; to?: string; applied?: boolean }
}

export async function analyzeSessionTrace(db: ReadonlyDb, ref: SessionRef): Promise<MissingEdgeFinding | null> {
  const rows = await db.select<{ decisionTrace: string | null }>(
    `SELECT decisionTrace FROM Session WHERE id = '${ref.id.replace(/'/g, "''")}'`
  )
  const raw = rows[0]?.decisionTrace
  if (!raw) return null
  let entries: FullTraceEntry[] = []
  try { entries = JSON.parse(raw) as FullTraceEntry[] } catch { return null } // safe-parse：trace 含 LLM 输出绝不信任（F5a）
  const appliedEdges: MissingEdgeFinding['appliedEdges'] = []
  const sources: Record<CorrectionSource, number> = { canonical: 0, gate: 0, 'done-guard': 0 }
  for (const e of Array.isArray(entries) ? entries : []) {
    for (const s of classifyCorrections(e)) sources[s]++
    const at = e.actualTransition
    if (at?.applied === true && at.action && !NON_TRANSITIONING.has(at.action as Action)) {
      appliedEdges.push({ action: at.action, from: at.from ?? '', to: at.to ?? '' })
    }
  }
  const task = TASKS.find(t => ref.title.includes(`-${t.id}-s`))
  return {
    sessionId: ref.id, title: ref.title, dayGroup: ref.dayGroup,
    appliedEdges, missingRequired: findMissingEdges(appliedEdges, task?.requiredEdges ?? []),
    doneEdgeAppliedFromExec: appliedEdges.some(e2 => e2.action === 'done' && e2.from === 'exec'),
    correctionSources: sources,
  }
}

// ---- 报告渲染器（P9-丙 T5：六章 markdown + P6 溯源对照；模板字符串拼接，无外部模板引擎） ----

/** 标识/文件名消毒（spec §8 F5b）：白名单 [A-Za-z0-9._+-]，其余字符折叠为 '_' */
export function sanitizeIdentifier(s: string): string {
  return s.replace(/[^A-Za-z0-9._+-]/g, '_')
}

export interface CrossBatchInput {
  fingerprints: Map<string, CellFingerprint>
  contamination: Record<BatchId, ContaminationResult>
  findings: MissingEdgeFinding[]
  badLineCounts: Record<BatchId, number>
  sessionDayGroups: Array<{ day: string; count: number }>
}

/** report.p6 权威逐格 pass 数组——硬编码抄录自 results/report.p6-20260816.md:13-24。
 *  spec §4.1-6：以 report.p6 为权威（内部自洽，pass 合计 42）；jsonl 含事后重跑行（43）仅作实数对照。 */
const P6_AUTHORITATIVE: ReadonlyArray<{ config: string; task: string; passes: readonly number[] }> = [
  { config: 'on+verify', task: 'A', passes: [1, 1, 1, 1, 1] },
  { config: 'on+verify', task: 'B', passes: [1, 1, 1, 1, 1] },
  { config: 'on+verify', task: 'C', passes: [1, 0, 1, 0, 0] },
  { config: 'on+no-verify', task: 'A', passes: [1, 1, 1, 1, 1] },
  { config: 'on+no-verify', task: 'B', passes: [1, 1, 1, 1, 1] },
  { config: 'on+no-verify', task: 'C', passes: [0, 0, 0, 0, 0] },
  { config: 'off+verify', task: 'A', passes: [1, 1, 1, 1, 1] },
  { config: 'off+verify', task: 'B', passes: [1, 1, 1, 1, 1] },
  { config: 'off+verify', task: 'C', passes: [0, 0, 0, 0, 0] },
  { config: 'off+no-verify', task: 'A', passes: [1, 1, 1, 1, 1] },
  { config: 'off+no-verify', task: 'B', passes: [1, 1, 1, 1, 1] },
  { config: 'off+no-verify', task: 'C', passes: [0, 0, 0, 0, 0] },
]

const BATCH_ORDER: readonly BatchId[] = ['P6', 'P7', 'P8']
const CORRECTION_SOURCES: readonly CorrectionSource[] = ['canonical', 'gate', 'done-guard']
const pct1 = (x: number): string => `${(x * 100).toFixed(1)}%`
const div2 = (sum: number, n: number): string => (n > 0 ? (sum / n).toFixed(2) : 'n/a')

export function renderCrossBatchReport(input: CrossBatchInput): string {
  const out: string[] = []
  out.push('# 跨批分析报告（P9-丙）\n')

  // 一、批次健康检查
  out.push('## 批次健康检查\n')
  out.push('| 批次 | 坏行 | avgTrans | defect率 | rounds打满率 | 污染判定 |')
  out.push('|---|---|---|---|---|---|')
  for (const b of BATCH_ORDER) {
    const c = input.contamination[b]
    out.push(`| ${b} | ${input.badLineCounts[b] ?? 0} | ${c ? c.avgTrans.toFixed(2) : 'n/a'} | ${c ? pct1(c.defectRatio) : 'n/a'} | ${c ? pct1(c.roundsFullRatio) : 'n/a'} | ${c?.contaminated ? '**污染**' : '正常'} |`)
  }
  out.push('\n### 会话日分组\n')
  if (input.sessionDayGroups.length === 0) out.push('（无会话留存）')
  else for (const g of input.sessionDayGroups) out.push(`- ${g.day}：${g.count} 会话`)

  // 二、统一指纹表
  out.push('\n## 统一指纹表\n')
  out.push('> 口径 OFF=ill ON=corr：OFF 配置读 ill 列（非法尝试数），ON 配置读 corr 列（纠正次数）；P6 行 failKind 无记录记 n/a。\n')
  out.push('| 格 | n | pass | skip | defect | other | n/a | corr | ill | esc | avgRounds | avgTrans |')
  out.push('|---|---|---|---|---|---|---|---|---|---|---|---|')
  for (const [k, v] of [...input.fingerprints].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))) {
    out.push(`| ${k.replace(/\|/g, '/')} | ${v.n} | ${v.pass} | ${v.skip} | ${v.defect} | ${v.failKindOther} | ${v.failKindNA} | ${v.corrSum} | ${v.illSum} | ${v.escSum} | ${div2(v.sumRounds, v.n)} | ${div2(v.sumTrans, v.n)} |`)
  }
  if (input.fingerprints.size === 0) out.push('（指纹表为空）')

  // 三、corrections 成分分解
  const srcTotals: Record<CorrectionSource, number> = { canonical: 0, gate: 0, 'done-guard': 0 }
  for (const f of input.findings) for (const s of CORRECTION_SOURCES) srcTotals[s] += f.correctionSources[s] ?? 0
  out.push('\n## corrections 成分分解\n')
  out.push(`回放 session 数：${input.findings.length}`)
  for (const s of CORRECTION_SOURCES) out.push(`- ${s}：${srcTotals[s]} 次`)
  out.push('\n> 注：decisionTrace 每 session 封顶 500 条（decision-trace.ts:57），成分计数为截断后下界。')

  // 四、缺边类型学
  out.push('\n## 缺边类型学\n')
  const missing = input.findings.filter(f => f.missingRequired.length > 0)
  if (missing.length === 0) {
    out.push('无缺边 session（回放范围内全部必需边已走通）。')
  } else {
    const types = new Map<string, number>()
    for (const f of missing) {
      const sig = f.missingRequired.map(e => `${e.action}:${e.from}→${e.to}`).sort().join(' ; ')
      types.set(sig, (types.get(sig) ?? 0) + 1)
    }
    for (const [sig, cnt] of [...types].sort((a, b) => b[1] - a[1])) {
      out.push(`- [${cnt} session] 缺 ${sig}`)
    }
  }
  out.push(`done 边从 exec 发出的 session 数（捷径收尾信号）：${input.findings.filter(f => f.doneEdgeAppliedFromExec).length}`)

  // 五、H1′ 作用面结论
  let skipTotal = 0
  let defectTotal = 0
  for (const [, v] of input.fingerprints) { skipTotal += v.skip; defectTotal += v.defect }
  const contaminated = BATCH_ORDER.filter(b => input.contamination[b]?.contaminated === true)
  const badLineTotal = BATCH_ORDER.reduce((s, b) => s + (input.badLineCounts[b] ?? 0), 0)
  const errTotal = skipTotal + defectTotal
  out.push('\n## H1′ 作用面结论\n')
  out.push(`- 错误类产出（跨批指纹合计）：skipped-spec-edge=${skipTotal}，defect=${defectTotal}`)
  out.push(`- 干预触发面（DB 回放）：gate=${srcTotals.gate} 次，done-guard=${srcTotals['done-guard']} 次`)
  out.push(`- 批次健康：${contaminated.length > 0 ? `${contaminated.join('/')} 命中污染签名，其指纹不进入解读` : '三批均无污染签名'}；坏行合计 ${badLineTotal}`)
  out.push(errTotal > 0
    ? `- H1′ 判读：主导错误类产出率 > 0（合计 ${errTotal}），干预效应具备可测作用面`
    : '- H1′ 判读：错误类产出率 ≈ 0，干预效应按 H1′ 不可测——作用面与错误形态错位')

  // 六、P6 溯源对照
  out.push('\n## P6 溯源对照\n')
  out.push('> 权威=report.p6-20260816.md:13-24 逐格数组（内部自洽）；jsonl 含事后重跑行仅作实数对照。\n')
  out.push('| config | task | 权威 pass 数组 | 权威 pass | jsonl pass/n | jsonl corr/ill | 对照判定 |')
  out.push('|---|---|---|---|---|---|---|')
  const diffs: string[] = []
  for (const a of P6_AUTHORITATIVE) {
    const authSum = a.passes.reduce((s, x) => s + x, 0)
    const fp = input.fingerprints.get(`P6|${fingerprintKey(a.config, a.task)}`) // T6：指纹键带批次前缀，对照节同步按 P6 前缀查
    if (!fp) {
      diffs.push(`${a.config}-${a.task}：jsonl 指纹缺格（权威 ${authSum}/5）`)
      out.push(`| ${a.config} | ${a.task} | ${a.passes.join('/')} | ${authSum}/5 | n/a | n/a | jsonl 缺格 |`)
    } else if (fp.pass !== authSum) {
      diffs.push(`${a.config}-${a.task}：权威 ${authSum}/5 vs jsonl ${fp.pass}/${fp.n}`)
      out.push(`| ${a.config} | ${a.task} | ${a.passes.join('/')} | ${authSum}/5 | ${fp.pass}/${fp.n} | ${fp.corrSum}/${fp.illSum} | **不一致** |`)
    } else {
      out.push(`| ${a.config} | ${a.task} | ${a.passes.join('/')} | ${authSum}/5 | ${fp.pass}/${fp.n} | ${fp.corrSum}/${fp.illSum} | 一致 |`)
    }
  }
  out.push('')
  out.push(diffs.length > 0
    ? `差异点名（${diffs.length} 处）：\n${diffs.map(d => `- ${d}`).join('\n')}`
    : '两源逐格一致，无差异条目。')
  out.push('\n> 注：罐头引导期，不作 provider 对照。')

  return out.join('\n')
}

// ---- P9-丙 T6：main() 接线（串接五段 → 落盘 results/report-cross-batch.md；路径常量派生自 CONFIG） ----
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { CONFIG } from './config'

export async function main(): Promise<string> {
  // ① 加载 + 按批聚合（rows.filter 按批过滤后分别聚合，前缀键合入——三批同 config|task 不静默覆盖）
  const fingerprints = new Map<string, CellFingerprint>()
  const contamination = {} as Record<BatchId, ContaminationResult>
  const badLineCounts = {} as Record<BatchId, number>
  for (const b of BATCH_ORDER) {
    const { rows, badLines } = loadBatchRows(b, join(CONFIG.resultsDir, BATCH_FILES[b]))
    badLineCounts[b] = badLines
    contamination[b] = detectBatchContamination(rows)
    for (const [k, v] of aggregateFingerprints(rows.filter(r => r.batch === b))) {
      fingerprints.set(`${b}|${k}`, v)
    }
  }

  // ② DB 回放（只读包装；会话 for...of await 串行防 SQLite 锁）
  const db = createReadonlyDb(CONFIG.dbPath)
  const sessions = await probeExperimentSessions(db)
  const findings: MissingEdgeFinding[] = []
  for (const s of sessions) {
    const f = await analyzeSessionTrace(db, s)
    if (f) findings.push(f)
  }
  const dg = new Map<string, number>()
  for (const s of sessions) dg.set(s.dayGroup, (dg.get(s.dayGroup) ?? 0) + 1)
  const sessionDayGroups = [...dg].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([day, count]) => ({ day, count }))

  // ③ 渲染 + 落盘（返回输出绝对路径）
  const md = renderCrossBatchReport({ fingerprints, contamination, findings, badLineCounts, sessionDayGroups })
  const outPath = join(CONFIG.resultsDir, 'report-cross-batch.md')
  writeFileSync(outPath, md, 'utf-8')
  return outPath
}
