# P9-丙 跨批分析 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 纯离线分析三批实验数据（jsonl 快照层 + p5.db 回放层），产出 `results/report-cross-batch.md`：统一指纹表、corrections 成分分解、缺边类型学、批次健康检查、H1′ 作用面结论、P6 溯源对照。

**Architecture:** 单一新文件 `analyze-cross-batch.ts` 按「加载 → 聚合 → 健康检查 → DB 回放 → 渲染」五段纯函数组织，每段独立可测；CLI 入口 `main()` 串接落盘报告。零生产代码改动、零新增依赖。

**Tech Stack:** TypeScript + vitest；DB 经既有依赖 `@libsql/client`（SELECT-only 包装）。

**上游 spec:** `docs/superpowers/specs/2026-08-23-p9-surface-matrix-design.md`（§4.1 全部六项交付物 + §8 审查 F5/F7/F8 条款）

## Global Constraints

- 生产 `src/lib` 零改动；本计划只碰 `experiments/p5/`
- 只读纪律：仅读取 `results/*.jsonl` 与 `p5.db`（SELECT-only），禁止任何 DB 写入
- 禁止 `eval` / `new Function` / 动态 import 处理解析内容（spec §8 F5a）
- 禁止新增任何依赖（含 devDependencies）；DB 只用已有 `@libsql/client`
- 加载器 total 不 throw：单行损坏跳过并计数，不丢整批
- 统一口径：非法尝试率 OFF 格取 `illegalProposalCount`、ON 格取 `correctionCount`（`report.ts:109` 既有定义）
- 注释与报告文案用中文，匹配仓库风格
- commit 一律 `--no-verify`（pre-commit hook 要求的审计已由本计划的 SDD 评审承担，沿 P7 先例）

## File Structure

| 文件 | 职责 |
|---|---|
| `experiments/p5/analyze-cross-batch.ts`（新建） | 五段纯函数 + 类型 + `main()` 入口 |
| `experiments/p5/analyze-cross-batch.test.ts`（新建） | 单测（inline fixture）+ 真实数据集成测试（skipIf 文件缺失） |
| `experiments/p5/results/report-cross-batch.md`（运行产物，gitignored） | 最终报告 |

---

### Task 1: 批次加载器（schema 归一 + total 解析）

**Files:**
- Create: `experiments/p5/analyze-cross-batch.ts`（初始骨架 + 加载段）
- Test: `experiments/p5/analyze-cross-batch.test.ts`

**Interfaces:**
- Produces:

```ts
export type BatchId = 'P6' | 'P7' | 'P8'
export interface NormRow {
  batch: BatchId; runId: string; config: string; taskId: string; seed: number
  pass: boolean; failureMode: string
  failKind: string | null          // null = 该行 schema 无此字段（报告记 n/a）
  rounds: number; escalateCount: number
  correctionCount: number; illegalProposalCount: number
  totalTransitions: number; latencyMs: number
}
export const BATCH_FILES: Record<BatchId, string>   // 相对 resultsDir 的文件名
export function loadBatchRows(batch: BatchId, filePath: string): { rows: NormRow[]; badLines: number }
```

- [ ] **Step 0: 选定运行器**

查看 `package.json` scripts 是否已有 tsx/ts-node 类 runner：
```bash
cd /d/ai全栈挑战赛/agenthub && cat package.json | head -40
```
有 → 记录用它直接跑 TS；没有 → 所有执行统一走 `npx vitest run <file>`（harness 惯例），`main()` 由 Task 6 的集成测试触发，不单独造 runner、不装新依赖。

- [ ] **Step 1: 写失败测试**

