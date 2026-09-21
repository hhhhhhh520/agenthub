import { describe, it, expect, vi, beforeEach } from 'vitest'
import { join } from 'node:path'

// ── Monitor A/B harness 红测试（三梯队第 1 项收尾）──────────────────────────────
//
// 实验问题：结构化监控信号（S1 git-truth / S2 outputSchema）vs LLM 审查，作为纠偏
// 触发器的检出能力对比。参照 P7_GATE/P9_ARMS 先例在 p5 harness 原地扩臂（MONITOR_AB 门控）。
//
// 两臂：'on-monitor'（EXPERIMENT_STRUCTURED_MONITOR=on，结构化纠偏先行）
//      'on-llmmon'（开关未设=生产默认 LLM 审，信号记 monitor 事件=反事实）
// 四罐头（D-G）：clean / ghost(S1) / schema-violation(S2) / plausible-wrong(LLM-only)。
//
// 安全审查修正落点（2026-09-21）：
//   🔴 env 快照第四键（防两臂同质化——run-one save/apply/restore 扩键）
//   🔴 D-G 走独立 MONITOR_TASKS（防撑爆 legacy 矩阵 100 runs）
//   Q1  assertSafeCannedPath fail-closed（禁绝对路径/../resolve 越界）
//   Q2  臂判别用 harness 显式状态（monitorReal），绝不读 env（防 llmmon 臂静默失活）

import { CONFIG, envForConfig, isMonitorAbOnly, isMonitorConfig } from './config'
import {
  MONITOR_TASKS,
  PROFILE_BY_DECLARED,
  buildCannedDecompose,
  monitorResultFor,
  assertSafeCannedPath,
  type MonitorTaskId,
} from './tasks-monitor'
import { parseMonitorCycles, aggregateMonitorConfusion, type RunMetrics } from './metrics'

describe('monitor A/B 配置（config 扩展）', () => {
  it('envForConfig：on-monitor → EXPERIMENT_STRUCTURED_MONITOR=on（严格值）；on-llmmon → 未设', () => {
    expect(envForConfig('on-monitor').EXPERIMENT_STRUCTURED_MONITOR).toBe('on')
    expect(envForConfig('on-llmmon').EXPERIMENT_STRUCTURED_MONITOR).toBeUndefined()
    // legacy 臂第四键恒未设（不串扰 P6-P10 语义）
    for (const c of ['on+verify', 'on+no-verify', 'off+verify', 'off+no-verify', 'on-seqgate+verify'] as const) {
      expect(envForConfig(c).EXPERIMENT_STRUCTURED_MONITOR).toBeUndefined()
    }
    // monitor 臂其余三键维持默认（状态机 on / verify on / seqgate 未设）
    expect(envForConfig('on-monitor').EXPERIMENT_STATE_MACHINE).toBeUndefined()
    expect(envForConfig('on-monitor').EXPERIMENT_VERIFY).toBeUndefined()
    expect(envForConfig('on-monitor').EXPERIMENT_SEQGATE).toBeUndefined()
  })

  it('isMonitorConfig 只认两臂', () => {
    expect(isMonitorConfig('on-monitor')).toBe(true)
    expect(isMonitorConfig('on-llmmon')).toBe(true)
    expect(isMonitorConfig('on+verify')).toBe(false)
    expect(isMonitorConfig('on-seqgate+verify')).toBe(false)
    expect(isMonitorConfig('off+verify')).toBe(false)
  })

  it('MONITOR_AB 严格相等（F4 口径：仅 "1" 激活）', () => {
    expect(isMonitorAbOnly({ MONITOR_AB: '1' })).toBe(true)
    expect(isMonitorAbOnly({ MONITOR_AB: '0' })).toBe(false)
    expect(isMonitorAbOnly({ MONITOR_AB: 'true' })).toBe(false)
    expect(isMonitorAbOnly({})).toBe(false)
  })

  it('两臂名落 ON 口径（startsWith(on)：conformance 检查与报告 corr 列语义正确）', () => {
    for (const c of CONFIG.configs) {
      if (isMonitorConfig(c)) expect(c.startsWith('on')).toBe(true)
    }
  })
})

