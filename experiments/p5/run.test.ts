import { describe, it, beforeAll, afterAll, afterEach, expect, vi } from 'vitest'
import { writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { CONFIG } from './config'
import { TASKS } from './tasks'
import { setupExperiment } from './setup'
import { runOne, saveRunEnv, restoreRunEnv } from './run-one'
import { loadMetrics, appendMetrics, countIllegalProposals, resolveFailureMode, type RunMetrics } from './metrics'
import { bootstrapCI, pairedMcNemar, seedNoise } from './stats'
import { generateReport } from './report'

// —— vi.mock 注入（Spec §5.2，必须在 src 模块首次 import 前）——
// 决策保留真实 LLM：getOrchestratorDecision 内部直调原 executeSingleAgent（模块内部绑定，mock 拦不到）→ 真实。
// 判定分支用 agent.systemPrompt（ORCHESTRATOR_DECISION_PROMPT 硬编码模板，LLM 不可污染）作安全网——
// 若未来重构让决策路由到 mock 仍放行真实；不用 prompt 判定（LLM 可能在 reason/message 回显 prompt 造成误判）。
// 执行全 mock（冒烟诊断：delegate/discuss/self 走真实 CLI 编码会 hang；且 provider 慢，对齐 PM/QA/decompose 也 mock 以控时长）。
// 罐头按 task 差异化（P6 A1）——A/B 代码任务（declared_files 代码后缀 → 触发 verify），C 非代码任务（isCodeTask 不命中）。
// 按消费者分流（P6 A2）——QA 调用（handleAgentQA 对全部成员发问, prompt 为 buildAgentQuestionPrompt 固定模板）
// 经 qaPromptMarker 分支全回 '无问题'（alignment.ts:330 判 !='无问题' 即提问）→ 无疑问直发 exec；
// 架构师 decompose 需有效任务 JSON（alignment.ts:171 parseJSON(['tasks'])）；PM 语义句（handlePMConfirm 不 JSON.parse）；delegate/self 语义句。
// discuss 走 runDiscussion（adapter 直连，不经 executeSingleAgent）→ 单独 mock 防真实 CLI。
// preflight 固定 prompt '只回复两个字：就绪' → 放行真实（provider 快速失败闸门，Spec §7.2，审查 ❌B）。
// 常量放 vi.hoisted（vi.mock factory 被 hoisted，引用模块级 const 会 TDZ）。
const mocks = vi.hoisted(() => {
  const preflightPromptMarker = '只回复两个字：就绪'
  // P6 A2: QA 调用 marker（buildAgentQuestionPrompt 固定模板,handleAgentQA 对全部成员发问 → 全回 '无问题' 直发 exec）
  const qaPromptMarker = '请检查方案中是否有需要澄清的问题'
  // P6 A1: 罐头按 task 三档——A/B 代码任务(declared_files 有代码后缀,触发 verify)；C 非代码任务
  // （declared_files:[] + description 无 .ts/.js 后缀,isCodeTask 不命中,双保险）
  const cannedTasksByTask: Record<string, string> = {
    A: JSON.stringify({ tasks: [{ id: 1, description: '实现 add(a,b) 函数并放在 src/utils/math.ts', assignedAgent: '后端工程师', dependencies: [], declared_files: ['src/utils/math.ts'] }] }),
    B: JSON.stringify({ tasks: [{ id: 1, description: '实现登录接口，路由 /api/login，放在 src/api/login.ts', assignedAgent: '后端工程师', dependencies: [], declared_files: ['src/api/login.ts'] }] }),
    C: JSON.stringify({ tasks: [{ id: 1, description: '修改项目根目录 .env.example 的端口配置为 8080', assignedAgent: '后端工程师', dependencies: [], declared_files: [] }] }),
  }
  // vi.mock factory 被 hoisted,读不到 run 循环局部变量 → 可变对象暴露 currentTaskId,30-run driver 每 it 设置
  const state = { currentTaskId: 'A' as 'A' | 'B' | 'C' }
  const mockExecuteTaskBatch = vi.fn(async (tasks: any[]) => {
    const results = new Map<string, { result: string; sessionId?: string }>()
    for (const t of tasks) results.set(t.id, { result: 'SUCCESS', sessionId: undefined })
    return { results, preloadedIds: [], failedTaskIds: [], failedTaskReasons: {} }
  })
  return { mockExecuteTaskBatch, preflightPromptMarker, qaPromptMarker, cannedTasksByTask, state }
})

vi.mock('@/lib/orchestrator', async (importOriginal) => {
  const mod = await importOriginal() as any
  return {
    ...mod,
    executeTaskBatch: mocks.mockExecuteTaskBatch,
    executeSingleAgent: vi.fn(async (agent: any, prompt: string, context: string, onChunk: any, ...rest: any[]) => {
      // 0. preflight（provider 快速失败闸门，固定 prompt）→ 真实调用（审查 ❌B）
      if (typeof prompt === 'string' && prompt.includes(mocks.preflightPromptMarker)) {
        return mod.executeSingleAgent(agent, prompt, context, onChunk, ...rest)
      }
      // 1. 决策安全网（ORCHESTRATOR_DECISION_PROMPT 硬编码模板，审查 ⚠️污染）→ 真实 LLM；当前决策由内部绕过保证
      if (agent?.systemPrompt?.includes('决定下一步该做什么')) {
        return mod.executeSingleAgent(agent, prompt, context, onChunk, ...rest)
      }
      // 2. monitoring（代码审查专家）→ 不纠正
      if (agent?.systemPrompt?.includes('代码审查专家')) {
        return { result: JSON.stringify({ needsCorrection: false }) }
      }
      // P6 A2: QA 调用（handleAgentQA 对全部 session member 发问, prompt 是 buildAgentQuestionPrompt 固定模板
      // 非 LLM 可污染,复用 preflight prompt-marker 先例）→ 全回 '无问题' → alignment.ts:342 无疑问直发 exec
      if (typeof prompt === 'string' && prompt.includes(mocks.qaPromptMarker)) {
        return { result: '无问题' }
      }
      // 3. 其余执行（decompose/delegate/self;QA 已由上方 marker 分支接管）→ 按消费者分流（P6 A1+A2）。
      //    判定用 agent.systemPrompt（硬编码模板,LLM 不可污染,复用 systemPrompt 安全网原则;不用 prompt 判定）。
      //    架构师(decompose) → 按 task 罐头任务 JSON（alignment.ts:171 parseJSON 可解析建任务）；
      //    测试工程师(非 QA 兜底) → '无问题'；产品经理(PM) → 语义句（handlePMConfirm 不 JSON.parse）；其余(delegate/self) → 语义句。
      const sp = agent?.systemPrompt ?? ''
      if (sp.includes('架构师')) return { result: mocks.cannedTasksByTask[mocks.state.currentTaskId] }
      if (sp.includes('测试工程师')) return { result: '无问题' }
      if (sp.includes('产品经理')) return { result: '已确认需求，请架构师拆解。' }
      return { result: '任务已完成。' }
    }),
    // discuss 路径：runMultiAgentDiscussion → runDiscussion（adapter 直连，不经 executeSingleAgent）→ mock 防真实 CLI hang（审查 ❌A）
    runDiscussion: vi.fn(async () => ['罐头讨论意见（agent A 认为应澄清需求）', '罐头讨论意见（agent B 同意推进）']),
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
    const m: RunMetrics = { runId, config: 'off+no-verify', taskId: 'A', seed: 0, pass: false, failureMode: 'no-pass', rounds: 3, escalateCount: 0, correctionCount: 0, illegalProposalCount: 1, totalTransitions: 2, latencyMs: 10, tracePath: '' }
    appendMetrics(m)
    expect(loadMetrics().some(x => x.runId === runId)).toBe(true)
    // 清理：runId 唯一，按行删除，不污染实验 metrics.jsonl
    const rest = loadMetrics().filter(x => x.runId !== runId)
    if (rest.length === 0) rmSync(join(CONFIG.resultsDir, 'metrics.jsonl'), { force: true })
    else writeFileSync(join(CONFIG.resultsDir, 'metrics.jsonl'), rest.map(x => JSON.stringify(x)).join('\n') + '\n', 'utf8')
  })
})

