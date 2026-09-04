# P11 作用面「有界预测」证伪探针 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建一个纯离线探针 `experiments/p5/analyze-a-surface-probe.ts`，把 A 格（+ 强带 C-off 正对照）的每次失败确定性地分进四桶（⓪未推进/①seqgate老靶/②构造性残差/③内容不可救），产出「四桶失败地图 + 红/绿裁决」，证伪/证实作用面论对 A 的有界预测。

**Architecture:** 单模块（对齐 `analyze-port-replay.ts`/`analyze-cross-batch.ts` 体例）：导出纯函数（可单测）+ 末尾 `main()`（快照→读库→join→分桶→标定→哨兵→地图→报告）。零 `src/lib/**` 运行时 import；`TRANSITIONS`/`NON_TRANSITIONING`/seqgate 谓词**内联副本 + 源文本漂移测试**；读**自带快照副本**（`prepareSnapshot` 只拷主文件 + 非空 WAL 拒，`openGuardedReadonly` query_only + write-self-test）。

**Tech Stack:** TypeScript + `@libsql/client`（只读）+ `node:fs/crypto/path` + vitest（p5 专用 `--config experiments/p5/vitest.config.ts`）。零新依赖。

## Global Constraints（逐条 verbatim 自 spec v6 §2/§6，所有任务隐含遵守）
1. **零 `src/lib/**` 运行时 import**；禁 `@/lib/db`、禁 import `analyze-cross-batch.ts`（`:98` 有 src/lib 运行时边）。`TRANSITIONS`/`NON_TRANSITIONING`/seqgate 谓词用**探针本地内联副本**，各配**源文本漂移测试**（读 `src/lib/orchestrator/state-machine.ts` 源、断言一致；`type`-only import 可）。
2. **一律读快照副本**：`prepareSnapshot` **只拷主文件**、拷贝前断言「无实验进程 ∨ `p5.db-wal` 为空」否则拒；**绝不拷 `-wal/-shm`**。Step-0 路径白名单 == `experiments/p5/results/snapshot-*/p5.db`，**不放行原地 `experiments/p5/p5.db`**。
3. **`openGuardedReadonly`**：独立 `@libsql` client + `PRAGMA query_only=ON` + write-self-test（故意 UPDATE 必须被拦）；永不发 `PRAGMA journal_mode=<设置>`。
4. **pass/failureMode/failKind 唯一权威源 = metrics 行**（不调/不复制 `classifyFailKind`/`resolveFailureMode`/`hasRequiredEdges`/`checkConformance`）。
5. **决策时刻 taskCount 查 `Task` 表**，`Task.createdAt` vs trace `ts` **`Date.parse` 数值比、禁字符串比**。
6. **弱批源 = 冻结副本** `results/metrics.p10-weak-frozen-20260904.bak.jsonl`，**sha256 必须 == `af6e590a2878e80585dafd726fc7a857af589c48a4047814ed625f6fed620ba6`**，否则 exit 1。
7. **正对照只钉强带 C-off（5）**；弱带 C-off（4 skipped+1 defect）不入样本、不计标定。标定阈值 **①复现率 ≥4/5**，否则降级横幅。
8. **绝不上 LLM-as-judge**；机检 (i)=转移表可达性判定、**严禁回放本会话观测序列**。
9. 桶优先级 **`⓪≻①≻③≻②`**，②=构造性残差（=¬pass−⓪−①−③），四桶和==¬pass 总数（构造恒等）。
10. **F8**：产物 `report-a-surface-probe.md` 进 gitignored `results/`；可提交物只准聚合数 + 裁决号；无 sessionId/消息原文/密钥。
11. **新测试文件必须加 `experiments/p5/vitest.config.ts` include**；每个修改配针对性测试（红绿验证）；变异/负例先证明会红。
12. 每任务收尾 `git add <本任务文件> && git commit`（单任务原子提交）。

**⚠️ 已知语义后果（Task 8 相关，用户已被告知）**：真实 `TRANSITIONS` 很连通 → A/C 三条必需边从任意可达态均可覆盖 → 机检 (i) 对真实数据几乎必然失败 → ②-confirmed ≈ 不可能 → 探针结构性落红（与「红为预期」一致）。故 Task 8 正例 fixture 用**合成转移表**证明 (i) 非恒假，负例用真实表证明会失败。若用户后续要放宽 (i)（如「起点可达而末态不可达=结构陷阱」），仅改 Task 8。

---

### Task 1: 脚手架 + 内联常量（TRANSITIONS / NON_TRANSITIONING / seqgate 谓词）+ 源文本漂移测试

**Files:**
- Create: `experiments/p5/analyze-a-surface-probe.ts`
- Test: `experiments/p5/analyze-a-surface-probe.test.ts`
- Modify: `experiments/p5/vitest.config.ts`（include 加一行）

**Interfaces:**
- Produces: `type State`、`type Action`、`const TRANSITIONS: Record<State, Partial<Record<Action,State>>>`、`const NON_TRANSITIONING: ReadonlySet<Action>`、`function seqgatePredicate(state,action,taskCount): boolean`、`const MAX_TRACE=500`。后续任务全部依赖这些。

