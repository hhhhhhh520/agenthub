import { describe, it, expect } from 'vitest'

// ── §3.4 monitoring 结构化（roadmap；三梯队第 1 项 A/B 实验的信号层）──
//
// 现状：executeSingleAgent 让 Orchestrator LLM 审 LLM（needsCorrection），结构化信号
// （git truth / outputSchema）只产生软警告不参与纠偏判定。
// 本模块：把结构化信号收敛为纯函数判定（structuredMonitorVerdict），monitoring 接线
// 按 EXPERIMENT_STRUCTURED_MONITOR 门控决定"结构化先行（on）或仅记录反事实（未设）"。
//
// 信号定义：
//   S1 git-truth 完成性——declaredFiles 非空且 declared∩changed 为空（声明改的文件零变更）
//      防御：仅当 changedFiles.length > 0 时判定（batch diff 为空可能是快照链路故障而非
//      任务没产出，避免系统性误报；ISSUE-011 F3 已记录 batch 快照差异的已知限制）
//   S2 outputSchema——validateAgainstSchema 不通过（missing-fields/parse-error/no-json）
//      防御：declaredFiles 为空（纯讨论/分析任务）跳过 S1；outputSchema 为空跳过 S2

import { structuredMonitorVerdict, describeSignal } from '@/lib/services/structured-monitor'
import { validateAgainstSchema } from '@/lib/services/schema-validator'

describe('structuredMonitorVerdict — S1 git-truth 完成性', () => {
  it('声明了文件但 batch diff 非空且声明∩变更=空 → S1 命中（声称完成但无产出）', () => {
    const v = structuredMonitorVerdict({
      declaredFiles: ['src/app/page.tsx', 'src/lib/api.ts'],
      changedFiles: ['src/lib/other.ts'],
      schemaCheck: { valid: true } as ReturnType<typeof validateAgainstSchema>,
    })
    expect(v.verdict).toBe('correction')
    expect(v.signals).toHaveLength(1)
    expect(v.signals[0].kind).toBe('declared_files_untouched')
    expect(v.signals[0].detail).toContain('src/app/page.tsx')
  })

  it('batch diff 为空 → S1 不判定（防快照链路故障误报）', () => {
    const v = structuredMonitorVerdict({
      declaredFiles: ['src/app/page.tsx'],
      changedFiles: [],
      schemaCheck: { valid: true } as ReturnType<typeof validateAgainstSchema>,
    })
    expect(v.verdict).toBe('pass')
    expect(v.signals).toHaveLength(0)
  })

  it('declaredFiles 为空（纯讨论/分析任务）→ 跳过 S1', () => {
    const v = structuredMonitorVerdict({
      declaredFiles: [],
      changedFiles: ['src/lib/other.ts'],
      schemaCheck: { valid: true } as ReturnType<typeof validateAgainstSchema>,
    })
    expect(v.verdict).toBe('pass')
  })

  it('声明文件全部变更 → S1 不命中', () => {
    const v = structuredMonitorVerdict({
      declaredFiles: ['src/app/page.tsx'],
      changedFiles: ['src/app/page.tsx', 'extra.ts'],
      schemaCheck: { valid: true } as ReturnType<typeof validateAgainstSchema>,
    })
    expect(v.verdict).toBe('pass')
  })
})

describe('structuredMonitorVerdict — S2 outputSchema', () => {
  it('schema 校验不通过 → S2 命中', () => {
    const v = structuredMonitorVerdict({
      declaredFiles: [],
      changedFiles: [],
      schemaCheck: { valid: false, status: 'missing-fields', message: '缺字段' } as ReturnType<typeof validateAgainstSchema>,
    })
    expect(v.verdict).toBe('correction')
    expect(v.signals[0].kind).toBe('output_schema_violation')
  })

  it('schema 为 no-schema（未声明）→ 不命中', () => {
    const v = structuredMonitorVerdict({
      declaredFiles: [],
      changedFiles: [],
      schemaCheck: { valid: true, status: 'no-schema' } as ReturnType<typeof validateAgainstSchema>,
    })
    expect(v.verdict).toBe('pass')
  })
})

describe('structuredMonitorVerdict — 多信号', () => {
  it('S1+S2 同时命中 → verdict correction + 两条信号', () => {
    const v = structuredMonitorVerdict({
      declaredFiles: ['src/a.ts'],
      changedFiles: ['src/other.ts'],
      schemaCheck: { valid: false, status: 'missing-fields', message: '缺字段' } as ReturnType<typeof validateAgainstSchema>,
    })
    expect(v.verdict).toBe('correction')
    expect(v.signals.map(s => s.kind)).toEqual(['declared_files_untouched', 'output_schema_violation'])
  })
})

describe('describeSignal — 纠偏 prompt 摘要', () => {
  it('S1 摘要含声明文件与变更文件对照', () => {
    const s = describeSignal({ kind: 'declared_files_untouched', detail: 'src/a.ts' })
    expect(s).toContain('src/a.ts')
    expect(s).toContain('未变更')
  })
})