describe('run-one env 快照第四键（🔴 防两臂同质化）', () => {
  beforeEach(() => {
    delete process.env.EXPERIMENT_STRUCTURED_MONITOR
  })

  it('applyRunEnv 透传第四键：set/delete 与三键同语义（undefined → delete）', async () => {
    const { applyRunEnv } = await import('./run-one')
    applyRunEnv({ EXPERIMENT_STATE_MACHINE: undefined, EXPERIMENT_VERIFY: undefined, EXPERIMENT_SEQGATE: undefined, EXPERIMENT_STRUCTURED_MONITOR: 'on' })
    expect(process.env.EXPERIMENT_STRUCTURED_MONITOR).toBe('on')
    applyRunEnv({ EXPERIMENT_STATE_MACHINE: undefined, EXPERIMENT_VERIFY: undefined, EXPERIMENT_SEQGATE: undefined, EXPERIMENT_STRUCTURED_MONITOR: undefined })
    expect(process.env.EXPERIMENT_STRUCTURED_MONITOR).toBeUndefined()
  })

  it('saveRunEnv/restoreRunEnv 对第四键对称（on-monitor run 后不残留 on）', async () => {
    const { saveRunEnv, restoreRunEnv } = await import('./run-one')
    const prev = saveRunEnv()
    process.env.EXPERIMENT_STRUCTURED_MONITOR = 'on'
    restoreRunEnv(prev)
    expect(process.env.EXPERIMENT_STRUCTURED_MONITOR).toBeUndefined()
  })
})

describe('MONITOR_TASKS 罐头（🔴 独立常量，不进 legacy TASKS）', () => {
  it('恰 4 任务 D-G，declaredFiles[0] 全局唯一（mock profile 反查键）', () => {
    expect(MONITOR_TASKS.map(t => t.id)).toEqual(['D', 'E', 'F', 'G'])
    const firsts = MONITOR_TASKS.map(t => t.declaredFiles[0])
    expect(new Set(firsts).size).toBe(4)
  })

  it('全部声明 output_schema（S2 可触发）+ 三标准规范边（与 legacy oracle 同构）', () => {
    for (const t of MONITOR_TASKS) {
      expect(t.outputSchema.length).toBeGreaterThan(0)
      expect(t.requiredEdges).toEqual([
        { action: 'align_decompose', from: '*', to: 'align_arch' },
        { action: 'execute', from: '*', to: 'exec' },
        { action: 'done', from: 'exec', to: 'done' },
      ])
    }
  })

  it('buildCannedDecompose 产出 alignment.ts 消费形状（tasks 数组 + declared_files + output_schema）', () => {
    const t = MONITOR_TASKS[0]
    const parsed = JSON.parse(buildCannedDecompose(t)) as { tasks: Array<Record<string, unknown>> }
    expect(parsed.tasks).toHaveLength(1)
    const job = parsed.tasks[0]
    expect(job.assignedAgent).toBe('后端工程师')
    expect(job.declared_files).toEqual(t.declaredFiles)
    expect(job.output_schema).toEqual(t.outputSchema)
    expect(typeof job.description).toBe('string')
  })

  it('PROFILE_BY_DECLARED 反查唯一且覆盖全部罐头', () => {
    for (const t of MONITOR_TASKS) {
      expect(PROFILE_BY_DECLARED[t.declaredFiles[0]]).toBe(t.profile)
    }
  })

  it('E ghost 只写杂散文件、不写声明文件（钉死：写了声明文件 S1 永不触发）', () => {
    const ghost = MONITOR_TASKS.find(t => t.profile === 'ghost')!
    expect(ghost.writeFiles.some(f => ghost.declaredFiles.includes(f.rel))).toBe(false)
    expect(ghost.writeFiles.length).toBeGreaterThan(0)
    // 其余三臂都写声明文件（clean 命中交集 / schema 触发 S2 / wrong 结构化 pass）
    for (const t of MONITOR_TASKS.filter(x => x.profile !== 'ghost')) {
      expect(t.writeFiles.some(f => t.declaredFiles.includes(f.rel))).toBe(true)
    }
  })

  it('罐头 result 形状：clean/wrong 为 schema 合法 JSON，schema 剧本缺字段，全部无指令式内容（tripwire）', () => {
    for (const t of MONITOR_TASKS) {
      const r = monitorResultFor(t)
      // 金丝雀而非消毒器（审查 💭6）：结果文本会被有工具权限的审查 agent 消费——
      // 覆盖中英文祈使句 / 下载 / 提权 / 删除 / 推送类指令模式
      expect(r).not.toMatch(/请(执行|运行|删除)|运行命令|bash\s|npm\s+install|rm\s+-rf|curl\s|wget|sudo|\b(run|execute|delete)\s/i)
      if (t.profile === 'clean' || t.profile === 'wrong') {
        const obj = JSON.parse(r) as Record<string, unknown>
        for (const field of t.outputSchema) expect(Object.keys(obj)).toContain(field.split(':')[0])
        // wrong 剧本必须自曝缺陷（LLM-only 检出面），clean 不得含缺陷暗示
        if (t.profile === 'wrong') expect(r).toMatch(/未|不|缺陷|问题/)
        if (t.profile === 'clean') expect(r).not.toMatch(/未|不|缺陷|问题/)
      }
      if (t.profile === 'schema') {
        // 缺 schema 字段（触发 S2），但仍是有内容的产出文本
        expect(() => {
          const obj = JSON.parse(r) as Record<string, unknown>
          for (const field of t.outputSchema) if (!(field.split(':')[0] in obj)) throw new Error('missing')
        }).toThrow()
      }
    }
  })
})

