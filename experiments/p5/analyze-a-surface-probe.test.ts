import { describe, it, expect } from 'vitest'
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { TRANSITIONS, NON_TRANSITIONING, seqgatePredicate, PROBE_BATCH, loadMetricsRows, selectProbeCells } from './analyze-a-surface-probe'

const SM_SRC = readFileSync(join(import.meta.dirname, '..', '..', 'src', 'lib', 'orchestrator', 'state-machine.ts'), 'utf8')

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