// —— P6 A1+A2 罐头差异化 + 语义化（纯单测：直调 mock executeSingleAgent，不触发 30-run / 真实 LLM）——
describe('P6 A1+A2 罐头差异化 + 语义化', () => {
  it('task C 罐头 declared_files:[] + isCodeTask false（非代码任务不触发 verify）', async () => {
    const { isCodeTask } = await import('@/lib/services/alignment')
    const parsed = JSON.parse(mocks.cannedTasksByTask['C'])
    const t = parsed.tasks[0]
    expect(t.declared_files).toEqual([])
    expect(isCodeTask({ description: t.description, declaredFiles: t.declared_files })).toBe(false)
  })
  it('task A/B 罐头 isCodeTask true（代码任务触发 verify）', async () => {
    const { isCodeTask } = await import('@/lib/services/alignment')
    for (const id of ['A', 'B'] as const) {
      const parsed = JSON.parse(mocks.cannedTasksByTask[id])
      expect(isCodeTask({ description: parsed.tasks[0].description, declaredFiles: parsed.tasks[0].declared_files })).toBe(true)
    }
  })
  it('架构师分流按 currentTaskId 返回可解析任务 JSON（decompose 建任务）', async () => {
    const { executeSingleAgent } = await import('@/lib/orchestrator')
    mocks.state.currentTaskId = 'C'
    const rC = await (executeSingleAgent as any)(
      { name: '架构师', systemPrompt: '你是架构师，负责把需求拆解为可执行任务。' }, '任务描述：X', '', () => {})
    const parsedC = JSON.parse(rC.result)
    expect(parsedC.tasks).toHaveLength(1)
    expect(parsedC.tasks[0].declared_files).toEqual([])
    // 切回 A：同一 mock 消费方 → 返回代码任务 JSON
    mocks.state.currentTaskId = 'A'
    const rA = await (executeSingleAgent as any)(
      { name: '架构师', systemPrompt: '你是架构师，负责把需求拆解为可执行任务。' }, '任务描述：X', '', () => {})
    expect(JSON.parse(rA.result).tasks[0].declared_files).toEqual(['src/utils/math.ts'])
  })
  it('测试工程师 QA 回 无问题（alignment.ts:330 判 !=无问题 即提问）', async () => {
    const { executeSingleAgent } = await import('@/lib/orchestrator')
    const { buildAgentQuestionPrompt } = await import('@/lib/orchestrator/prompts')
    const r = await (executeSingleAgent as any)(
      { name: '测试工程师', systemPrompt: '你是测试工程师，负责编写测试并验证实现。' },
      buildAgentQuestionPrompt('测试工程师', '测试编写与验证', '需求', '方案'), '', () => {})
    expect(r.result.trim()).toBe('无问题')
  })
  it('QA 调用 4 成员全回 无问题 → 0 questions → 直发 exec 路径可达（A2 marker 分支真实生效）', async () => {
    const { executeSingleAgent } = await import('@/lib/orchestrator')
    const { buildAgentQuestionPrompt } = await import('@/lib/orchestrator/prompts')
    const members = [
      { name: '架构师', expertise: '系统设计与任务拆解', systemPrompt: '你是架构师，负责把需求拆解为可执行任务。' },
      { name: '测试工程师', expertise: '测试编写与验证', systemPrompt: '你是测试工程师，负责编写测试并验证实现。' },
      { name: '产品经理', expertise: '需求分析与澄清', systemPrompt: '你是产品经理，负责需求分析与澄清，可向用户提问确认需求。' },
      { name: '后端工程师', expertise: '后端与脚本开发', systemPrompt: '你是后端工程师，负责实现 API 与业务逻辑。' },
    ]
    const questions: string[] = []
    for (const a of members) {
      const r = await (executeSingleAgent as any)(
        { name: a.name, systemPrompt: a.systemPrompt },
        buildAgentQuestionPrompt(a.name, a.expertise, '需求', '方案'), '', () => {})
      expect(r.result.trim()).toBe('无问题')
      if (r.result.trim() !== '无问题') questions.push(r.result) // alignment.ts:330 判据
    }
    expect(questions.length).toBe(0) // alignment.ts:342-346 无疑问 → 直发 exec
  })
  it('产品经理 PM 语义句（handlePMConfirm 不 JSON.parse，杜绝落库 JSON 噪音）', async () => {
    const { executeSingleAgent } = await import('@/lib/orchestrator')
    const r = await (executeSingleAgent as any)(
      { name: '产品经理', systemPrompt: '你是产品经理，负责需求分析与澄清，可向用户提问确认需求。' }, 'prompt', '', () => {})
    expect(r.result).toBe('已确认需求，请架构师拆解。')
    expect(() => JSON.parse(r.result)).toThrow()
  })
  it('其余(delegate/self)语义句', async () => {
    const { executeSingleAgent } = await import('@/lib/orchestrator')
    const r = await (executeSingleAgent as any)(
      { name: '后端工程师', systemPrompt: '你是后端工程师，负责实现 API 与业务逻辑。' }, 'prompt', '', () => {})
    expect(r.result).toBe('任务已完成。')
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
      { runId: 'r1', config: 'off+verify', taskId: 'A', seed: 0, pass: true, failureMode: 'pass', rounds: 5, escalateCount: 0, correctionCount: 0, illegalProposalCount: 2, totalTransitions: 3, latencyMs: 10, tracePath: '' },
      { runId: 'r2', config: 'on+verify', taskId: 'A', seed: 0, pass: false, failureMode: 'stuck', rounds: CONFIG.maxRounds, escalateCount: 1, correctionCount: 1, illegalProposalCount: 0, totalTransitions: 3, latencyMs: 12, tracePath: '' },
    ]
    const report = generateReport(fixtures)
    expect(report).toContain('# P5 Pilot Report')
    expect(report).toContain('## 逐格 pass 数组')
    expect(report).toContain('## 配对 McNemar')
    expect(report).toContain('### 状态机主效应')   // P6 T8：verify 固定时 ON vs OFF 配对
    expect(report).toContain('### verify 主效应')  // P6 T8：状态机固定时 verify vs no-verify 配对
    expect(report).toContain('## 交互 2×2 列联表') // P6 T8：行=状态机 列=verify 格=pass 率
    expect(report).toContain('## seed noise')
    expect(report).toContain('## 失效模式分布')
    expect(report).toContain('## OFF 非法尝试率 vs ON correctionCount')
    expect(report).toContain('方向性差异当传闻看')
    expect(report).toContain('baseUrl:') // P6 A4：报告回显实际生效 baseUrl（模型钉死 + 端点错配修正）
    expect(report).toContain('session.decisionTrace') // M3
    expect(report).toContain('罐头消息') // I1: spec §6 报告写明固定罐头消息
    expect(report).toContain(JSON.stringify(CONFIG.cannedReplies))
    expect(report).toContain('| off+verify | A | 1 | 1/1 |')
  })
  it('A5: pass 数组按 seed 升序（乱序 metrics seed 3,1,2 → 0/1/1，不随插入序漂移）', () => {
    const seed3: RunMetrics = { runId: 'r-s3', config: 'on+verify', taskId: 'A', seed: 3, pass: true, failureMode: 'pass', rounds: 5, escalateCount: 0, correctionCount: 0, illegalProposalCount: 0, totalTransitions: 3, latencyMs: 10, tracePath: '' }
    const seed1: RunMetrics = { runId: 'r-s1', config: 'on+verify', taskId: 'A', seed: 1, pass: false, failureMode: 'no-pass', rounds: 3, escalateCount: 0, correctionCount: 0, illegalProposalCount: 0, totalTransitions: 2, latencyMs: 9, tracePath: '' }
    const seed2: RunMetrics = { runId: 'r-s2', config: 'on+verify', taskId: 'A', seed: 2, pass: true, failureMode: 'pass', rounds: 5, escalateCount: 0, correctionCount: 0, illegalProposalCount: 0, totalTransitions: 3, latencyMs: 11, tracePath: '' }
    const shuffled: RunMetrics[] = [seed3, seed1, seed2] // 插入序 3,1,2
    const report = generateReport(shuffled)
    // seed 升序 1,2,3 → pass 数组 false/true/true → "0/1/1"（修复前按插入序输出 "1/0/1"）
    expect(report).toContain('| on+verify | A | 0/1/1 |')
    // sort 在 filter 拷贝上，generateReport 不得改动入参顺序
    expect(shuffled.map(m => m.seed)).toEqual([3, 1, 2])
  })
  it('P6 T9: 报告口径说明（spec §7）——task B QA mock 口径 + task C 不触发 verify', () => {
    // 口径行是静态文案，任意 fixture 即可；沿用乱序 metrics → 断言输出行 的现有写法
    const fixtures: RunMetrics[] = [
      { runId: 'r1', config: 'on+verify', taskId: 'B', seed: 0, pass: true, failureMode: 'pass', rounds: 5, escalateCount: 0, correctionCount: 0, illegalProposalCount: 0, totalTransitions: 3, latencyMs: 10, tracePath: '' },
      { runId: 'r2', config: 'on+verify', taskId: 'C', seed: 1, pass: true, failureMode: 'pass', rounds: 5, escalateCount: 0, correctionCount: 0, illegalProposalCount: 0, totalTransitions: 3, latencyMs: 11, tracePath: '' },
    ]
    const report = generateReport(fixtures)
    expect(report).toContain('报告口径')
    expect(report).toContain('mock 口径')
    expect(report).toContain('不触发 verify')
  })
})

