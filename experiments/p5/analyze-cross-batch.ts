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
