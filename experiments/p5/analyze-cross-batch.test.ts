import { describe, it, expect } from 'vitest'
import { writeFileSync, unlinkSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { loadBatchRows, aggregateFingerprints, fingerprintKey, BATCH_FILES } from './analyze-cross-batch'

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