```ts
import { describe, it, expect } from 'vitest'
import { writeFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { loadBatchRows } from './analyze-cross-batch'

describe('loadBatchRows', () => {
  it('解析标准行（无 failKind 键 → null，与 P6 整批同型）', () => {
    const tmp = join(import.meta.dirname, '.__fixture-t1.jsonl')
    writeFileSync(tmp,
      '{"runId":"r1","config":"on+verify","taskId":"A","seed":0,"pass":true,"failureMode":"pass","rounds":3,"escalateCount":0,"correctionCount":1,"illegalProposalCount":0,"totalTransitions":2,"latencyMs":100,"tracePath":""}\n')
    const { rows, badLines } = loadBatchRows('P8', tmp)
    expect(badLines).toBe(0)
    expect(rows).toHaveLength(1)
    expect(rows[0].failKind).toBeNull()
    expect(rows[0]).toMatchObject({ batch: 'P8', config: 'on+verify', pass: true })
    unlinkSync(tmp)
  })

  it('坏行跳过计数不 throw（total 语义）', () => {
    const tmp = join(import.meta.dirname, '.__fixture-t1b.jsonl')
    writeFileSync(tmp, '{broken json\n{"runId":"r2","config":"off+verify","taskId":"B","seed":1,"pass":false,"failureMode":"no-pass","rounds":2,"escalateCount":0,"correctionCount":0,"illegalProposalCount":3,"totalTransitions":1,"latencyMs":50,"tracePath":"","failKind":"defect"}\n')
    const { rows, badLines } = loadBatchRows('P7', tmp)
    expect(badLines).toBe(1)
    expect(rows).toHaveLength(1)
    expect(rows[0].failKind).toBe('defect')
    unlinkSync(tmp)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run experiments/p5/analyze-cross-batch.test.ts`
Expected: FAIL（模块不存在或 loadBatchRows 未导出）

- [ ] **Step 3: 最小实现**

```ts
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
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run experiments/p5/analyze-cross-batch.test.ts`
Expected: PASS ×2

- [ ] **Step 5: Commit**

```bash
git add experiments/p5/analyze-cross-batch.ts experiments/p5/analyze-cross-batch.test.ts
git commit --no-verify -m "feat(p5): P9-丙 T1 批次加载器（schema归一+total解析）"
```

---

### Task 2: 指纹聚合器 + 已知数字快照集成测试

**Files:**
- Modify: `experiments/p5/analyze-cross-batch.ts`（追加聚合段）
- Test: `experiments/p5/analyze-cross-batch.test.ts`（追加）

**Interfaces:**
- Consumes: `NormRow`, `loadBatchRows`, `BATCH_FILES`
- Produces:

```ts
export interface CellFingerprint {
  n: number; pass: number; skip: number; defect: number; failKindOther: number; failKindNA: number
  corrSum: number; illSum: number; escSum: number
  sumRounds: number; sumTrans: number
}
export function fingerprintKey(config: string, taskId: string): string   // `${config}|${taskId}`
export function aggregateFingerprints(rows: NormRow[]): Map<string, CellFingerprint>
```
skip 计 `failKind==='skipped-spec-edge'`、defect 计 `'defect'`、其余非空入 `failKindOther`（如 done-but-conformance）、null 入 `failKindNA`（P6 列）。

- [ ] **Step 1: 写失败测试（单测 fixture + 真实数据快照双组）**