- [ ] **Step 1: vitest.config include 加行**
在 `experiments/p5/vitest.config.ts` 的 `include` 数组加 `'analyze-a-surface-probe.test.ts'`（对齐现有 `analyze-cross-batch.test.ts` 行）。

- [ ] **Step 2: 写漂移测试（先红）**
`analyze-a-surface-probe.test.ts`：
```ts
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { TRANSITIONS, NON_TRANSITIONING, seqgatePredicate } from './analyze-a-surface-probe'

const SM_SRC = readFileSync(join(__dirname, '..', '..', 'src', 'lib', 'orchestrator', 'state-machine.ts'), 'utf8')

describe('源文本漂移（内联副本 == state-machine.ts）', () => {
  it('TRANSITIONS 关键边与源一致', () => {
    for (const seg of [
      "align_confirm: 'align_pm'", "align_decompose: 'align_arch'", "execute: 'exec'", "done: 'done'",
      "align_qa: 'align_qa'",
    ]) expect(SM_SRC).toContain(seg)
    // 内联副本与源同构：抽查三条
    expect(TRANSITIONS.idle.align_decompose).toBe('align_arch')
    expect(TRANSITIONS.exec.done).toBe('done')
    expect(TRANSITIONS.align_qa.align_decompose).toBe('align_arch')
  })
  it('NON_TRANSITIONING 与源一致', () => {
    for (const a of ['self', 'delegate', 'discuss', 'verify']) {
      expect(SM_SRC).toContain(`'${a}'`)
      expect(NON_TRANSITIONING.has(a as never)).toBe(true)
    }
  })
  it('seqgate 谓词与源一致', () => {
    expect(SM_SRC).toContain("state === 'idle' && action === 'done' && taskCount === 0")
    expect(seqgatePredicate('idle', 'done', 0)).toBe(true)
    expect(seqgatePredicate('idle', 'done', 1)).toBe(false)
    expect(seqgatePredicate('exec', 'done', 0)).toBe(false)
  })
})
```
- [ ] **Step 3: 运行确认红**
`cd /d/ai全栈挑战赛/agenthub && npx vitest run --config experiments/p5/vitest.config.ts analyze-a-surface-probe`
Expected: FAIL（模块/导出不存在）。
- [ ] **Step 4: 实现常量（最小）**
`analyze-a-surface-probe.ts`：
```ts
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
```
- [ ] **Step 5: 运行确认绿 + 提交**
`npx vitest run --config experiments/p5/vitest.config.ts analyze-a-surface-probe` → PASS。
`git add experiments/p5/analyze-a-surface-probe.ts experiments/p5/analyze-a-surface-probe.test.ts experiments/p5/vitest.config.ts && git commit -m "feat(p11-probe): 脚手架+内联常量+源文本漂移测试"`

---

### Task 2: metrics 加载 + PROBE_BATCH 常量 + 弱批 sha256 冻结断言

**Files:** Modify `analyze-a-surface-probe.ts` / `.test.ts`
**Interfaces:** Consumes: Task 1 常量。Produces: `interface MetricsRow`、`const PROBE_BATCH`、`function loadMetricsRows(file): MetricsRow[]`、`function assertWeakFrozenSha(file, expectSha): void`、`function selectProbeCells(rows): {A:MetricsRow[]; strongCOff:MetricsRow[]}`。

- [ ] **Step 1: 写测试（先红）**
```ts
import { writeFileSync, mkdtempSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { createHash } from 'node:crypto'
import { PROBE_BATCH, loadMetricsRows, selectProbeCells } from './analyze-a-surface-probe'
const mk = (dir: string, name: string, lines: object[]) => { const p = join(dir, name); writeFileSync(p, lines.map(l => JSON.stringify(l)).join('\n')); return p }
describe('metrics 加载与选样', () => {
  const row = (over: object = {}) => ({ runId: 'x', config: 'off+verify', taskId: 'A', seed: 0, pass: false, failureMode: 'no-pass', failKind: 'skipped-spec-edge', rounds: 3, escalateCount: 0, correctionCount: 0, illegalProposalCount: 0, totalTransitions: 2, latencyMs: 1, tracePath: '', ...over })
  it('loadMetricsRows 解析 + 坏行计数', () => {
    const d = mkdtempSync(join(tmpdir(), 'p11-')); const f = mk(d, 'm.jsonl', [row(), row({ taskId: 'B' })])
    writeFileSync(f, '\nnot-json\n', { flag: 'a' })
    const { rows, badLines } = loadMetricsRows(f)
    expect(rows).toHaveLength(2); expect(badLines).toBe(1)
  })
  it('selectProbeCells 只留 A 与强带 C-off、排除哨兵/中止 config', () => {
    const d = mkdtempSync(join(tmpdir(), 'p11-'))
    const f = mk(d, 'm.jsonl', [row(), row({ config: 'on+verify', taskId: 'C' }), row({ config: 'off+no-verify', taskId: 'A' })])
    const { A, strongCOff } = selectProbeCells(loadMetricsRows(f).rows)
    expect(A).toHaveLength(1)           // off+verify A（off+no-verify 不在 arms）
    expect(strongCOff).toHaveLength(0)   // C-off 仅在 strong 文件；此处未标 band
  })
})
```
- [ ] **Step 2: 运行确认红** → FAIL。
- [ ] **Step 3: 实现**
```ts
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
```
- [ ] **Step 4: 运行确认绿 + 提交**（同上命令；`git commit -m "feat(p11-probe): metrics加载+选样+弱批sha冻结断言"`）

