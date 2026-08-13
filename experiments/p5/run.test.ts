import { describe, it, beforeAll, afterAll, expect, vi } from 'vitest'
import { writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { CONFIG } from './config'
import { TASKS } from './tasks'
import { setupExperiment } from './setup'
import { runOne } from './run-one'
import { loadMetrics, appendMetrics, countIllegalProposals, resolveFailureMode, type RunMetrics } from './metrics'
import { bootstrapCI, pairedMcNemar, seedNoise } from './stats'
import { generateReport } from './report'

// —— vi.mock 注入（Spec §5.2，必须在 src 模块首次 import 前）——
// 决策保留真实 LLM（getOrchestratorDecision 内部调 executeSingleAgent，orchestrator 系统提示不含
// '代码审查专家'，透传真实调用），任务执行 mock（executeTaskBatch）+ monitoring mock（代码审查专家→不纠正）。
const mocks = vi.hoisted(() => {
  const mockExecuteTaskBatch = vi.fn(async (tasks: any[]) => {
    const results = new Map<string, { result: string; sessionId?: string }>()
    for (const t of tasks) results.set(t.id, { result: 'SUCCESS', sessionId: undefined })
    return { results, preloadedIds: [], failedTaskIds: [], failedTaskReasons: {} }
  })
  return { mockExecuteTaskBatch }
})

vi.mock('@/lib/orchestrator', async (importOriginal) => {
  const mod = await importOriginal() as any
  return {
    ...mod,
    executeTaskBatch: mocks.mockExecuteTaskBatch,
    executeSingleAgent: vi.fn(async (agent: any, prompt: string, context: string, onChunk: any, ...rest: any[]) => {
      if (agent?.systemPrompt?.includes('代码审查专家')) {
        return { result: JSON.stringify({ needsCorrection: false }) }
      }
      return mod.executeSingleAgent(agent, prompt, context, onChunk, ...rest)
    }),
  }
})
vi.mock('@/lib/mcp-config', () => ({ buildMCPConfig: () => undefined }))

// —— harness 纯函数单测（不依赖 DB / 真实 LLM，GLM_API_KEY=test-key 即可跑；setupExperiment 只由 30-run 调）——
describe('P5 harness 单测', () => {
  it('executeTaskBatch mock 返回 4 键 + 对象形状', async () => {
    const r = await mocks.mockExecuteTaskBatch([
      { id: 't1', batch: 0, description: 'd', assignedAgent: '架构师', dependencies: [] },
      { id: 'verify-x', batch: 1, description: 'v', assignedAgent: '测试', dependencies: ['t1'] },
    ])
    expect(r.preloadedIds).toEqual([])
    expect(r.failedTaskIds).toEqual([])
    for (const id of ['t1', 'verify-x']) expect(typeof r.results.get(id)!.result).toBe('string')
  })
  it('countIllegalProposals: OFF 只计 applied:false&&escalated:false 决策条目（计划扫描修正②）', () => {
    const entries = [
      { decisionPoint: 'handleOrchestratorDecision', actualTransition: { applied: false, escalated: false } }, // 表外提议 → 计入
      { decisionPoint: 'handleOrchestratorDecision', actualTransition: { applied: true, escalated: false } },  // 合法转移 → 不计
      { decisionPoint: 'handleOrchestratorDecision', actualTransition: { applied: false, escalated: true } },  // ON 语义 escalate → 不计
      { decisionPoint: 'transitionPhase', actualTransition: { applied: false, escalated: false } },            // 代码驱动 → 不计
    ]
    expect(countIllegalProposals(entries, true)).toBe(1)
    expect(countIllegalProposals(entries, false)).toBe(0) // ON 用 escalateCount/correctionCount 表达
  })
  it('resolveFailureMode: error/stuck 显式可达（review I1 修正，不再依赖 rounds > maxRounds 永假）', () => {
    expect(resolveFailureMode(false, 0, CONFIG.maxRounds)).toBe('stuck')            // 撞 maxRounds 上界且未 done
    expect(resolveFailureMode(false, 0, CONFIG.maxRounds - 1)).toBe('no-pass')      // no-progress 提前 break
    expect(resolveFailureMode(false, 0, 3, true)).toBe('error')                     // 异常击穿
    expect(resolveFailureMode(false, CONFIG.escalateLimit + 1, 3)).toBe('escalate-exhausted')
    expect(resolveFailureMode(true, 0, 5)).toBe('pass')                             // pass 优先
  })
  it('metrics 落盘往返', () => {
    const runId = `__harness_${Date.now()}`
    const m: RunMetrics = { runId, config: 'off', taskId: 'A', seed: 0, pass: false, failureMode: 'no-pass', rounds: 3, escalateCount: 0, correctionCount: 0, illegalProposalCount: 1, totalTransitions: 2, latencyMs: 10, tracePath: '' }
    appendMetrics(m)
    expect(loadMetrics().some(x => x.runId === runId)).toBe(true)
    // 清理：runId 唯一，按行删除，不污染实验 metrics.jsonl
    const rest = loadMetrics().filter(x => x.runId !== runId)
    if (rest.length === 0) rmSync(join(CONFIG.resultsDir, 'metrics.jsonl'), { force: true })
    else writeFileSync(join(CONFIG.resultsDir, 'metrics.jsonl'), rest.map(x => JSON.stringify(x)).join('\n') + '\n', 'utf8')
  })
})

// —— T7 stats + report 纯函数单测（fixture 数据，不依赖 DB / 真实 LLM）——
describe('P5 stats', () => {
  it('bootstrapCI 恒返回区间且含均值', () => {
    const ci = bootstrapCI([true, true, false, false, true], 200)
    expect(ci.low).toBeLessThanOrEqual(ci.high)
    expect(ci.mean).toBeCloseTo(0.6, 5)
  })
  it('pairedMcNemar: OFF 赢多则 p 小', () => {
    const r = pairedMcNemar([true, true, true], [false, false, false]) // b=3 c=0
    expect(r.b).toBe(3)
    expect(r.c).toBe(0)
    expect(r.pValue).toBeLessThan(0.1)
  })
  it('seedNoise: 全同 → 0 方差', () => {
    const ns = seedNoise([
      { config: 'on', taskId: 'A', pass: true, failureMode: 'pass' } as any,
      { config: 'on', taskId: 'A', pass: true, failureMode: 'pass' } as any,
    ])
    expect(ns[0].variance).toBe(0)
  })
})

describe('P5 report', () => {
  it('generateReport 覆盖关键 section + M3 trace 说明（不假装 trace 文件存在）', () => {
    const fixtures: RunMetrics[] = [
      { runId: 'r1', config: 'off', taskId: 'A', seed: 0, pass: true, failureMode: 'pass', rounds: 5, escalateCount: 0, correctionCount: 0, illegalProposalCount: 2, totalTransitions: 3, latencyMs: 10, tracePath: '' },
      { runId: 'r2', config: 'on', taskId: 'A', seed: 0, pass: false, failureMode: 'stuck', rounds: CONFIG.maxRounds, escalateCount: 1, correctionCount: 1, illegalProposalCount: 0, totalTransitions: 3, latencyMs: 12, tracePath: '' },
    ]
    const report = generateReport(fixtures)
    expect(report).toContain('# P5 Pilot Report')
    expect(report).toContain('## 逐格 pass 数组')
    expect(report).toContain('## 配对 McNemar')
    expect(report).toContain('## seed noise')
    expect(report).toContain('## 失效模式分布')
    expect(report).toContain('## OFF 非法尝试率 vs ON correctionCount')
    expect(report).toContain('方向性差异当传闻看')
    expect(report).toContain('session.decisionTrace') // M3
    expect(report).toContain('| off | A | 1 | 1/1 |')
  })
})

// —— 30 次 run（Spec §3.3：3任务×2配置×5次；5 固定 seed 同 seed 配对 ON/OFF）——
const SEEDS = [0, 1, 2, 3, 4]
describe('P5 pilot: 30 次受控实验', () => {
  // setupExperiment 仅 30-run 需要（建库 + 实验 agents + preflight 真 LLM 调用）。
  // harness 纯函数单测不调它——preflight 需要真实 GLM key，无 key 时只跑单测 describe
  beforeAll(async () => {
    // 幂等重置：跨次运行不留旧 metrics.jsonl（否则 30-run 重跑叠加成 60/90 行，破坏每格 N=5 受控对比，T7 stats 会错）
    rmSync(join(CONFIG.resultsDir, 'metrics.jsonl'), { force: true })
    await setupExperiment()
  }, 5 * 60 * 1000)
  afterAll(async () => {
    // 生成报告（Spec §11）
    const report = generateReport(loadMetrics())
    console.log('\n===== P5 PILOT REPORT =====\n' + report)
  }, 60 * 1000)

  for (const task of TASKS) {
    for (const config of CONFIG.configs) {
      for (const seed of SEEDS) {
        it(`${config} ${task.id} seed=${seed}`, async () => {
          const m = await runOne({ config, taskId: task.id, seed })
          // M2：断言 m 结构完整（原 includes(m.failureMode) 对 5 值联合类型恒真，是重言式）
          expect(m.runId).toBeTruthy()
          expect(typeof m.pass).toBe('boolean')
          expect(m.rounds).toBeGreaterThanOrEqual(0)
        }, 6 * 60 * 1000)
      }
    }
  }
})