describe('assertSafeCannedPath（Q1 fail-closed：mock 写文件路径三断言）', () => {
  const base = join('D:', 'tmp', 'proj-x')
  it('拒绝绝对路径', () => {
    expect(() => assertSafeCannedPath(base, 'C:\\evil')).toThrow()
    expect(() => assertSafeCannedPath(base, '/evil')).toThrow()
  })
  it('拒绝 .. 段', () => {
    expect(() => assertSafeCannedPath(base, '../evil')).toThrow()
    expect(() => assertSafeCannedPath(base, 'src/../../evil')).toThrow()
  })
  it('拒绝 resolve 越界（双保险）', () => {
    expect(() => assertSafeCannedPath(base, 'src/..\\..\\x')).toThrow()
  })
  it('接受合法相对路径（正斜杠）', () => {
    expect(() => assertSafeCannedPath(base, 'src/utils/math.ts')).not.toThrow()
  })
})

describe('parseMonitorCycles（trace → completion-cycle 配对）', () => {
  const mk = (event: string, extra: Record<string, unknown> = {}) => ({ ts: 't', event, ...extra })

  it('按 success 分段；monitor=structuredHit，correction=llmCorrected（unset 臂反事实配对完整）', () => {
    // 尾随 success 开出空 cycle（两判据均 pass 的收敛周期）
    const entries = [mk('success'), mk('monitor'), mk('correction'), mk('success')]
    expect(parseMonitorCycles(entries, 'unset')).toEqual([
      { structuredHit: true, llmCorrected: true },
      { structuredHit: false, llmCorrected: false },
    ])
  })

  it('on 臂：correction 前有 monitor → 结构化触发，不计 llmCorrected', () => {
    const entries = [mk('success'), mk('monitor'), mk('correction', { attempt: 1 })]
    expect(parseMonitorCycles(entries, 'on')).toEqual([{ structuredHit: true, llmCorrected: false }])
  })

  it('on 臂：correction 无 monitor → LLM 触发（结构化漏检面）', () => {
    const entries = [mk('success'), mk('correction', { attempt: 1 })]
    expect(parseMonitorCycles(entries, 'on')).toEqual([{ structuredHit: false, llmCorrected: true }])
  })

  it('前导非 success 事件忽略；空 trace → 空数组', () => {
    // 前导 monitor 不属于任何 cycle（丢弃）；success 后的 cycle 两判据均 false
    expect(parseMonitorCycles([mk('monitor'), mk('success')], 'unset')).toEqual([
      { structuredHit: false, llmCorrected: false },
    ])
    expect(parseMonitorCycles([], 'on')).toEqual([])
  })
})

describe('aggregateMonitorConfusion（四象限计数）', () => {
  it('overlap / llmOnly(漏检) / structuredOnly(误报候选·on臂纠偏) / 双 pass', () => {
    const cycles = [
      { structuredHit: true, llmCorrected: true },
      { structuredHit: false, llmCorrected: true },
      { structuredHit: true, llmCorrected: false },
      { structuredHit: false, llmCorrected: false },
    ]
    expect(aggregateMonitorConfusion(cycles)).toEqual({
      total: 4, structuredHits: 2, llmCorrections: 2, overlap: 1, llmOnly: 1, structuredOnly: 1,
    })
  })
  it('空 cycles → 全零（不 NaN）', () => {
    expect(aggregateMonitorConfusion([])).toEqual({
      total: 0, structuredHits: 0, llmCorrections: 0, overlap: 0, llmOnly: 0, structuredOnly: 0,
    })
  })
})

