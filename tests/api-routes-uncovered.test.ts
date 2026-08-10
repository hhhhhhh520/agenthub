import { describe, it, expect, vi } from 'vitest'

vi.mock('@/lib/db', () => ({
  prisma: {
    session: { findUnique: vi.fn(), update: vi.fn() },
  },
}))

import { canonicalCorrect, applyTransition, stateFromSession } from '@/lib/orchestrator/state-machine'

// ── P1 迁移: validateDecision 已被 state-machine(canonicalCorrect+applyTransition)替代 ──
// 原 validateDecision 10 个 edge case 迁移到此 + alignment.test.ts + state-machine.test.ts
describe('state-machine — comprehensive edge cases（原 validateDecision，P1 迁移）', () => {
  it('旁路 action 在任意 phase 原样通过（不转 phase）', () => {
    for (const s of ['idle', 'align_pm', 'align_arch', 'align_qa', 'exec', 'done'] as const) {
      for (const a of ['self', 'delegate', 'discuss', 'verify']) {
        const r = applyTransition(s, a)
        expect(r.ok).toBe(true)
        if (r.ok) expect(r.nextState).toBe(s)
      }
    }
  })

  it('对齐中 done 被纠正推进（align_pm->align_decompose / arch|qa->execute）', () => {
    expect(canonicalCorrect('align_pm', 'done')).toEqual({ redirect: 'align_decompose' })
    expect(canonicalCorrect('align_arch', 'done')).toEqual({ redirect: 'execute' })
    expect(canonicalCorrect('align_qa', 'done')).toEqual({ redirect: 'execute' })
  })

  it('执行中 align_* 全部纠正为 execute', () => {
    for (const a of ['align_confirm', 'align_decompose', 'align_qa']) {
      expect(canonicalCorrect('exec', a)).toEqual({ redirect: 'execute' })
    }
  })

  it('Q&A 已答 -> execute；未答 -> 不纠正；PM/架构师提问忽略', () => {
    const answered = [
      { role: 'agent', agentId: '前端工程师', rawContent: 'UI 用什么框架？' },
      { role: 'user', rawContent: '用 React' },
    ]
    expect(canonicalCorrect('align_qa', 'align_qa', answered)).toEqual({ redirect: 'execute' })

    const unanswered = [{ role: 'agent', agentId: '前端工程师', rawContent: 'UI 用什么框架？' }]
    expect(canonicalCorrect('align_qa', 'align_qa', unanswered)).toBeNull()

    const onlyPMArch = [
      { role: 'agent', agentId: '产品经理', rawContent: '需求确认' },
      { role: 'agent', agentId: '架构师', rawContent: '技术方案' },
    ]
    expect(canonicalCorrect('align_qa', 'align_qa', onlyPMArch)).toBeNull()
  })

  it('applyTransition 全矩阵：每状态仅合法 action 可转移，其余非法', () => {
    // idle
    expect(applyTransition('idle', 'align_confirm').ok).toBe(true)
    expect(applyTransition('idle', 'align_decompose').ok).toBe(true)
    expect(applyTransition('idle', 'execute').ok).toBe(true)
    expect(applyTransition('idle', 'done').ok).toBe(true)
    expect(applyTransition('idle', 'align_qa').ok).toBe(false) // 跳 QA 非法

    // align_pm: 只能 confirm 自环 / decompose 推进
    expect(applyTransition('align_pm', 'align_confirm').ok).toBe(true)
    expect(applyTransition('align_pm', 'align_decompose').ok).toBe(true)
    expect(applyTransition('align_pm', 'execute').ok).toBe(false)
    expect(applyTransition('align_pm', 'align_qa').ok).toBe(false)

    // align_arch
    expect(applyTransition('align_arch', 'execute').ok).toBe(true)
    expect(applyTransition('align_arch', 'align_qa').ok).toBe(true)
    expect(applyTransition('align_arch', 'done').ok).toBe(false) // 由纠正接管

    // align_qa: 只能 execute
    expect(applyTransition('align_qa', 'execute').ok).toBe(true)
    expect(applyTransition('align_qa', 'done').ok).toBe(false)

    // exec: done 收尾 / execute 自环 / align_decompose back-edge(补拆)
    expect(applyTransition('exec', 'done').ok).toBe(true)
    expect(applyTransition('exec', 'execute').ok).toBe(true)
    expect(applyTransition('exec', 'align_decompose').ok).toBe(true)
    expect(applyTransition('exec', 'align_qa').ok).toBe(false)

    // done: 新对话轮
    expect(applyTransition('done', 'align_confirm').ok).toBe(true)
    expect(applyTransition('done', 'execute').ok).toBe(true)
    expect(applyTransition('done', 'done').ok).toBe(true)
  })

  it('stateFromSession 已知组合 + 未知兜底', () => {
    expect(stateFromSession('idle', '')).toBe('idle')
    expect(stateFromSession('alignment', 'pm_confirm')).toBe('align_pm')
    expect(stateFromSession('alignment', 'architect_plan')).toBe('align_arch')
    expect(stateFromSession('alignment', 'agent_qa')).toBe('align_qa')
    expect(stateFromSession('execution', '')).toBe('exec')
    expect(stateFromSession('done', '')).toBe('done')
    expect(stateFromSession('alignment', '')).toBe('idle')
    expect(stateFromSession('weird', 'x')).toBe('idle')
  })
})