```ts
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { loadBatchRows, aggregateFingerprints, fingerprintKey, BATCH_FILES } from './analyze-cross-batch'

describe('aggregateFingerprints（inline fixture）', () => {
  it('按 config×task 聚合且 failKind 分列', () => {
    const rows = [
      { batch: 'P8', runId: 'a', config: 'on+verify', taskId: 'A', seed: 0, pass: false, failureMode: 'no-pass', failKind: 'skipped-spec-edge' as const, rounds: 3, escalateCount: 0, correctionCount: 2, illegalProposalCount: 0, totalTransitions: 2, latencyMs: 1 },
      { batch: 'P8', runId: 'b', config: 'on+verify', taskId: 'A', seed: 1, pass: true, failureMode: 'pass', failKind: null, rounds: 4, escalateCount: 0, correctionCount: 1, illegalProposalCount: 0, totalTransitions: 5, latencyMs: 1 },
      { batch: 'P8', runId: 'c', config: 'off+verify', taskId: 'A', seed: 0, pass: false, failureMode: 'no-pass', failKind: 'defect' as const, rounds: 6, escalateCount: 0, correctionCount: 0, illegalProposalCount: 4, totalTransitions: 0, latencyMs: 1 },
    ]
    const m = aggregateFingerprints(rows)
    const on = m.get(fingerprintKey('on+verify', 'A'))!
    expect(on).toMatchObject({ n: 2, pass: 1, skip: 1, corrSum: 3 })
    const off = m.get(fingerprintKey('off+verify', 'A'))!
    expect(off).toMatchObject({ n: 1, defect: 1, illSum: 4 })
  })
})

const resultsDir = 'D:/ai全栈挑战赛/agenthub/experiments/p5/results'
const p8 = join(resultsDir, BATCH_FILES.P8)
describe.skipIf(!existsSync(p8))('aggregateFingerprints（真实数据快照，已独立复算背书）', () => {
  it('P8 总量与 ON corr 口径', () => {
    const { rows } = loadBatchRows('P8', p8)
    expect(rows).toHaveLength(60)
    const m = aggregateFingerprints(rows)
    let pass = 0, skip = 0, defect = 0, onCorr = 0, offIll = 0
    for (const [k, v] of m) {
      pass += v.pass; skip += v.skip; defect += v.defect
      if (k.startsWith('on+')) onCorr += v.corrSum; else offIll += v.illSum
    }
    expect(pass).toBe(22); expect(skip).toBe(23); expect(defect).toBe(15)
    expect(onCorr).toBe(6); expect(offIll).toBe(6)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run experiments/p5/analyze-cross-batch.test.ts`
Expected: 新增两组 FAIL（aggregateFingerprints 未导出）

- [ ] **Step 3: 最小实现**

```ts
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
```

- [ ] **Step 4: 跑测试确认通过（含真实快照）**

Run: `npx vitest run experiments/p5/analyze-cross-batch.test.ts`
Expected: PASS 全绿（若真实快照断言失败，先怀疑实现而非数据——数字已被独立复核）

- [ ] **Step 5: Commit**

```bash
git add experiments/p5/analyze-cross-batch.ts experiments/p5/analyze-cross-batch.test.ts
git commit --no-verify -m "feat(p5): P9-丙 T2 指纹聚合器+真实数据快照测试"
```

---

### Task 3: 批次污染检测函数

**Files:**
- Modify: `experiments/p5/analyze-cross-batch.ts`
- Test: `experiments/p5/analyze-cross-batch.test.ts`

**Interfaces:**
- Produces:

```ts
export interface ContaminationResult {
  contaminated: boolean; avgTrans: number; defectRatio: number; roundsFullRatio: number
}
export function detectBatchContamination(rows: NormRow[], opts?: {
  avgTransMax?: number; defectRatioMin?: number; roundsFullRatioMin?: number; roundsFullFloor?: number
}): ContaminationResult
```
默认阈值（JSDoc 写明校准依据）：`avgTransMax=1.0`（quota-dead 实测 avgTrans≈0.0-0.4，有效批 ≈2.3-4.3）、`defectRatioMin=0.8`（quota-dead 29/30≈0.97，有效批 ≤0.25）、`roundsFullRatioMin=0.5`、`roundsFullFloor=6`（各批 maxRounds 6-7 取下限）。三条件 AND 才判污染，防单一指标误伤。

- [ ] **Step 1: 写失败测试**

