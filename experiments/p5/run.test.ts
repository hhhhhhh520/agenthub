import { describe, it, beforeAll, afterAll, expect, vi } from 'vitest'
import { writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { CONFIG } from './config'
import { TASKS } from './tasks'
import { setupExperiment } from './setup'
import { runOne } from './run-one'
import { loadMetrics, appendMetrics, countIllegalProposals, resolveFailureMode, type RunMetrics } from './metrics'

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

/** 报告生成（占位——完整 stats+报告由 T7 report.ts 提供；此处仅逐格 pass 汇总 + 失效模式分布） */
function generateReport(metrics: RunMetrics[]): string {
  const lines: string[] = []
  lines.push('# P5 Pilot Report', '')
  lines.push(`> model: ${CONFIG.model} | runsPerCell: ${CONFIG.runsPerCell} | escalateLimit: ${CONFIG.escalateLimit} | maxRounds: ${CONFIG.maxRounds}`, '')
  lines.push('', '## 逐格 pass 数组')
  lines.push('| config | task | pass 数组 | pass 率 |')
  lines.push('|---|---|---|---|')
  for (const config of CONFIG.configs) {
    for (const taskId of CONFIG.taskIds) {
      const cell = metrics.filter(m => m.config === config && m.taskId === taskId)
      if (cell.length === 0) continue
      const passes = cell.map(m => m.pass)
      lines.push(`| ${config} | ${taskId} | ${passes.map(p => (p ? '1' : '0')).join('/')} | ${passes.filter(Boolean).length}/${passes.length} |`)
    }
  }
  lines.push('', '## 失效模式分布')
  const fm = new Map<string, number>()
  for (const m of metrics) fm.set(m.failureMode, (fm.get(m.failureMode) ?? 0) + 1)
  lines.push('- ' + Array.from(fm.entries()).map(([k, v]) => `${k}: ${v}`).join(' | '))
  lines.push('', '> 完整统计（bootstrap CI / McNemar / seed noise）由 T7 stats.ts + report.ts 补齐')
  return lines.join('\n')
}

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
          expect(['pass','no-pass','escalate-exhausted','stuck','error'].includes(m.failureMode)).toBe(true)
        }, 6 * 60 * 1000)
      }
    }
  }
})