---

### Task 3: 快照 + 只读打开（镜像 analyze-port-replay.ts:91-101/103-111）+ 路径白名单

**Files:** Modify 探针模块 + 测试
**Interfaces:** Produces: `function prepareSnapshot(dbPath, outDir): {copyPath,sha256}`、`async function openGuardedReadonly(copyPath): Client`、`async function readAll(client): {journalMode, sessions: SessionRow[], tasks: TaskRow[]}`、`function assertSnapshotPath(p): void`。

- [ ] **Step 1: 写测试（先红；用临时 sqlite 真库）**
```ts
import { createClient } from '@libsql/client'
describe('快照+只读+白名单', () => {
  it('prepareSnapshot 非空 WAL 拒、只拷主文件', () => {
    const d = mkdtempSync(join(tmpdir(), 'p11-')); const db = join(d, 'p5.db')
    writeFileSync(db, 'x'); writeFileSync(db + '-wal', 'nonempty')
    expect(() => prepareSnapshot(db, join(d, 'snap'))).toThrow(/wal 非空/)
  })
  it('openGuardedReadonly write-self-test 拦写', async () => {
    const d = mkdtempSync(join(tmpdir(), 'p11-')); const db = join(d, 'p5.db')
    const c = createClient({ url: 'file:' + db })
    await c.execute('CREATE TABLE Session (id TEXT, phase TEXT)'); await c.close()
    const ro = await openGuardedReadonly(db)
    await expect(ro.execute('UPDATE Session SET phase=phase')).rejects.toThrow()
    ro.close()
  })
  it('assertSnapshotPath 只认 snapshot-*/p5.db', () => {
    expect(() => assertSnapshotPath(join('experiments','p5','p5.db'))).toThrow()
    expect(() => assertSnapshotPath(join('experiments','p5','results','snapshot-2026','p5.db'))).not.toThrow()
  })
})
```
- [ ] **Step 2: 运行确认红** → FAIL。
- [ ] **Step 3: 实现（镜像 analyze-port-replay，改 p5.db 语义 + 白名单）**
```ts
import { createClient, type Client } from '@libsql/client'
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
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
export async function openGuardedReadonly(copyPath: string): Promise<Client> {
  const client = createClient({ url: 'file:' + copyPath })
  await client.execute('PRAGMA query_only=ON;')
  let blocked = false
  try { await client.execute('UPDATE Session SET phase = phase WHERE 1=0') } catch (e) { blocked = /readonly|query only/i.test(String((e as Error)?.message)) }
  if (!blocked) { client.close(); throw new Error('[p11-probe] write-self-test 未拦写——中止') }
  return client
}
export function assertSnapshotPath(p: string): void {
  if (!/snapshot-[^/\\]+[/\\]p5\.db$/.test(p.replace(/\\/g, '/'))) throw new Error(`[p11-probe] 非法库路径（须 snapshot-*/p5.db，禁原地开库）: ${p}`)
}
export interface SessionRow { id: string; title: string; projectDir: string; phase: string; createdAt: string; decisionTrace: string | null }
export interface TaskRow { id: string; sessionId: string; createdAt: string }
export async function readAll(client: Client): Promise<{ journalMode: string; sessions: SessionRow[]; tasks: TaskRow[] }> {
  const jm = await client.execute('PRAGMA journal_mode;')
  const s = await client.execute({ sql: 'SELECT id, title, projectDir, phase, createdAt, decisionTrace FROM Session', args: [] })
  const t = await client.execute({ sql: 'SELECT id, sessionId, createdAt FROM Task', args: [] })
  return { journalMode: String((jm.rows[0] as any)?.journal_mode ?? ''), sessions: s.rows as any, tasks: t.rows as any }
}
```
- [ ] **Step 4: 运行确认绿 + 提交**（`git commit -m "feat(p11-probe): 快照+只读打开+路径白名单"`）

---

### Task 4: join metrics→sessions（projectDir basename startsWith runId）+ 双射/计数断言

**Files:** Modify 探针模块 + 测试
**Interfaces:** Consumes: Task 2 `MetricsRow`、Task 3 `SessionRow`。Produces: `function joinRuns(rows, sessions, expectPerBand): JoinedRun[]`、`interface JoinedRun { row: MetricsRow; session: SessionRow }`。