```ts
import { detectBatchContamination } from './analyze-cross-batch'

type Row = Parameters<typeof detectBatchContamination>[0][number]
const mkRow = (over: Partial<Row> = {}): Row =>
  ({ batch: 'P8', runId: 'x', config: 'off+verify', taskId: 'A', seed: 0, pass: false, failureMode: 'no-pass', failKind: 'defect', rounds: 6, escalateCount: 0, correctionCount: 0, illegalProposalCount: 0, totalTransitions: 0, latencyMs: 1, ...over })

describe('detectBatchContamination（quota-dead 校准签名）', () => {
  it('污染形态：trans≈0 + rounds 打满 + defect 灌满 → true', () => {
    const rows = Array.from({ length: 10 }, (_, i) => mkRow({ runId: `d${i}` }))
    expect(detectBatchContamination(rows).contaminated).toBe(true)
  })
  it('有效形态（混合 pass/skip，正常 trans）→ false', () => {
    const rows = [
      mkRow({ runId: 'p1', pass: true, failureMode: 'pass', failKind: null, rounds: 4, totalTransitions: 5 }),
      mkRow({ runId: 'p2', failKind: 'skipped-spec-edge', rounds: 3, totalTransitions: 3 }),
      mkRow({ runId: 'p3', failKind: 'skipped-spec-edge', rounds: 5, totalTransitions: 4 }),
    ]
    expect(detectBatchContamination(rows).contaminated).toBe(false)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run experiments/p5/analyze-cross-batch.test.ts`
Expected: FAIL（未导出）

- [ ] **Step 3: 实现**

```ts
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
```

- [ ] **Step 4: 追加真实数据双向校验**

```ts
const pDead = join(resultsDir, 'metrics.p8-attempt1-quota-dead-20260822.jsonl')
describe.skipIf(!existsSync(pDead))('detectBatchContamination（真实批双向断言）', () => {
  it('quota-dead 阳性 / p8-final 阴性', () => {
    expect(detectBatchContamination(loadBatchRows('P8', pDead).rows).contaminated).toBe(true)
    expect(detectBatchContamination(loadBatchRows('P8', p8).rows).contaminated).toBe(false)
  })
})
```

- [ ] **Step 5: 跑全部测试通过 → Commit**

```bash
git add experiments/p5/analyze-cross-batch.ts experiments/p5/analyze-cross-batch.test.ts
git commit --no-verify -m "feat(p5): P9-丙 T3 批次污染检测（quota-dead 校准）"
```

---

### Task 4: DB 回放层（只读包装 + 成分分类器 + 缺边类型学）

**Files:**
- Modify: `experiments/p5/analyze-cross-batch.ts`
- Test: `experiments/p5/analyze-cross-batch.test.ts`

**Interfaces:**
- Consumes: `@libsql/client`（既有依赖）；`./tasks` 的 TASKS（requiredEdges 唯一权威）；`../../src/lib/orchestrator/state-machine` 的 NON_TRANSITIONING（只读消费）
- Produces:

```ts
export interface ReadonlyDb { select<T = Record<string, unknown>>(sql: string): Promise<T[]> }
export function createReadonlyDb(dbUrl: string): ReadonlyDb
// 仅放行 /^\s*(select|with)\b/i，否则 throw Error('只读违规: …')

export interface SessionRef { id: string; title: string; createdAt: string; dayGroup: string }
export async function probeExperimentSessions(db: ReadonlyDb): Promise<SessionRef[]>
// SELECT id,title,createdAt FROM Session WHERE title LIKE 'p5-%' ORDER BY createdAt
// dayGroup=createdAt 前10字符；批次归属=dayGroup 分组×标题交叉核对 metrics 行数，不硬编码日期窗口

export type CorrectionSource = 'canonical' | 'gate' | 'done-guard'
export interface TraceEntryLite {
  inputState: { state?: string }
  llmProposal: { action?: string }
  corrections: Array<{ from?: string; to?: string }>
}
export function classifyCorrections(entry: TraceEntryLite): CorrectionSource[]
export function findMissingEdges(
  appliedEdges: Array<{ action: string; from: string; to: string }>,
  requiredEdges: Array<{ action: string; from: string; to: string }>,
): Array<{ action: string; from: string; to: string }>
export interface MissingEdgeFinding {
  sessionId: string; title: string; dayGroup: string
  appliedEdges: Array<{ action: string; from: string; to: string }>
  missingRequired: Array<{ action: string; from: string; to: string }>
  doneEdgeAppliedFromExec: boolean
  correctionSources: Record<CorrectionSource, number>
}
export async function analyzeSessionTrace(db: ReadonlyDb, ref: SessionRef): Promise<MissingEdgeFinding | null>
```

