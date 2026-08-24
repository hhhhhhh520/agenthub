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