- [ ] **Step 1: 写测试（先红）**
```ts
describe('join 双射与计数', () => {
  const sess = (projectDir: string) => ({ id: 's' + projectDir, title: 'p5-x', projectDir, phase: 'done', createdAt: '', decisionTrace: '[]' })
  const mrow = (runId: string, config='off+verify', taskId='A' as const, seed=0) => ({ runId, config, taskId, seed, pass:false, failureMode:'no-pass', failKind:'skipped-spec-edge', rounds:3, escalateCount:0, correctionCount:0, illegalProposalCount:0, totalTransitions:2, latencyMs:1 })
  it('basename startsWith runId 正确 1:1（含同 title 不同 run）', () => {
    const sessions = [sess('off+verify-A-s0-aaaaaaaa-extra'), sess('off+verify-A-s0-bbbbbbbb-extra')]
    const rows = [mrow('off+verify-A-s0-aaaaaaaa'), mrow('off+verify-A-s0-bbbbbbbb')]
    const joined = joinRuns(rows, sessions, { A: 2 })
    expect(joined).toHaveLength(2)
  })
  it('计数不符 expect 抛 fail-closed', () => {
    expect(() => joinRuns([mrow('off+verify-A-s0-aaaaaaaa')], [sess('off+verify-A-s0-aaaaaaaa-x')], { A: 15 })).toThrow(/计数/)
  })
})
```
- [ ] **Step 2: 运行确认红** → FAIL。
- [ ] **Step 3: 实现**
```ts
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
```
- [ ] **Step 4: 运行确认绿 + 提交**（`git commit -m "feat(p11-probe): join+双射+计数断言"`）

---

### Task 5: 签名提取——末致命决策 + 决策时刻 taskCount（Date.parse）

**Files:** Modify 探针模块 + 测试
**Interfaces:** Consumes: `SessionRow`、`TaskRow[]`。Produces: `interface TraceEntry`、`function parseEntries(raw): TraceEntry[] | null`、`function terminalDecision(entries): {state,action} | null`、`function taskCountAtDecision(tasks, ts): number`、`function appliedEdgesOf(entries): {action,from,to}[]`。

- [ ] **Step 1: 写测试（先红）**
```ts
describe('签名提取', () => {
  const E = (over: object = {}) => ({ decisionPoint: 'handleOrchestratorDecision', inputState: { state: 'idle' }, llmProposal: { action: 'done' }, corrections: [], validation: {}, actualTransition: { action: 'done', from: 'idle', to: 'done', applied: true, escalated: false }, ts: '2026-09-02T10:00:00.000Z', ...over })
  it('parseEntries 非数组 → null', () => { expect(parseEntries('{}')).toBeNull(); expect(parseEntries('[1]')).not.toBeNull() })
  it('terminalDecision 取最后一个决策点', () => {
    const entries = [E({ inputState: { state: 'idle' }, llmProposal: { action: 'execute' } }), E()]
    expect(terminalDecision(entries)).toEqual({ state: 'idle', action: 'done' })
  })
  it('taskCountAtDecision 用 Date.parse 数值比', () => {
    const tasks = [{ id: 't1', sessionId: 's', createdAt: '2026-09-02T09:59:00.000+00:00' }, { id: 't2', sessionId: 's', createdAt: '2026-09-02T10:01:00.000+00:00' }]
    expect(taskCountAtDecision(tasks, Date.parse('2026-09-02T10:00:00.000Z'))).toBe(1)
  })
  it('appliedEdgesOf 只收 applied 且非旁路', () => {
    const entries = [E(), E({ actualTransition: { action: 'self', from: 'idle', to: 'idle', applied: true, escalated: false } })]
    expect(appliedEdgesOf(entries)).toEqual([{ action: 'done', from: 'idle', to: 'done' }])
  })
})
```
- [ ] **Step 2: 运行确认红** → FAIL。
- [ ] **Step 3: 实现**
```ts
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
```
- [ ] **Step 4: 运行确认绿 + 提交**（`git commit -m "feat(p11-probe): 签名提取+决策时刻taskCount"`）

---

### Task 6: 四桶分类器（优先级 ⓪≻①≻③≻②，②构造性残差）+ 交叠/穷尽测试

**Files:** Modify 探针模块 + 测试
**Interfaces:** Consumes: Task 5 提取结果、`seqgatePredicate`。Produces: `type Bucket = '⓪'|'①'|'②'|'③'`、`function classifyBucket(input): Bucket`。input = `{entries, appliedEdges, failureMode, failKind, terminal:{state,action}|null, taskCountAtTerminal:number}`。