describe('collectMetrics monitor 字段接线（monitor 臂才附加，legacy 行 JSONL 兼容）', () => {
  beforeEach(() => {
    delete process.env.EXPERIMENT_STRUCTURED_MONITOR
  })

  it('on-monitor 臂：Task.trace cycles 聚合进 metrics optional 字段', async () => {
    const traces: Record<string, string> = {
      'task-main': JSON.stringify([
        { ts: 't', event: 'success' },
        { ts: 't', event: 'monitor' },
        { ts: 't', event: 'correction', attempt: 1 },
        { ts: 't', event: 'success' },
      ]),
      'verify-x': JSON.stringify([{ ts: 't', event: 'success' }]),
    }
    vi.doMock('@/lib/db', () => ({
      prisma: {
        session: { findUnique: vi.fn().mockResolvedValue({ id: 'sess-x', phase: 'done', decisionTrace: '[]' }) },
        task: { findMany: vi.fn().mockResolvedValue([
          { id: 'task-main', trace: traces['task-main'] },
          { id: 'verify-x', trace: traces['verify-x'] },
        ]) },
      },
    }))
    vi.doMock('../../src/lib/orchestrator/decision-trace', () => ({
      checkConformance: vi.fn().mockReturnValue({ violations: [] }),
    }))
    try {
      const { collectMetrics } = await import('./metrics')
      const m = await collectMetrics('run-x', 'sess-x', 'on-monitor', 'D', 0, 5, 0, 1000)
      // verify- 前缀排除：只有 task-main 的 2 cycles 参与
      expect(m.monitorCycles).toBe(2)
      expect(m.monitorStructuredHits).toBe(1)
      expect(m.monitorLlmCorrections).toBe(0)
      expect(m.monitorConverged).toBe(true)
    } finally {
      vi.doUnmock('@/lib/db')
      vi.doUnmock('../../src/lib/orchestrator/decision-trace')
      vi.resetModules()
    }
  })

  it('legacy 臂：不附加 monitor 字段（undefined，JSONL 兼容旧消费方）', async () => {
    vi.doMock('@/lib/db', () => ({
      prisma: {
        session: { findUnique: vi.fn().mockResolvedValue({ id: 's', phase: 'done', decisionTrace: '[]' }) },
        task: { findMany: vi.fn() },
      },
    }))
    vi.doMock('../../src/lib/orchestrator/decision-trace', () => ({
      checkConformance: vi.fn().mockReturnValue({ violations: [] }),
    }))
    try {
      const { collectMetrics } = await import('./metrics')
      const m = await collectMetrics('run-y', 'sess-y', 'on+verify', 'A', 0, 5, 0, 1000)
      expect(m.monitorCycles).toBeUndefined()
    } finally {
      vi.doUnmock('@/lib/db')
      vi.doUnmock('../../src/lib/orchestrator/decision-trace')
      vi.resetModules()
    }
  })
})

describe('generateMonitorReport（monitor A/B 报告段）', () => {
  const row = (over: Partial<RunMetrics> & { runId: string; config: (typeof CONFIG.configs)[number]; taskId: 'A' | 'B' | 'C' | MonitorTaskId; seed: number }): RunMetrics => ({
    pass: true, failureMode: 'pass', rounds: 5, escalateCount: 0,
    correctionCount: 0, illegalProposalCount: 0, totalTransitions: 3, latencyMs: 10, tracePath: '', ...over,
  })

  it('输出两臂触发率 + 混淆矩阵 + 跨臂 McNemar + 效度口径（空数据不 NaN）', async () => {
    const { generateMonitorReport } = await import('./report')
    const metrics: RunMetrics[] = [
      // on-monitor：D clean 无触发；E ghost 结构化独立纠偏（structuredOnly）
      row({ runId: 'a1', config: 'on-monitor', taskId: 'D', seed: 0, monitorCycles: 1, monitorStructuredHits: 0, monitorLlmCorrections: 0, monitorOverlap: 0, monitorLlmOnly: 0, monitorStructuredOnly: 0, monitorConverged: true }),
      row({ runId: 'a2', config: 'on-monitor', taskId: 'E', seed: 0, monitorCycles: 2, monitorStructuredHits: 1, monitorLlmCorrections: 0, monitorOverlap: 0, monitorLlmOnly: 0, monitorStructuredOnly: 1, monitorConverged: true }),
      // on-llmmon：D 无；E 结构化命中(反事实) ∩ LLM 纠偏 = overlap（双判据同判坏）
      row({ runId: 'b1', config: 'on-llmmon', taskId: 'D', seed: 0, monitorCycles: 1, monitorStructuredHits: 0, monitorLlmCorrections: 0, monitorOverlap: 0, monitorLlmOnly: 0, monitorStructuredOnly: 0, monitorConverged: true }),
      row({ runId: 'b2', config: 'on-llmmon', taskId: 'E', seed: 0, monitorCycles: 2, monitorStructuredHits: 1, monitorLlmCorrections: 1, monitorOverlap: 1, monitorLlmOnly: 0, monitorStructuredOnly: 0, monitorConverged: true }),
    ]
    const report = generateMonitorReport(metrics)
    expect(report).toContain('on-monitor')
    expect(report).toContain('on-llmmon')
    expect(report).toContain('混淆矩阵')
    expect(report).toContain('McNemar')
    expect(report).toContain('结构化漏检')
    expect(report).toContain('效度')
    expect(report).not.toContain('NaN')
  })

  it('空 metrics → 触发率 0/0、矩阵全零（报告结构完整可渲染）', async () => {
    const { generateMonitorReport } = await import('./report')
    const report = generateMonitorReport([])
    expect(report).toContain('0/0')
    expect(report).not.toContain('NaN')
  })
})

