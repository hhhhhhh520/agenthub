/** P10 线一：seqgate 移植回顾决策（spec 2026-09-01 §2.1）——dev.db 快照只读分析，零 LLM。
 *  安全配方（审查 F1/F2/F6/F8/F10/F11/F13 并入）：快照副本 + query_only + write-self-test +
 *  fail-closed 前置闸门；禁 import @/lib/db（prisma-libsql 切 WAL + Windows 句柄泄漏，setup.ts:131 实证）；
 *  永不发 PRAGMA journal_mode=<设置>（只读取值）。
 *  注（发射前复核 #5）：query_only 连接可能在快照目录留 -wal/-shm 伴生文件——副本 disposable 无害
 *  （close 不释放句柄是 vitest runner 已知行为，本脚本走 tsx 单进程）；本脚本绝不对活体 dev.db 指路径。 */
import { createClient, type Client } from '@libsql/client'
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { basename, isAbsolute, join, resolve } from 'node:path'

const HERE = import.meta.dirname
const MAX_TRACE = 500 // decision-trace.ts:96 同封顶：截断丢最旧、idle 事件天然最前 → 命中面为下界

export interface SessionRow { id: string; type: string; title: string; createdAt: string; updatedAt: string; decisionTrace: string | null }
export interface TaskRow { id: string; sessionId: string; createdAt: string }
export interface HitEvent { sessionId: string; ts: number; taskCountAtDecision: number; taskCountFinal: number }
export interface PartialStats {
  scannedRows: number; parseFailed: number; tracePresent: number; traceEmpty: number
  analyzableSessions: number; truncatedSessions: number; typeCounts: Record<string, number>
  hits: HitEvent[]; maxUpdatedAt: string
}
export interface ReplayStats extends PartialStats { journalMode: string; dbCopyPath: string; sha256: string }

/** 谓词（双审实证）：decisionPoint='handleOrchestratorDecision' ∧ inputState.state='idle' ∧ llmProposal.action='done'
 *  （llmProposal 是纠正前快照，chat-router:82-87）；transitionPhase 条目天然排除。
 *  taskCountAtDecision = Task.createdAt ≤ entry.ts（Date.parse 数值比，F10）。 */
export function analyzeSessions(sessions: SessionRow[], tasks: TaskRow[]): PartialStats {
  const st: PartialStats = {
    scannedRows: 0, parseFailed: 0, tracePresent: 0, traceEmpty: 0, analyzableSessions: 0,
    truncatedSessions: 0, typeCounts: {}, hits: [], maxUpdatedAt: '',
  }
  for (const s of sessions) {
    st.scannedRows++
    st.typeCounts[s.type] = (st.typeCounts[s.type] ?? 0) + 1
    if (String(s.updatedAt) > st.maxUpdatedAt) st.maxUpdatedAt = String(s.updatedAt) // 展示用同格式可字典序
    if (s.id.startsWith('p5-')) continue
    const raw = s.decisionTrace
    if (raw == null || raw === '' || raw === '[]') { st.traceEmpty++; continue }
    let entries: unknown
    try { entries = JSON.parse(raw) } catch { st.parseFailed++; continue }
    if (!Array.isArray(entries)) { st.parseFailed++; continue }
    st.tracePresent++
    const decEntries = (entries as any[]).filter(e => e?.decisionPoint === 'handleOrchestratorDecision')
    if (decEntries.length > 0) st.analyzableSessions++
    if ((entries as unknown[]).length >= MAX_TRACE) { st.truncatedSessions++; continue }
    const own = tasks.filter(t => t.sessionId === s.id)
    for (const e of decEntries) {
      if (e?.inputState?.state !== 'idle' || e?.llmProposal?.action !== 'done') continue
      const ts = Date.parse(String(e.ts))
      if (Number.isNaN(ts)) { st.parseFailed++; continue }
      const atDecision = own.filter(t => Date.parse(String(t.createdAt)) <= ts).length
      st.hits.push({ sessionId: s.id, ts, taskCountAtDecision: atDecision, taskCountFinal: own.length })
    }
  }
  return st
}

/** 命中面 = seqgate 若在生产会拦的事件（idle 过早 done 且决策时零任务） */
export function gateHits(hits: HitEvent[]): HitEvent[] {
  return hits.filter(h => h.taskCountAtDecision === 0)
}