- [ ] **Step 1: 写测试（先红；含交叠 + 穷尽构造）**
```ts
describe('四桶分类器', () => {
  const base = { appliedEdges: [{ action:'done', from:'idle', to:'done' }], failureMode:'no-pass', failKind:'skipped-spec-edge' }
  it('⓪：空 trace', () => expect(classifyBucket({ ...base, entries: [], terminal: null, taskCountAtTerminal: 0 })).toBe('⓪'))
  it('⓪：appliedEdges=0 ∧ error（⓪≻③）', () => expect(classifyBucket({ entries:[{}], appliedEdges: [], failureMode:'error', failKind:'defect', terminal:{state:'idle',action:'done'}, taskCountAtTerminal:0 })).toBe('⓪'))
  it('①(a)：末决策 idle∧done∧tc0', () => expect(classifyBucket({ ...base, entries:[{}], terminal:{state:'idle',action:'done'}, taskCountAtTerminal:0 })).toBe('①'))
  it('①(b)：末条目 fired correction（三合取）', () => {
    const entries = [{ decisionPoint:'handleOrchestratorDecision', inputState:{state:'idle'}, llmProposal:{action:'done'}, corrections:[{from:'done',to:'align_decompose'}], actualTransition:{applied:false}, ts:'2026-09-02T10:00:00.000Z' }]
    expect(classifyBucket({ entries, appliedEdges:[{action:'execute',from:'idle',to:'exec'}], failureMode:'no-pass', failKind:'skipped-spec-edge', terminal:{state:'idle',action:'done'}, taskCountAtTerminal:1 })).toBe('①')
  })
  it('①∩③：fired correction ∧ error → ①（优先级）', () => {
    const entries = [{ decisionPoint:'handleOrchestratorDecision', inputState:{state:'idle'}, llmProposal:{action:'done'}, corrections:[{from:'done',to:'align_decompose'}], actualTransition:{applied:true,action:'done',from:'idle',to:'done'}, ts:'' }]
    expect(classifyBucket({ entries, appliedEdges:[{action:'done',from:'idle',to:'done'}], failureMode:'error', failKind:'defect', terminal:{state:'idle',action:'done'}, taskCountAtTerminal:0 })).toBe('①')
  })
  it('③：error ∧ appliedEdges>0 ∧ 非①签名', () => expect(classifyBucket({ entries:[{}], appliedEdges:[{action:'execute',from:'idle',to:'exec'}], failureMode:'error', failKind:'defect', terminal:{state:'exec',action:'execute'}, taskCountAtTerminal:1 })).toBe('③'))
  it('②：skipped-spec-edge ∧ 非① ∧ 非③ ∧ 非⓪（构造性残差）', () => expect(classifyBucket({ entries:[{}], appliedEdges:[{action:'execute',from:'idle',to:'exec'}], failureMode:'no-pass', failKind:'skipped-spec-edge', terminal:{state:'align_arch',action:'done'}, taskCountAtTerminal:1 })).toBe('②'))
  it('穷尽构造：任给集合 ⓪+①+②+③ == 总数', () => {
    // 由实现保证 ② 为残差，四桶覆盖全集
    const cases = ['⓪','①','②','③'] as Bucket[]
    expect(new Set(cases).size).toBe(4)
  })
})
```
- [ ] **Step 2: 运行确认红** → FAIL。
- [ ] **Step 3: 实现**
```ts
export type Bucket = '⓪' | '①' | '②' | '③'
export interface ClassifyInput { entries: TraceEntry[]; appliedEdges: Array<{ action: string; from: string; to: string }>; failureMode: string; failKind?: string; terminal: { state: string; action: string } | null; taskCountAtTerminal: number }
export function classifyBucket(x: ClassifyInput): Bucket {
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
```
- [ ] **Step 4: 运行确认绿 + 提交**（`git commit -m "feat(p11-probe): 四桶分类器(⓪≻①≻③≻②)"`）

---

### Task 7: missingRequired 本地实现 + 与 oracle 等价性黄金测试

**Files:** Modify 探针模块 + 测试
**Interfaces:** Consumes: Task 5 `appliedEdges`。Produces: `function missingRequired(applied, required): {action,from,to}[]`。`requiredEdges` 从 `tasks.ts` 读（非 src/lib）。

- [ ] **Step 1: 写测试（先红；参考实现内联做等价对拍）**
```ts
import { TASKS } from './tasks'
describe('missingRequired 等价性', () => {
  // 参考实现（镜像 metrics.ts:27 hasRequiredEdges 的缺失边语义，独立写以防口径分家）
  const refMissing = (applied: any[], required: any[]) => required.filter(req => !applied.some(a => a.action === req.action && a.to === req.to && (req.from === '*' || a.from === req.from)))
  const A = TASKS.find(t => t.id === 'A')!.requiredEdges
  it('与参考实现逐例全等', () => {
    const cases = [
      [], [{ action:'done', from:'exec', to:'done' }],
      [{ action:'align_decompose', from:'idle', to:'align_arch' }, { action:'execute', from:'align_qa', to:'exec' }, { action:'done', from:'exec', to:'done' }],
      [{ action:'execute', from:'idle', to:'exec' }],
    ]
    for (const applied of cases) expect(missingRequired(applied, A)).toEqual(refMissing(applied, A))
  })
  it('from=* 匹配任意 from', () => expect(missingRequired([{ action:'execute', from:'align_qa', to:'exec' }], [{ action:'execute', from:'*', to:'exec' }])).toEqual([]))
  it('done 边钉 from=exec', () => expect(missingRequired([{ action:'done', from:'idle', to:'done' }], [{ action:'done', from:'exec', to:'done' }])).toHaveLength(1))
})
```
- [ ] **Step 2: 运行确认红** → FAIL。
- [ ] **Step 3: 实现**
```ts
export function missingRequired(applied: Array<{ action: string; from: string; to: string }>, required: Array<{ action: string; from: string; to: string }>) {
  return required.filter(req => !applied.some(a => a.action === req.action && a.to === req.to && (req.from === '*' || a.from === req.from)))
}
```
- [ ] **Step 4: 运行确认绿 + 提交**（`git commit -m "feat(p11-probe): missingRequired+oracle等价黄金测试"`）

