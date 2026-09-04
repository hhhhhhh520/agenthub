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