- [ ] **Step 1: 写失败测试（分类器五分支 + 缺边判定）**

```ts
import { classifyCorrections, findMissingEdges } from './analyze-cross-batch'

describe('classifyCorrections（结构化定源，镜像 chat-router 顺序）', () => {
  it('idle 直发 execute 被 gate 重定向', () => {
    expect(classifyCorrections({ inputState: { state: 'idle' }, llmProposal: { action: 'execute' }, corrections: [{ from: 'execute', to: 'align_decompose' }] })).toEqual(['gate'])
  })
  it('align_pm 提议 done → 规则1 canonical', () => {
    expect(classifyCorrections({ inputState: { state: 'align_pm' }, llmProposal: { action: 'done' }, corrections: [{ from: 'done', to: 'align_decompose' }] })).toEqual(['canonical'])
  })
  it('align_arch 提议 done→execute 归 canonical（状态区分于 done-guard）', () => {
    expect(classifyCorrections({ inputState: { state: 'align_arch' }, llmProposal: { action: 'done' }, corrections: [{ from: 'done', to: 'execute' }] })).toEqual(['canonical'])
  })
  it('exec 态提议 done 且被守卫拦 → done-guard', () => {
    expect(classifyCorrections({ inputState: { state: 'exec' }, llmProposal: { action: 'done' }, corrections: [{ from: 'done', to: 'execute' }] })).toEqual(['done-guard'])
  })
  it('exec 态提议 align_qa → 规则2 canonical', () => {
    expect(classifyCorrections({ inputState: { state: 'exec' }, llmProposal: { action: 'align_qa' }, corrections: [{ from: 'align_qa', to: 'execute' }] })).toEqual(['canonical'])
  })
})

describe('findMissingEdges（通配 from 匹配 + done 边钉 exec）', () => {
  it('缺 execute 且 done 从非 exec 发出不满足', () => {
    const req = [
      { action: 'align_decompose', from: '*', to: 'align_arch' },
      { action: 'execute', from: '*', to: 'exec' },
      { action: 'done', from: 'exec', to: 'done' },
    ]
    const applied = [
      { action: 'align_decompose', from: 'idle', to: 'align_arch' },
      { action: 'done', from: 'align_arch', to: 'done' },
    ]
    expect(findMissingEdges(applied, req)).toEqual([
      { action: 'execute', from: '*', to: 'exec' },
      { action: 'done', from: 'exec', to: 'done' },
    ])
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run experiments/p5/analyze-cross-batch.test.ts`
Expected: 新增 FAIL

- [ ] **Step 3: 实现**

```ts
import { createClient } from '@libsql/client' // 既有依赖；只 SELECT（spec §8 F5c）
import { TASKS } from './tasks'
import { NON_TRANSITIONING } from '../../src/lib/orchestrator/state-machine' // 只读消费类型常量，非生产改动

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
  inputState: { state?: string }
  llmProposal: { action?: string }
  corrections: Array<{ from?: string; to?: string }>
}

/** 结构化定源（spec §8 F7）：不用 reason 子串。逐条模拟 chat-router 决策点顺序，
 *  按 (from,to)+状态定源：execute→align_decompose 唯一来源是闸门；
 *  done→execute 在 exec 态是 done 守卫、在 align_* 态是规则1。分类后 sim=corr.to 继续 redirect 链。 */
export function classifyCorrections(entry: TraceEntryLite): CorrectionSource[] {
  const out: CorrectionSource[] = []
  let sim = entry.llmProposal.action ?? ''
  const st = entry.inputState.state ?? ''
  for (const c of entry.corrections) {
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
    if (at?.applied === true && at.action && !NON_TRANSITIONING.has(at.action)) {
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
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run experiments/p5/analyze-cross-batch.test.ts`
Expected: PASS 全绿