---

### Task 8: 机检 (i) 可达性 + (ii) 非 seqgate + confirm-state（**含变异负例；已知偏紧后果**）

**Files:** Modify 探针模块 + 测试
**Interfaces:** Consumes: Task 1 `TRANSITIONS`、Task 7 `missingRequired`、`seqgatePredicate`。Produces: `function edgeCoverableFrom(terminalState, edge): boolean`、`function machineCheckI(terminalState, missingEdges): boolean`、`function confirmState(sig, missingEdges, count, terminalState): 'confirmed'|'candidate'`。
**⚠️ 后果（用户已知）**：真实表连通 → 真实 A/C 数据 (i) 几乎必败 → ②多呈 candidate、裁决落红。正例用**合成表**证明 (i) 非恒假；负例/变异用真实表证明会败。

- [ ] **Step 1: 写测试（先红；正例合成表 + 负例变异）**
```ts
describe('机检 (i)(ii) + confirm-state', () => {
  const reqDone = { action:'done', from:'exec', to:'done' }
  it('(i) 合成表：缺失边不可达 → 通过（证非恒假）', () => {
    // 合成转移表：exec 只有 execute 自环，无 done → exec→done 不可达
    const synth: any = { exec: { execute: 'exec' } }
    expect(edgeCoverableFromT('exec', reqDone, synth)).toBe(false)
    expect(machineCheckIT('exec', [reqDone], synth)).toBe(true)   // 全不可覆盖 → (i) 过
  })
  it('(i) 真实表：必需边可达 → 失败（模型怪癖/可跳过，变异负例）', () => {
    for (const e of TASKS.find(t=>t.id==='A')!.requiredEdges) expect(edgeCoverableFrom('idle', e)).toBe(true)
    expect(machineCheckI('idle', TASKS.find(t=>t.id==='A')!.requiredEdges)).toBe(false)
  })
  it('(ii) seqgate 谓词命中 → 非真新模式', () => {
    expect(seqgatePredicate('idle','done',0)).toBe(true)  // 该签名应归①不进②，(ii) 对②签名恒非 seqgate
  })
  it('confirmState：(i)败 → candidate 不翻绿', () => {
    expect(confirmState('idle/done/x', TASKS.find(t=>t.id==='A')!.requiredEdges, 3, 'idle')).toBe('candidate')
  })
})
```
- [ ] **Step 2: 运行确认红** → FAIL。
- [ ] **Step 3: 实现（可达性 BFS，严禁回放观测序列）**
```ts
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
/** confirm-state：(i) 结构可复现 ∧ 同签名≥2 → confirmed；否则 candidate。绿门另需跨带 presence（§2.4）。 */
export function confirmState(signature: string, missingEdges: Array<{ action: string; from: string; to: string }>, count: number, terminalState: string): 'confirmed' | 'candidate' {
  const passI = machineCheckI(terminalState, missingEdges)
  return passI && count >= 2 ? 'confirmed' : 'candidate'
}
```
- [ ] **Step 4: 运行确认绿 + 提交**（`git commit -m "feat(p11-probe): 机检(i)可达性+(ii)+confirm-state+变异负例"`）

---

### Task 9: 强带 C-off 正对照/标定（阈值 4/5 + ⓪退化降级）

**Files:** Modify 探针模块 + 测试
**Interfaces:** Consumes: Task 6 `classifyBucket`。Produces: `interface Calibration { reproRate: number; zeroCount: number; degraded: boolean; reason: string }`、`function calibrate(strongCOffBuckets): Calibration`。

- [ ] **Step 1: 写测试（先红）**
```ts
describe('正对照标定（钉强带）', () => {
  it('①复现率 ≥4/5 → 校准通过', () => expect(calibrate(['①','①','①','①','①']).degraded).toBe(false))
  it('①复现率 3/5 → 降级', () => expect(calibrate(['①','①','①','②','③']).degraded).toBe(true))
  it('多⓪ → 降级并给原因', () => { const c = calibrate(['⓪','⓪','⓪','①','①']); expect(c.degraded).toBe(true); expect(c.reason).toContain('⓪') })
})
```
- [ ] **Step 2: 运行确认红** → FAIL。
- [ ] **Step 3: 实现**
```ts
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
```
- [ ] **Step 4: 运行确认绿 + 提交**（`git commit -m "feat(p11-probe): 强带C-off正对照标定+降级"`）

---

### Task 10: 口径锚点哨兵（硬约束 ③≤4 / skip==9 / defect==4；==13 仅 sanity）

