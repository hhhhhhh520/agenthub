import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { TRANSITIONS, NON_TRANSITIONING, seqgatePredicate } from './analyze-a-surface-probe'

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