- [ ] **Step 5: Commit**

```bash
git add experiments/p5/analyze-cross-batch.ts experiments/p5/analyze-cross-batch.test.ts
git commit --no-verify -m "feat(p5): P9-丙 T4 DB回放层（只读包装+成分分类器+缺边类型学）"
```

---

### Task 5: 报告渲染器（六章 + P6 溯源对照）

**Files:**
- Modify: `experiments/p5/analyze-cross-batch.ts`
- Test: `experiments/p5/analyze-cross-batch.test.ts`

**Interfaces:**
- Consumes: T1-T4 全部导出
- Produces:

```ts
export function sanitizeIdentifier(s: string): string   // [^A-Za-z0-9._+-] → '_'（spec §8 F5b）
export interface CrossBatchInput {
  fingerprints: Map<string, CellFingerprint>
  contamination: Record<BatchId, ContaminationResult>
  findings: MissingEdgeFinding[]
  badLineCounts: Record<BatchId, number>
  sessionDayGroups: Array<{ day: string; count: number }>
}
export function renderCrossBatchReport(input: CrossBatchInput): string
```

章节顺序固定：`批次健康检查` → `统一指纹表` → `corrections 成分分解` → `缺边类型学` → `H1′ 作用面结论` → `P6 溯源对照`。固定文案要求：指纹表头注明「口径 OFF=ill ON=corr」；P6 行脚注「罐头引导期，不作 provider 对照」；成分分解节带 decisionTrace 500 封顶脚注；P6 对照节硬编码 report.p6 权威数组（自 `report.p6-20260816.md:13-24` 抄录：on+verify A[1,1,1,1,1] B[1,1,1,1,1] C[1,0,1,0,0]，on+no-verify 同前两组 C 全 0，off 两组 A/B 全 1 C 全 0）并与 jsonl 实数并列点名差异。

- [ ] **Step 1: 写失败测试**