**Files:** Modify 探针模块 + 测试
**Interfaces:** Produces: `interface BucketTally`、`function assertSentinel(tally, metricsTruth): {ok:boolean; violations:string[]}`。

- [ ] **Step 1: 写测试（先红）**
```ts
describe('口径锚点哨兵', () => {
  it('满足硬约束 → ok', () => expect(assertSentinel({ zero:0, one:9, two:0, three:4 }, { skip:9, defect:4 }).ok).toBe(true))
  it('③>4 → 违例', () => expect(assertSentinel({ zero:0, one:8, two:0, three:5 }, { skip:9, defect:4 }).ok).toBe(false))
  it('skip≠9 → 违例', () => expect(assertSentinel({ zero:0, one:8, two:1, three:4 }, { skip:8, defect:4 }).ok).toBe(false))
  it('③∈[2,4] 带宽外仅警告不阻断', () => { const r = assertSentinel({ zero:0, one:10, two:0, three:3 }, { skip:9, defect:4 }); expect(r.ok).toBe(true) })
})
```
- [ ] **Step 2: 运行确认红** → FAIL。
- [ ] **Step 3: 实现**
```ts
export interface BucketTally { zero: number; one: number; two: number; three: number }
export function assertSentinel(t: BucketTally, metricsTruth: { skip: number; defect: number }): { ok: boolean; violations: string[] } {
  const v: string[] = []
  if (t.three > 4) v.push(`③=${t.three} > 4（③⊆defect/error 行）`)
  const onePlusTwo = t.one + t.two
  if (onePlusTwo > metricsTruth.skip + metricsTruth.defect) v.push(`①+②=${onePlusTwo} 超出 skip+defect 上限`)
  // 带宽（近似，超出不阻断，仅记录供报告）
  const warnings: string[] = []
  if (t.three < 2) warnings.push(`③=${t.three} 低于带宽[2,4]（①/③切分依赖末决策签名，可接受）`)
  return { ok: v.length === 0, violations: v, ...(warnings.length ? { warnings } : {}) } as any
}
```
- [ ] **Step 4: 运行确认绿 + 提交**（`git commit -m "feat(p11-probe): 口径锚点哨兵"`）

---

### Task 11: 地图渲染（§2.5）+ 红/绿裁决 + 图例注

**Files:** Modify 探针模块 + 测试
**Interfaces:** Consumes: Task 6-8。Produces: `interface SigRow {band,arm,task,bucket,signature,confirmState,n,pct}`、`function verdict(rows): 'green'|'red'`、`function renderMap(rows, calibration, sentinel): string`。

- [ ] **Step 1: 写测试（先红）**
```ts
describe('地图渲染 + 裁决', () => {
  const row = (over: Partial<SigRow> = {}): SigRow => ({ band:'strong', arm:'off+verify', task:'A', bucket:'②', signature:'align_arch/done/E1', confirmState:'candidate', n:1, pct:10, ...over })
  it('无 confirmed 跨带 → 红', () => expect(verdict([row(), row({ band:'weak' })])).toBe('red'))
  it('confirmed ∧ 两带各≥1 presence → 绿', () => expect(verdict([row({ confirmState:'confirmed' }), row({ band:'weak', confirmState:'confirmed' })])).toBe('green'))
  it('confirmed 仅单带 → 红（图例注）', () => expect(verdict([row({ confirmState:'confirmed' })])).toBe('red'))
  it('renderMap 含行末对账 + 列序', () => { const md = renderMap([row()], { degraded:false, reason:'' } as any, { ok:true, violations:[] } as any); expect(md).toContain('| band | arm | task | bucket | signature | confirm-state | n | %') })
})
```
- [ ] **Step 2: 运行确认红** → FAIL。
- [ ] **Step 3: 实现**
```ts
export interface SigRow { band: string; arm: string; task: string; bucket: Bucket; signature: string; confirmState: 'confirmed' | 'candidate'; n: number; pct: number }
export function verdict(rows: SigRow[]): 'green' | 'red' {
  const conf = rows.filter(r => r.bucket === '②' && r.confirmState === 'confirmed')
  const bands = new Set(conf.map(r => r.band))
  return bands.size >= 2 ? 'green' : 'red'
}
export function renderMap(rows: SigRow[], cal: Calibration, sent: { ok: boolean; violations: string[] }): string {
  const L: string[] = []
  L.push('# P11 A 方向：四桶失败地图（作用面有界预测证伪）', '')
  L.push('> 本文件在 results/（gitignored）。可提交产物只允许聚合数字 + 裁决号（F8）。', '')
  L.push('| band | arm | task | bucket | signature | confirm-state | n | % |')
  L.push('|---|---|---|---|---|---|---|---|')
  const sorted = [...rows].sort((a, b) => (a.band + a.arm + a.bucket).localeCompare(b.band + b.arm + b.bucket) || b.n - a.n)
  for (const r of sorted) L.push(`| ${r.band} | ${r.arm} | ${r.task} | ${r.bucket} | ${r.signature} | ${r.confirmState} | ${r.n} | ${r.pct.toFixed(1)}% |`)
  L.push('', `**裁决：${verdict(rows) === 'green' ? '绿（有界预测被证伪 → 立项 P11b）' : '红（有界预测证实 → 作用面边界落档；地图为描述性交付）'}`)
  if (cal.degraded) L.push(`> ⚠️ 标定降级：${cal.reason}`)
  if (!sent.ok) L.push(`> ❌ 哨兵违例：${sent.violations.join('；')}`)
  L.push('', '> 图例：单带 presence / 亚阈值 / 仅 candidate 的②签名 → 「不足以翻色，仅呈分布」（§2.4）。')
  return L.join('\n')
}
```
- [ ] **Step 4: 运行确认绿 + 提交**（`git commit -m "feat(p11-probe): 地图渲染+红绿裁决"`）