// —— P6 T8: 2×2 配置矩阵（configs 扩 4 + envForConfig 透传 + report 主效应/交互）——
describe('P6 T8: 2×2 配置矩阵', () => {
  it('CONFIG.configs 扩为 4 配置 + envForConfig 映射正确', () => {
    expect(CONFIG.configs).toEqual(['on+verify', 'on+no-verify', 'off+verify', 'off+no-verify'])
    expect(CONFIG.envForConfig('on+verify')).toEqual({ EXPERIMENT_STATE_MACHINE: undefined, EXPERIMENT_VERIFY: undefined })
    expect(CONFIG.envForConfig('on+no-verify')).toEqual({ EXPERIMENT_STATE_MACHINE: undefined, EXPERIMENT_VERIFY: 'off' })
    expect(CONFIG.envForConfig('off+verify')).toEqual({ EXPERIMENT_STATE_MACHINE: 'off', EXPERIMENT_VERIFY: undefined })
    expect(CONFIG.envForConfig('off+no-verify')).toEqual({ EXPERIMENT_STATE_MACHINE: 'off', EXPERIMENT_VERIFY: 'off' })
  })

  it('generateReport: 4 配置×3任务×5seed 输出状态机主效应+verify 主效应+交互（b/c 手算正确，配对按 seed 排序）', () => {
    // 已知 pass 数据（seed 0..4）：
    //   on+verify / off+no-verify 全过；off+verify 全败；on+no-verify 仅 seed 4 败
    const passBy: Record<string, boolean[]> = {
      'on+verify': [true, true, true, true, true],
      'off+no-verify': [true, true, true, true, true],
      'off+verify': [false, false, false, false, false],
      'on+no-verify': [true, true, true, true, false],
    }
    const row = (config: (typeof CONFIG.configs)[number], taskId: 'A' | 'B' | 'C', seed: number, pass: boolean): RunMetrics => ({
      runId: `${config}-${taskId}-s${seed}`, config, taskId, seed, pass,
      failureMode: pass ? 'pass' : 'no-pass', rounds: 5, escalateCount: 0,
      correctionCount: 0, illegalProposalCount: 0, totalTransitions: 3, latencyMs: 10, tracePath: '',
    })
    // 乱序插入（verify 配置组先插、每配置 seed 倒序），验证同 seed 配对不依赖插入序
    const metrics: RunMetrics[] = []
    for (const config of CONFIG.configs) {
      for (const taskId of ['A', 'B', 'C'] as const) {
        for (let seed = 4; seed >= 0; seed--) metrics.push(row(config, taskId, seed, passBy[config][seed]))
      }
    }
    const report = generateReport(metrics)

    // 状态机主效应（verify 固定）：ON+verify 5/5 vs OFF+verify 0/5 → b=0 c=5（每 task 各一组，共 6 组）
    for (const tid of ['A', 'B', 'C']) {
      expect(report).toContain(`- ${tid} (verify): ON+verify 5/5 vs OFF+verify 0/5 | b=0 c=5`)
      // 状态机主效应（no-verify）：ON+no-verify 4/5 vs OFF+no-verify 5/5 → b=1 c=0（seed 4：OFF 过 ON 败）
      expect(report).toContain(`- ${tid} (no-verify): ON+no-verify 4/5 vs OFF+no-verify 5/5 | b=1 c=0`)
    }
    // verify 主效应（状态机固定）：on+verify 5/5 vs on+no-verify 4/5 → b=0 c=1
    expect(report).toContain('- A (on): on+verify 5/5 vs on+no-verify 4/5 | b=0 c=1')
    // verify 主效应（off）：off+verify 0/5 vs off+no-verify 5/5 → b=5 c=0
    expect(report).toContain('- A (off): off+verify 0/5 vs off+no-verify 5/5 | b=5 c=0')
    // 交互 2×2 列联表：表头 + A 行 Δ 值
    expect(report).toContain('| task | verify | ON 率 | OFF 率 | Δ(ON-OFF) |')
    expect(report).toContain('| A | verify | 5/5 | 0/5 | 1.00 |')
    expect(report).toContain('| A | no-verify | 4/5 | 5/5 | -0.20 |')
    // 逐格 pass 数组按 seed 升序（乱序输入 → 序列仍正确）
    expect(report).toContain('| on+no-verify | A | 1/1/1/1/0 |')
    expect(report).toContain('| off+verify | A | 0/0/0/0/0 |')
  })

  it('非法尝试率段 4 配置通用：OFF 前缀用 illegalProposalCount、ON 前缀用 correctionCount', () => {
    const metrics: RunMetrics[] = [
      { runId: 'o1', config: 'off+verify', taskId: 'A', seed: 0, pass: false, failureMode: 'no-pass', rounds: 3, escalateCount: 0, correctionCount: 9, illegalProposalCount: 4, totalTransitions: 2, latencyMs: 10, tracePath: '' },
      { runId: 'o2', config: 'off+no-verify', taskId: 'A', seed: 0, pass: false, failureMode: 'no-pass', rounds: 3, escalateCount: 0, correctionCount: 7, illegalProposalCount: 6, totalTransitions: 2, latencyMs: 10, tracePath: '' },
      { runId: 'n1', config: 'on+verify', taskId: 'A', seed: 0, pass: true, failureMode: 'pass', rounds: 5, escalateCount: 0, correctionCount: 3, illegalProposalCount: 99, totalTransitions: 3, latencyMs: 10, tracePath: '' },
    ]
    const report = generateReport(metrics)
    expect(report).toContain('- off+verify: 4（1 runs，avg 4.00）')   // illegalProposalCount
    expect(report).toContain('- off+no-verify: 6（1 runs，avg 6.00）') // illegalProposalCount
    expect(report).toContain('- on+verify: 3（1 runs，avg 3.00）')     // correctionCount（忽略 illegalProposalCount=99）
  })
})