/** 三分支规则（spec §2.1；计量单位=含 ≥1 条决策点 trace 的非 p5 会话数） */
export function decideBranch(a: { analyzableSessions: number; gateHitCount: number }): { branch: string; text: string } {
  if (a.analyzableSessions < 20) {
    return { branch: '3', text: `样本不足（可分析会话 ${a.analyzableSessions} < 20）→ 维持 env 门控（EXPERIMENT_SEQGATE 生产默认关）不转正。启动条件：可分析会话 ≥20 且 gate 命中 ≥5 时重跑本脚本即出分支 manual 数据（当前命中 ${a.gateHitCount}）` }
  }
  return { branch: 'manual', text: '样本充足 → 人工复核报告命中表的首条用户消息意图（真需求被偷懒 vs 闲聊自然收尾）：误伤高=不转正负决策 / 误伤低=可转正+就绪评估（实施另立项）' }
}

/** fail-closed 前置闸门（F2：任何路径错误不得产出与"真相"同形的报告） */
export function assertFailClosed(st: ReplayStats): void {
  const bad: string[] = []
  if (st.scannedRows === 0) bad.push('scannedRows=0（错路径/空壳库？）')
  if (st.parseFailed > 0) bad.push(`parseFailed=${st.parseFailed}（禁止静默丢弃）`)
  if (!isAbsolute(st.dbCopyPath)) bad.push('dbCopyPath 非绝对路径')
  if (!/^[0-9a-f]{64}$/.test(st.sha256)) bad.push('sha256 未记录')
  if (bad.length) throw new Error(`[port-replay fail-closed] ${bad.join('；')} —— 不得输出任何分支结论`)
}

/** F8 消毒：控制字符（含 ESC/NUL）与双向覆盖符剥离、| 转义防表格撕裂、80 码点截断
 *  字符类 = \p{Cc} ∪ U+202A-U+202E（LRE/RLE/PDF/LRO/RLO）∪ U+2066-U+2069（LSI/RLI/FSI/PDI），
 *  双向段用显式转义（计划文档里为字面不可见字符，同码点等价） */
export function sanitizeExcerpt(raw: string): string {
  const clean = raw.replace(/[\p{Cc}‪-‮⁦-⁩]/gu, ' ').replace(/\|/g, '\\|')
  const cps = Array.from(clean)
  return cps.length > 80 ? cps.slice(0, 80).join('') + '…' : cps.join('')
}

/** F6：wal 非空=应用可能在写 → 拒；只拷主文件（wal 为空无未 checkpoint 提交） */
export function prepareSnapshot(devDbPath: string, outDir: string): { copyPath: string; sha256: string } {
  const src = resolve(devDbPath)
  if (!existsSync(src)) throw new Error(`dev.db 不存在: ${src}`)
  const wal = src + '-wal'
  if (existsSync(wal) && statSync(wal).size > 0) throw new Error(`dev.db-wal 非空（应用可能在写）——先停应用再跑: ${wal}`)
  mkdirSync(outDir, { recursive: true })
  const copyPath = join(outDir, basename(src))
  copyFileSync(src, copyPath)
  return { copyPath, sha256: createHash('sha256').update(readFileSync(copyPath)).digest('hex') }
}

/** F1 实证配方：独立连接 + query_only + write-self-test（UPDATE 必须被拦；缺 Session 表=假只读，中止） */
export async function openGuardedReadonly(copyPath: string): Promise<Client> {
  const client = createClient({ url: 'file:' + copyPath })
  await client.execute('PRAGMA query_only=ON;')
  let blocked = false
  try { await client.execute('UPDATE Session SET phase = phase WHERE 1=0') } catch (e) { blocked = /readonly|query only/i.test(String((e as Error)?.message)) }
  if (!blocked) { client.close(); throw new Error('[port-replay] write-self-test 未拦截写（query_only 失效或库缺 Session 表）——中止') }
  return client
}