```ts
import { renderCrossBatchReport, sanitizeIdentifier } from './analyze-cross-batch'

describe('sanitizeIdentifier', () => {
  it('消毒路径穿越与特殊字符', () => {
    expect(sanitizeIdentifier('../../etc')).not.toContain('/')
    expect(sanitizeIdentifier('on+verify|A')).toBe('on+verify_A')
  })
})

describe('renderCrossBatchReport', () => {
  it('包含六个必备章节与固定脚注', () => {
    const md = renderCrossBatchReport({
      fingerprints: new Map(),
      contamination: {
        P6: { contaminated: false, avgTrans: 2.7, defectRatio: 0, roundsFullRatio: 0 },
        P7: { contaminated: false, avgTrans: 2.3, defectRatio: 0.15, roundsFullRatio: 0 },
        P8: { contaminated: false, avgTrans: 3.7, defectRatio: 0.25, roundsFullRatio: 0.08 },
      },
      findings: [], badLineCounts: { P6: 0, P7: 0, P8: 0 }, sessionDayGroups: [],
    })
    for (const h of ['批次健康检查', '统一指纹表', 'corrections 成分分解', '缺边类型学', 'H1′ 作用面结论', 'P6 溯源对照']) expect(md).toContain(h)
    expect(md).toContain('罐头引导期，不作 provider 对照')
    expect(md).toContain('500')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

- [ ] **Step 3: 实现（模板字符串拼接，无外部模板引擎）**

- [ ] **Step 4: 跑测试通过**

Run: `npx vitest run experiments/p5/analyze-cross-batch.test.ts`

- [ ] **Step 5: Commit**

```bash
git add experiments/p5/analyze-cross-batch.ts experiments/p5/analyze-cross-batch.test.ts
git commit --no-verify -m "feat(p5): P9-丙 T5 报告渲染器（六章+P6溯源对照）"
```

---

### Task 6: main() 接线 + 全量真实跑 + 数字人工核对

**Files:**
- Modify: `experiments/p5/analyze-cross-batch.ts`（追加 main()）
- Test: `experiments/p5/analyze-cross-batch.test.ts`（追加集成冒烟）

**Interfaces:**
- Produces:

```ts
export async function main(): Promise<string>
// 串接：loadBatchRows×3 → aggregateFingerprints → detectBatchContamination×3
//   → createReadonlyDb('file:D:/ai全栈挑战赛/agenthub/experiments/p5/p5.db')
//   → probeExperimentSessions → 逐会话 analyzeSessionTrace（串行防 SQLite 锁）
//   → renderCrossBatchReport → writeFileSync(join(resultsDir,'report-cross-batch.md'))
// 返回输出绝对路径
```

- [ ] **Step 1: 写集成冒烟测试（skipIf p5.db 缺失）**

```ts
const dbPath = 'D:/ai全栈挑战赛/agenthub/experiments/p5/p5.db'
describe.skipIf(!existsSync(dbPath))('main() 集成冒烟', () => {
  it('产出报告且标题章节齐全', async () => {
    const { main } = await import('./analyze-cross-batch')
    const out = await main()
    expect(existsSync(out)).toBe(true)
    const md = readFileSync(out, 'utf-8')
    expect(md).toContain('# P9-丙 跨批指纹报告')
  })
})
```

- [ ] **Step 2: 实现 main() → Step 3 跑通集成测试**

- [ ] **Step 4: 人工核对清单（SDD ledger 逐项打勾）**

打开 `results/report-cross-batch.md` 对照 spec §1 表：
- [ ] P8：pass 22 / skip 23 / defect 15 / corr 6 / ill 6
- [ ] P7：pass 25 / skip 26 / defect 9 / corr 6 / ill 2
- [ ] P6 对照节显示 42vs43 及 corr 9vs10、ill 1vs0 差异点名
- [ ] 三批健康检查均阴性
- [ ] 缺边类型学分布产出（乙计划关键输入）；若 P6/P7 天组缺失须有降级声明
- [ ] 成分分解回答「corr 里 gate 占比」

- [ ] **Step 5: Commit + 文档同步**

```bash
git add experiments/p5/analyze-cross-batch.ts experiments/p5/analyze-cross-batch.test.ts
git commit --no-verify -m "feat(p5): P9-丙 T6 main接线+全量真实跑"
```

PROGRESS.md 追加修改历史一行；规划 §9.2 待乙阶段收官一并更新。

---

## Self-Review 记录

1. **Spec 覆盖**：§4.1 六交付物 → T1/T2(①指纹表)、T4(②缺边③成分)、T5(④H1′⑥P6对照)、T3(⑤健康检查)；§8 F5a/b/c → 全局约束 + sanitizeIdentifier + ReadonlyDb；F7 → 结构化定源；F8 → 封顶脚注；§5-1 测试四类 → T2 快照/T3 双向/T4 分支/T6 集成。✅ 无缺口
2. **占位符扫描**：T5 Step 2-4 合并为简写但实现指令明确（模板字符串拼接）；Task 4 无占位（正确实现完整给出）。✅
3. **类型一致性**：NormRow/CellFingerprint/CorrectionSource/MissingEdgeFinding 跨任务签名一致。✅

## 乙阶段预告（不在本计划内）

乙计划待两个输入就绪后另起：① 本计划产出的缺边类型学分布（定 seqgate 拦截靶点）；② 弱模型 pilot 探带结果（定第二模型）。乙计划必办清单已锁定：EXPERIMENT_SEQGATE 开关三件套（F4）、守卫带插入位置（F6）、模型 ID 白名单（F2）、CLAUDE_CONFIG_DIR harness 断言（F3）、work teardown。