// —— P6 T9: runOne env 残留修复——saveRunEnv/restoreRunEnv 纯函数（runOne 主体 finally 调 restore；
//    直接测函数不触发 30-run driver；runOne 内部依赖 DB/LLM 复杂，抽纯函数最小可测）——
describe('P6 T9: runOne env 恢复（finally 还原 EXPERIMENT_STATE_MACHINE/VERIFY，防残留污染进程内后续 run）', () => {
  afterEach(() => {
    delete process.env.EXPERIMENT_STATE_MACHINE
    delete process.env.EXPERIMENT_VERIFY
  })
  it('原值已设(off/off) → restore 回写为 off（不被 run 期间改写残留）', () => {
    process.env.EXPERIMENT_STATE_MACHINE = 'off'
    process.env.EXPERIMENT_VERIFY = 'off'
    const prev = saveRunEnv()
    // 模拟 runOne 主体改写：状态机设 foo、verify 被 delete（config 依赖）
    process.env.EXPERIMENT_STATE_MACHINE = 'foo'
    delete process.env.EXPERIMENT_VERIFY
    restoreRunEnv(prev)
    expect(process.env.EXPERIMENT_STATE_MACHINE).toBe('off')
    expect(process.env.EXPERIMENT_VERIFY).toBe('off')
  })
  it('原值未设(undefined) → restore delete 回 undefined（保持 未设=默认on 语义）', () => {
    delete process.env.EXPERIMENT_STATE_MACHINE
    delete process.env.EXPERIMENT_VERIFY
    const prev = saveRunEnv()
    process.env.EXPERIMENT_STATE_MACHINE = 'off'
    process.env.EXPERIMENT_VERIFY = 'off'
    restoreRunEnv(prev)
    expect(process.env.EXPERIMENT_STATE_MACHINE).toBeUndefined()
    expect(process.env.EXPERIMENT_VERIFY).toBeUndefined()
  })
  it('saveRunEnv 捕获当前两开关原值', () => {
    process.env.EXPERIMENT_STATE_MACHINE = 'off'
    delete process.env.EXPERIMENT_VERIFY
    const prev = saveRunEnv()
    expect(prev.EXPERIMENT_STATE_MACHINE).toBe('off')
    expect(prev.EXPERIMENT_VERIFY).toBeUndefined()
  })
})