export async function readAll(client: Client): Promise<{ journalMode: string; sessions: SessionRow[]; tasks: TaskRow[] }> {
  const jm = await client.execute('PRAGMA journal_mode;')
  const s = await client.execute({ sql: 'SELECT id, type, title, createdAt, updatedAt, decisionTrace FROM Session', args: [] })
  const t = await client.execute({ sql: 'SELECT id, sessionId, createdAt FROM Task', args: [] })
  return {
    journalMode: String((jm.rows[0] as Record<string, unknown>)?.journal_mode ?? ''),
    sessions: s.rows as unknown as SessionRow[],
    tasks: t.rows as unknown as TaskRow[],
  }
}

/** 命中会话首条 user 消息（参数化逐查，命中面≤几十；禁 SELECT * / 禁查 Agent/Provider，F13） */
export async function firstMessages(client: Client, ids: string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  for (const id of ids) {
    const r = await client.execute({ sql: 'SELECT rawContent FROM Message WHERE sessionId = ? ORDER BY createdAt ASC LIMIT 1', args: [id] })
    out[id] = r.rows.length ? String((r.rows[0] as Record<string, unknown>).rawContent ?? '') : ''
  }
  return out
}

export function renderReport(st: ReplayStats, decision: { branch: string; text: string }, msgs: Record<string, string>, hits: HitEvent[]): string {
  const gh = gateHits(hits)
  const l: string[] = []
  l.push('# P10 线一：seqgate 移植回顾决策报告', '')
  l.push('> 本文件在 results/（gitignored）。可提交产物只允许聚合数字（F8）。')
  l.push('', '## 快照元数据（fail-closed 闸门证据）')
  l.push(`- 副本: ${st.dbCopyPath} | sha256: ${st.sha256} | journal_mode: ${st.journalMode} | 快照边界 maxUpdatedAt: ${st.maxUpdatedAt}`)
  l.push(`- 扫描会话 ${st.scannedRows} | trace 三态: 有 ${st.tracePresent} / 空 ${st.traceEmpty} / 解析失败 ${st.parseFailed}（必为 0）`)
  l.push(`- 按 type ${JSON.stringify(st.typeCounts)} | 可分析会话（≥1 决策点，除 p5-）: ${st.analyzableSessions} | 触顶截断除名: ${st.truncatedSessions}（命中面为下界）`)
  l.push('', '## 命中面')
  l.push(`- idle∧done 决策事件 ${hits.length}；其中决策时刻 taskCount=0（seqgate 会拦）: ${gh.length}`)
  if (hits.length) {
    l.push('', '| session（截 8 位） | 决策时刻任务数 | 终态任务数 | 首条消息摘录（消毒） |', '|---|---|---|---|')
    for (const h of hits) l.push(`| ${h.sessionId.slice(0, 8)}… | ${h.taskCountAtDecision} | ${h.taskCountFinal} | ${msgs[h.sessionId] ? sanitizeExcerpt(msgs[h.sessionId]) : '—'} |`)
  }
  l.push('', '## 决策', `- 分支 **${decision.branch}**：${decision.text}`)
  return l.join('\n')
}

async function main(): Promise<void> {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
  const outDir = join(HERE, 'results', `snapshot-${stamp}`)
  const { copyPath, sha256 } = prepareSnapshot(join(HERE, '..', '..', 'dev.db'), outDir)
  const client = await openGuardedReadonly(copyPath)
  const { journalMode, sessions, tasks } = await readAll(client)
  const stats: ReplayStats = { ...analyzeSessions(sessions, tasks), journalMode, dbCopyPath: copyPath, sha256 }
  try {
    assertFailClosed(stats)
  } catch (e) {
    console.error(String((e as Error)?.message ?? e))
    client.close()
    process.exit(1)
  }
  const gh = gateHits(stats.hits)
  const decision = decideBranch({ analyzableSessions: stats.analyzableSessions, gateHitCount: gh.length })
  const msgs = await firstMessages(client, [...new Set(stats.hits.map(h => h.sessionId))])
  client.close()
  writeFileSync(join(HERE, 'results', 'report-p10-port-decision.md'), renderReport(stats, decision, msgs, stats.hits), 'utf8')
  console.log(`BRANCH=${decision.branch}`)
  console.log(`聚合行（可入 docs/memory）: 扫描${stats.scannedRows}/可分析${stats.analyzableSessions}/命中${gh.length}/截断${stats.truncatedSessions} → 分支${decision.branch}`)
}
if (process.argv[1] && process.argv[1].includes('analyze-port-replay')) void main()
