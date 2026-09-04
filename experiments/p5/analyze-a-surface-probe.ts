import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'

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