// —— 60 次 run（Spec §3.3：3任务×4配置×5次；P6 T8 扩 2×2 矩阵；5 固定 seed 同 seed 配对主效应）——
const SEEDS = [0, 1, 2, 3, 4]
describe('P5 pilot: 60 次受控实验（4 配置 2×2 矩阵）', () => {
  // setupExperiment 仅 30-run 需要（建库 + 实验 agents + preflight 真 LLM 调用）。
  // harness 纯函数单测不调它——preflight 需要真实 GLM key，无 key 时只跑单测 describe
  beforeAll(async () => {
    // 幂等重置：跨次运行不留旧 metrics.jsonl（否则 30-run 重跑叠加成 60/90 行，破坏每格 N=5 受控对比，T7 stats 会错）
    rmSync(join(CONFIG.resultsDir, 'metrics.jsonl'), { force: true })
    await setupExperiment()
  }, 30 * 60 * 1000)
  afterAll(async () => {
    // 生成报告（Spec §11）
    const report = generateReport(loadMetrics())
    console.log('\n===== P5 PILOT REPORT =====\n' + report)
  }, 60 * 1000)

  for (const task of TASKS) {
    for (const config of CONFIG.configs) {
      for (const seed of SEEDS) {
        it(`${config} ${task.id} seed=${seed}`, async () => {
          // P6 A1: mock factory 按 currentTaskId 取 task 罐头（架构师 decompose 消费）
          mocks.state.currentTaskId = task.id
          const m = await runOne({ config, taskId: task.id, seed })
          // M2：断言 m 结构完整（原 includes(m.failureMode) 对 5 值联合类型恒真，是重言式）
          expect(m.runId).toBeTruthy()
          expect(typeof m.pass).toBe('boolean')
          expect(m.rounds).toBeGreaterThanOrEqual(0)
        }, 30 * 60 * 1000)
      }
    }
  }
})
