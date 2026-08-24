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