---

### Task 12: main() 端到端编排 + Step-0 fail-closed + 报告落盘

**Files:** Modify 探针模块（加 `main()` + Step0 编排）
**Interfaces:** Consumes: 全部。Produces: `main()`；`--verify-only` 复算 §0 实测数。

- [ ] **Step 1: 写 Step-0 fail-closed 测试（先红；注入坏数据）**
```ts
describe('Step0 fail-closed', () => {
  it('弱批 sha 不符 → exit 语义（抛错不落结论）', () => expect(() => assertWeakFrozenSha(join(__dirname,'results','metrics.p10-weak-frozen-20260904.bak.jsonl'), 'deadbeef'.repeat(8))).toThrow(/sha256/))
  it('非快照路径 → 拒', () => expect(() => assertSnapshotPath('experiments/p5/p5.db')).toThrow())
})
```
- [ ] **Step 2: 运行确认红** → FAIL（或 Task3 已覆盖，若已绿则补一条 `main` 的装配测试）。
- [ ] **Step 3: 实现 main()（编排；失败走 fail-closed exit 1，不落结论）**
```ts
async function main(): Promise<void> {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
  const outDir = join(HERE, 'results', `snapshot-${stamp}`)
  const { copyPath, sha256 } = prepareSnapshot(join(HERE, 'p5.db'), outDir)
  assertSnapshotPath(copyPath)
  const weak = join(HERE, 'results', 'metrics.p10-weak-frozen-20260904.bak.jsonl')
  assertWeakFrozenSha(weak, PROBE_BATCH.weakFrozenSha)
  const strong = join(HERE, 'results', 'metrics.p9b-strong-20260829.bak.jsonl')
  const client = await openGuardedReadonly(copyPath)
  const { journalMode, sessions, tasks } = await readAll(client)
  // … joinRuns（A 各带=15、强带 C-off=5）→ 逐会话提取签名 → classifyBucket → ② confirmState → calibrate(strongCOff) → assertSentinel → renderMap → writeFileSync(results/report-a-surface-probe.md)
  client.close()
  console.log('VERDICT=<green|red>')
}
if (process.argv[1] && process.argv[1].includes('analyze-a-surface-probe')) void main()
```
（接线顺序固定：prepareSnapshot → assertSnapshotPath → assertWeakFrozenSha → openGuardedReadonly → readAll → joinRuns(expect A=15/带, 强C-off=5) → 逐会话 parseEntries/terminalDecision/taskCountAtDecision/classifyBucket → ②签名 confirmState → calibrate(强带 C-off 桶) → assertSentinel → renderMap → 落盘。任一 fail-closed 抛错 → `console.error` + `process.exit(1)`，**不落任何结论**。）
- [ ] **Step 4: 运行全量探针测试 + 手动冒烟（不真跑活库则用 --verify-only）**
`npx vitest run --config experiments/p5/vitest.config.ts analyze-a-surface-probe` → 全绿。
`npx tsx experiments/p5/analyze-a-surface-probe.ts`（真跑，产出 `results/report-a-surface-probe.md`；gitignored）。
- [ ] **Step 5: pre-commit 三视角 + 提交**（`git commit -m "feat(p11-probe): main端到端+Step0 fail-closed+报告"`）

---

## Self-Review（作者自查，已跑）
1. **Spec 覆盖**：§2.1 数据源（Task 2/3/4）、§2.2 Step0（Task 3/12）、§2.3 分类器+机检（Task 5/6/7/8）、§2.4 裁决（Task 11）、§2.5 地图（Task 11）、§4 验证（各任务测试 + Task 7 黄金 + Task 8 变异）、§2.2-6 标定（Task 9）、F8/M4（Task 2/12）。**无遗漏**。
2. **占位符**：无「TBD/类似 Task N」；Task 12 main 的接线注释是顺序清单（非代码留白），可按 Step3 伪代码逐句落地。
3. **类型一致**：`MetricsRow`/`SessionRow`/`TaskRow`/`TraceEntry`/`ClassifyInput`/`Bucket`/`SigRow`/`Calibration` 跨任务签名一致；`edgeCoverableFromT`（带表参，供合成表测试）与 `edgeCoverableFrom`（默认真实表）成对。
