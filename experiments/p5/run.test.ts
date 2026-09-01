import { describe, it, beforeAll, afterAll, afterEach, expect, vi } from 'vitest'
import { writeFileSync, rmSync, mkdtempSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { CONFIG, isP9ArmsOnly, parseGateCell } from './config'
import { TASKS } from './tasks'
import { setupExperiment } from './setup'
import { runOne, saveRunEnv, restoreRunEnv, applyRunEnv, createdWorkDirs } from './run-one'
import { loadMetrics, appendMetrics, countIllegalProposals, resolveFailureMode, classifyFailKind, type FailKind, type RunMetrics } from './metrics'
import { bootstrapCI, mcnemarExact, pairedMcNemar, seedNoise } from './stats'
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
  // P7-A: delegate 中性抽象 JSON（F1 无引导根；委派后端工程师等消费端不 JSON.parse 亦可安全显示）
  const DELEGATE_NEUTRAL_JSON = JSON.stringify({
    tasks: [{ id: 1, description: '拆解得出的子任务', assignedAgent: '后端工程师', dependencies: [], declared_files: [] }],
  })
  const state = { currentTaskId: 'A' as 'A' | 'B' | 'C' }
  const mockExecuteTaskBatch = vi.fn(async (tasks: any[]) => {
    const results = new Map<string, { result: string; sessionId?: string }>()
    for (const t of tasks) results.set(t.id, { result: 'SUCCESS', sessionId: undefined })
    return { results, preloadedIds: [], failedTaskIds: [], failedTaskReasons: {} }
  })
  return { mockExecuteTaskBatch, preflightPromptMarker, qaPromptMarker, cannedTasksByTask, state, DELEGATE_NEUTRAL_JSON }
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
      //    判定用 agent.name 精确相等（P8 收窄）：成员调用点均传真实名（alignment.ts:88/162/305），
      //    handleOrchestratorChat 恒传 name:'Orchestrator'（chat-router.ts:271）。不用 systemPrompt 子串——
      //    Orchestrator 的 prompt 含「当前会话中的 Agent：- 架构师…」名单（chat-router.ts:249-253），
      //    旧 sp.includes('架构师') 曾误命中致 60-run 8 条 off-C defect 伪影（p5.db 实证）。
      //    架构师(decompose) → 按 task 罐头任务 JSON（alignment.ts:171 parseJSON 可解析建任务）；
      //    测试工程师(非 QA 兜底) → '无问题'；产品经理(PM) → 语义句（handlePMConfirm 不 JSON.parse）；其余(delegate/self) → 语义句。
      if (agent?.name === '架构师') return { result: mocks.cannedTasksByTask[mocks.state.currentTaskId] }
      if (agent?.name === '测试工程师') return { result: '无问题' }
      if (agent?.name === '产品经理') return { result: '已确认需求，请架构师拆解。' }
      // P7-A: delegate/self 拆开（旧唯一 return 语义句引导 execute 抹平 ON/OFF 对比）。
      // self = orchestrator 自执行（handleOrchestratorChat 恒传 name:'Orchestrator'，chat-router.ts:271）
      //       → 中性文本，不可解析（F3 shape 契约）。
      // delegate = 委派目标 agent（delegateToAgent 传真实名如 后端工程师，review.ts:143）
      //       → 中性抽象 JSON（F1 无引导根）。
      // ⚠️ 边界：成员 name 判别在前 → 若委派目标是架构师/测试工程师/产品经理，
      //       会命中对应成员分支返回其罐头而非中性 delegate JSON。当前 3 任务委派目标
      //       均为后端工程师（不触发），故不阻塞；未来若加「委派给这三类成员」的任务需重排分支优先级。
      if (agent?.name === 'Orchestrator') return { result: '我已处理，结果如下。' } // self
      return { result: mocks.DELEGATE_NEUTRAL_JSON } // delegate
    }),
    // discuss 路径：runMultiAgentDiscussion → runDiscussion（adapter 直连，不经 executeSingleAgent）→ mock 防真实 CLI hang（审查 ❌A）
    runDiscussion: vi.fn(async () => ['罐头讨论意见（agent A 认为应澄清需求）', '罐头讨论意见（agent B 同意推进）']),
  }
})
vi.mock('@/lib/mcp-config', () => ({ buildMCPConfig: () => undefined }))

// —— P9-乙 T4: work/<runId> teardown——runOne 把 mkdtempSync 返回的精确路径注册进 createdWorkDirs，
//    这里逐个删除（无通配、路径来自 mkdtempSync 返回值本身；存量 398 泄漏另列一次性清理，不在此处）——
afterAll(() => {
  for (const d of createdWorkDirs) {
    try {
      rmSync(d, { recursive: true, force: true })
    } catch (e) {
      console.warn(`[teardown] rm workDir failed: ${d} — ${e instanceof Error ? e.message : String(e)}`)
    }
  }
})

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
  it('P7-A failKind: 穷尽 + 按 off/on 分列（F2/F4/F5）', () => {
    // 仅供逻辑验证——collectMetrics 本身查 DB，这里测纯的 failKind 归类 seed 需 mock prisma；
    // 为不依赖 DB，用可注入的判定函数（classifyFailKind）。
    const cases: Array<{ failureMode: string; done: boolean; requiredEdgesOk: boolean; onConformanceOk: boolean; config: string; expect: FailKind | undefined }> = [
      { failureMode: 'pass', done: true, requiredEdgesOk: true, onConformanceOk: true, config: 'on+verify', expect: undefined },
      { failureMode: 'error', done: true, requiredEdgesOk: true, onConformanceOk: true, config: 'on+verify', expect: 'defect' }, // 异常→defect(F2)
      { failureMode: 'stuck', done: false, requiredEdgesOk: true, onConformanceOk: true, config: 'off+verify', expect: 'defect' }, // 未done→defect
      { failureMode: 'no-pass', done: true, requiredEdgesOk: false, onConformanceOk: true, config: 'off+verify', expect: 'skipped-spec-edge' }, // OFF缺规范边→状态机价值
      { failureMode: 'no-pass', done: true, requiredEdgesOk: true, onConformanceOk: false, config: 'on+verify', expect: 'done-but-conformance' }, // ON违规→状态机价值
      { failureMode: 'no-pass', done: false, requiredEdgesOk: false, onConformanceOk: true, config: 'off+verify', expect: 'defect' }, // 未done优先于缺边
    ]
    for (const c of cases) {
      expect(classifyFailKind(c.failureMode, c.done, c.requiredEdgesOk, c.onConformanceOk, c.config)).toBe(c.expect)
    }
    // total：畸形输入不 throw（F4）
    expect(() => classifyFailKind('no-pass', true, false, true, 'off+no-verify')).not.toThrow()
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
  it('delegate（名≠Orchestrator）返回中性抽象 JSON：可解析、description 无引导根、非旧引导句', async () => {
    const { executeSingleAgent } = await import('@/lib/orchestrator')
    const r = await (executeSingleAgent as any)(
      { name: '后端工程师', systemPrompt: '你是后端工程师，负责实现 API 与业务逻辑。' }, 'prompt', '', () => {})
    const parsed = JSON.parse(r.result) // 必须可解析（shape 契约 F3）
    expect(parsed.tasks).toHaveLength(1)
    expect(parsed.tasks[0].description).toBe('拆解得出的子任务')
    expect(parsed.tasks[0].declared_files).toEqual([])
    // 反引导红线(F1)：不返回旧引导句，description 不含 执行/实现/就绪/继续 根
    expect(r.result).not.toBe('委派任务已受理并拆解为可执行任务，请安排执行。')
    for (const banned of ['执行', '实现', '就绪', '继续']) expect(parsed.tasks[0].description).not.toContain(banned)
  })
  it('self（名=Orchestrator）返回中性文本：不可解析（与 delegate shape 区分，F3）', async () => {
    const { executeSingleAgent } = await import('@/lib/orchestrator')
    const r = await (executeSingleAgent as any)(
      { name: 'Orchestrator', systemPrompt: '你是 Orchestrator' }, 'prompt', '', () => {})
    expect(r.result).toBe('我已处理，结果如下。')
    expect(() => JSON.parse(r.result)).toThrow()
  })
})

// —— P8 mock 判定按 name 收窄：Orchestrator 成员名单污染 systemPrompt 不得误入成员罐头分支 ——
// 根因（60-run 8 条 off-C defect，p5.db 实证）：handleOrchestratorChat 的 systemPrompt 含
// 「当前会话中的 Agent：\n- 架构师（…）」名单（chat-router.ts:249-253），旧 sp.includes('架构师')
// 先于 self/delegate 判别命中 → mock 误返 C 罐头 JSON → 下轮同上下文同决策 → no-progress break。
describe('P8 mock 判定按 name 收窄（成员名单污染防护）', () => {
  // 复刻 chat-router.ts:250-253 真实形态：agentList 把全部成员名拼进 Orchestrator systemPrompt
  const orchestratorSpWithRoster = [
    '你是 AgentHub 的 Orchestrator，一个多 Agent 协作平台的协调者。',
    '',
    '当前会话中的 Agent：',
    '- 架构师（系统设计与任务拆解，平台：test）',
    '- 测试工程师（测试编写与验证，平台：test）',
    '- 产品经理（需求分析与澄清，平台：test）',
  ].join('\n')

  it('self（name=Orchestrator，systemPrompt 含成员名单）不误入架构师罐头 → 中性文本', async () => {
    const { executeSingleAgent } = await import('@/lib/orchestrator')
    const r = await (executeSingleAgent as any)(
      { name: 'Orchestrator', systemPrompt: orchestratorSpWithRoster }, 'prompt', '', () => {})
    expect(r.result).toBe('我已处理，结果如下。') // 修复前：sp.includes('架构师') 命中返回罐头任务 JSON
    expect(() => JSON.parse(r.result)).toThrow() // 且保持 self shape 契约（不可解析）
  })

  it('self（name=Orchestrator，systemPrompt 含测试工程师/产品经理名单）不误入对应分支', async () => {
    const { executeSingleAgent } = await import('@/lib/orchestrator')
    const sp = '你是 Orchestrator。\n当前会话中的 Agent：\n- 测试工程师（测试编写与验证，平台：test）\n- 产品经理（需求分析与澄清，平台：test）'
    const r = await (executeSingleAgent as any)(
      { name: 'Orchestrator', systemPrompt: sp }, 'prompt', '', () => {})
    expect(r.result).toBe('我已处理，结果如下。') // 修复前：sp.includes('测试工程师') 命中返回 '无问题'
  })

  it('回归守卫：非 QA 调用（prompt 无 qa marker）的测试工程师仍回 无问题（收窄后按 name 命中）', async () => {
    const { executeSingleAgent } = await import('@/lib/orchestrator')
    const r = await (executeSingleAgent as any)(
      { name: '测试工程师', systemPrompt: '你是测试工程师，负责编写测试并验证实现。' }, 'prompt', '', () => {})
    expect(r.result).toBe('无问题')
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
  it('mcnemarExact: b=0,c=4 → 0.125（P9-乙 C 格校准锚点）；b+c=0 → 1；n=1 → 1；b=0,c=8 → 0.0078125', () => {
    expect(mcnemarExact(0, 4)).toBeCloseTo(0.125, 6)
    expect(mcnemarExact(0, 0)).toBe(1)
    expect(mcnemarExact(1, 0)).toBe(1)
    expect(mcnemarExact(0, 8)).toBeCloseTo(0.0078125, 8)
  })
  it('pairedMcNemar 增 pExact：off全败on全过 → b=0 c=4，渐近≈0.0455 与精确 0.125 并列', () => {
    const r = pairedMcNemar([false, false, false, false], [true, true, true, true])
    expect(r.b).toBe(0); expect(r.c).toBe(4)
    expect(r.pValue).toBeCloseTo(0.0455, 3)
    expect(r.pExact).toBeCloseTo(0.125, 5)
  })
  it('generateReport 含环境快照段与 p_exact 行（P10 读分标记）', () => {
    const mk = (config: string, seed: number, pass: boolean): RunMetrics => ({
      runId: `${config}-${seed}`, config: config as RunMetrics['config'], taskId: 'A', seed, pass,
      failureMode: pass ? 'pass' : 'no-pass', rounds: 5, escalateCount: 0, correctionCount: 0,
      illegalProposalCount: 0, totalTransitions: 3, latencyMs: 1000, tracePath: 'x',
    })
    const rows: RunMetrics[] = []
    for (let s = 0; s < 5; s++) rows.push(mk('off+verify', s, false))
    for (let s = 0; s < 5; s++) rows.push(mk('on+verify', s, s < 4))
    const rep = generateReport(rows)
    expect(rep).toContain('## 环境快照')
    expect(rep).toContain('p_exact=')
    expect(rep).toContain('key 指纹')
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

// —— P6 T8: 2×2 状态机×verify 主效应矩阵（P9-乙 T3 起 configs 扩为 5：三臂 + seqgate 增量格）——
describe('P6 T8: 状态机×verify 主效应矩阵', () => {
  it('CONFIG.configs 当前规模 + envForConfig 映射正确', () => {
    // P9-乙 T3：扩为 5 配置（三臂矩阵 + on-seqgate+verify）；前缀约定保 startsWith('on')/('off') 口径
    expect(CONFIG.configs).toEqual(['on+verify', 'on+no-verify', 'off+verify', 'off+no-verify', 'on-seqgate+verify'])
    expect(CONFIG.envForConfig('on+verify')).toEqual({ EXPERIMENT_STATE_MACHINE: undefined, EXPERIMENT_VERIFY: undefined, EXPERIMENT_SEQGATE: undefined })
    expect(CONFIG.envForConfig('on+no-verify')).toEqual({ EXPERIMENT_STATE_MACHINE: undefined, EXPERIMENT_VERIFY: 'off', EXPERIMENT_SEQGATE: undefined })
    expect(CONFIG.envForConfig('off+verify')).toEqual({ EXPERIMENT_STATE_MACHINE: 'off', EXPERIMENT_VERIFY: undefined, EXPERIMENT_SEQGATE: undefined })
    expect(CONFIG.envForConfig('off+no-verify')).toEqual({ EXPERIMENT_STATE_MACHINE: 'off', EXPERIMENT_VERIFY: 'off', EXPERIMENT_SEQGATE: undefined })
  })

  it('generateReport: 全配置×3任务×5seed 输出状态机主效应+verify 主效应+交互（b/c 手算正确，配对按 seed 排序）', () => {
    // 已知 pass 数据（seed 0..4）：
    //   on+verify / off+no-verify 全过；off+verify 全败；on+no-verify 仅 seed 4 败
    const passBy: Record<string, boolean[]> = {
      'on+verify': [true, true, true, true, true],
      'off+no-verify': [true, true, true, true, true],
      'off+verify': [false, false, false, false, false],
      'on+no-verify': [true, true, true, true, false],
      'on-seqgate+verify': [true, true, false, false, false], // P9-乙 T3 第 5 格（逐格循环天然吃）
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
    // P9-乙 T3: 第 5 格逐格行 + 状态机主效应第三组（OFF vs ON-seqgate 配对：sg 2/5 vs off 0/5 → b=0 c=2）
    expect(report).toContain('| on-seqgate+verify | A | 1/1/0/0/0 |')
    expect(report).toContain('- A (seqgate): ON-seqgate+verify 2/5 vs OFF+verify 0/5 | b=0 c=2')
    // seqgate 臂增量小节（ON vs ON-seqgate 同臂配对：on 5/5 vs sg 2/5 → b=3 c=0）
    expect(report).toContain('## seqgate 臂增量（ON vs ON-seqgate）')
    expect(report).toContain('- A: on+verify 5/5 vs on-seqgate+verify 2/5 | b=3 c=0')
    // 合计行：fixture 未设 gateInterventionCount → ?? 0 合并（旧行兼容），15 runs = 3 任务 × 5 seed
    expect(report).toContain('- seqgate 触发合计: 0（15 runs，avg 0.00）')
  })

  it('非法尝试率段全配置通用：OFF 前缀用 illegalProposalCount、ON 前缀用 correctionCount', () => {
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
  it('P9-乙 T3: seqgate 触发合计行（gateInterventionCount 求值 + 旧行 ?? 0 合并）', () => {
    const metrics: RunMetrics[] = [
      // on-seqgate 新行带 gateInterventionCount：2 + 0（「开了没触发」也要计入 runs 分母）
      { runId: 'sg1', config: 'on-seqgate+verify', taskId: 'A', seed: 0, pass: true, failureMode: 'pass', rounds: 4, escalateCount: 0, correctionCount: 1, illegalProposalCount: 0, totalTransitions: 3, latencyMs: 10, tracePath: '', gateInterventionCount: 2 },
      { runId: 'sg2', config: 'on-seqgate+verify', taskId: 'A', seed: 1, pass: false, failureMode: 'no-pass', rounds: 6, escalateCount: 0, correctionCount: 0, illegalProposalCount: 0, totalTransitions: 2, latencyMs: 11, tracePath: '', gateInterventionCount: 0 },
      // on 臂同 trace 场景字段缺省 → 不入 seqgate 合计（臂间区分「没开」）
      { runId: 'on1', config: 'on+verify', taskId: 'A', seed: 0, pass: true, failureMode: 'pass', rounds: 4, escalateCount: 0, correctionCount: 5, illegalProposalCount: 0, totalTransitions: 3, latencyMs: 10, tracePath: '' },
    ]
    const report = generateReport(metrics)
    expect(report).toContain('- seqgate 触发合计: 2（2 runs，avg 1.00）')
  })

  it('P7-A: report 含 failKind 诊断段（no-pass 分解，value vs defect 两列）', () => {
    const metrics: RunMetrics[] = [
      { runId: 'v1', config: 'off+verify', taskId: 'A', seed: 0, pass: false, failureMode: 'no-pass', rounds: 3, escalateCount: 0, correctionCount: 0, illegalProposalCount: 1, totalTransitions: 2, latencyMs: 10, tracePath: '', failKind: 'skipped-spec-edge' },
      { runId: 'e1', config: 'on+verify', taskId: 'A', seed: 1, pass: false, failureMode: 'error', rounds: 2, escalateCount: 0, correctionCount: 0, illegalProposalCount: 0, totalTransitions: 0, latencyMs: 8, tracePath: '', failKind: 'defect' },
    ]
    const report = generateReport(metrics)
    expect(report).toContain('## failKind 诊断（no-pass 分解）')
    // 表格式输出（与实现的行一致，勿用人类格式子串）：
    // v1=skipped-spec-edge(价值格,s1) → value=1 defect=0, fmLine 只统计 defect→ '—'
    // e1=failKind defect + failureMode error → value=0 defect=1, fmLine='error:1'
    expect(report).toContain('| off+verify | A | 1 | 0 | — |')
    expect(report).toContain('| on+verify | A | 0 | 1 | error:1 |')
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

// —— P9-乙 T3: 三臂配置矩阵（configs 扩 on-seqgate+verify + 三变量 env 快照 + applyRunEnv + gateInterventionCount）——
describe('P9-乙 T3: 三臂配置矩阵', () => {
  afterEach(() => {
    delete process.env.EXPERIMENT_STATE_MACHINE
    delete process.env.EXPERIMENT_VERIFY
    delete process.env.EXPERIMENT_SEQGATE
  })

  it('CONFIG.configs 含 on-seqgate+verify 且 envForConfig 三开关映射正确', () => {
    expect(CONFIG.configs).toContain('on-seqgate+verify')
    const env = CONFIG.envForConfig('on-seqgate+verify')
    expect(env.EXPERIMENT_SEQGATE).toBe('on')
    expect(env.EXPERIMENT_STATE_MACHINE).toBeUndefined()   // ON 臂语义
    expect(env.EXPERIMENT_VERIFY).toBeUndefined()
    // 前缀约定钉死：既有消费点对新配置名落正确口径
    expect('on-seqgate+verify'.startsWith('on')).toBe(true)   // ON 口径（corr 列）
    expect('on-seqgate+verify'.startsWith('off')).toBe(false) // 不落 OFF 口径
  })

  it('RunEnvSnapshot 三变量 save/restore 往返（T9 同款，F4 必办②）', () => {
    process.env.EXPERIMENT_STATE_MACHINE = 'keep-sm'
    process.env.EXPERIMENT_VERIFY = 'keep-v'
    process.env.EXPERIMENT_SEQGATE = 'keep-sg'
    const prev = saveRunEnv()
    expect(prev.EXPERIMENT_SEQGATE).toBe('keep-sg')
    process.env.EXPERIMENT_SEQGATE = 'changed'
    restoreRunEnv(prev)
    expect(process.env.EXPERIMENT_SEQGATE).toBe('keep-sg')
    // undefined→delete 语义
    delete process.env.EXPERIMENT_SEQGATE
    const prev2 = saveRunEnv()
    restoreRunEnv(prev2)
    expect(process.env.EXPERIMENT_SEQGATE).toBeUndefined()
  })

  it('applyRunEnv 三键透传（审查 D：封堵 runOne 忘写透传行的第四种静默退化）', () => {
    applyRunEnv({ EXPERIMENT_STATE_MACHINE: undefined, EXPERIMENT_VERIFY: undefined, EXPERIMENT_SEQGATE: 'on' })
    expect(process.env.EXPERIMENT_SEQGATE).toBe('on')
    expect(process.env.EXPERIMENT_STATE_MACHINE).toBeUndefined()
    applyRunEnv({ EXPERIMENT_STATE_MACHINE: 'off', EXPERIMENT_VERIFY: undefined, EXPERIMENT_SEQGATE: undefined })
    expect(process.env.EXPERIMENT_STATE_MACHINE).toBe('off')
    expect(process.env.EXPERIMENT_SEQGATE).toBeUndefined()   // delete 语义
  })

  it('configs 数组遍历式断言（审查 D 升级：防拼写漂移脱钩）', () => {
    const seqgateConfigs = CONFIG.configs.filter(c => c.startsWith('on-seqgate'))
    expect(seqgateConfigs).toHaveLength(1)
    expect(CONFIG.envForConfig(seqgateConfigs[0]).EXPERIMENT_SEQGATE).toBe('on')
  })

  it('collectMetrics 采 gateInterventionCount（结构化信号，非 reason 子串）', async () => {
    // 构造 trace entries：idle 态决策点 corrections=[{from:'done',to:'align_decompose'}]
    // （chat-router seqgate 拦截的结构化签名：(idle, done→align_decompose)，reason 子串不参与判定）
    const seqgateEntry = {
      decisionPoint: 'handleOrchestratorDecision',
      inputState: { phase: 'idle', phaseStep: '', state: 'idle' },
      llmProposal: { action: 'done', target: null, targets: null, reason: 'LLM 提议直接完成' },
      corrections: [{ from: 'done', to: 'align_decompose', reason: '序列闸门：会话尚无任务，需先对齐拆解（当前 0 任务）' }],
      validation: { passed: true, validator: 'applyTransition' },
      actualTransition: { from: 'idle', to: 'align_pm', action: 'align_decompose', applied: true, escalated: false },
    }
    const trace = JSON.stringify([seqgateEntry])
    vi.resetModules()
    vi.doMock('@/lib/db', () => ({
      prisma: { session: { findUnique: async () => ({ id: 's-fix', phase: 'align_pm', decisionTrace: trace }) } },
    }))
    try {
      const { collectMetrics } = await import('./metrics')
      const sg = await collectMetrics('r-sg', 's-fix', 'on-seqgate+verify', 'A', 0, 3, 0, 10)
      expect(sg.gateInterventionCount).toBe(1)
      // 同 trace 跑 on 臂 → 字段 undefined（臂间区分「没开」vs「开了没触发」）
      const on = await collectMetrics('r-on', 's-fix', 'on+verify', 'A', 0, 3, 0, 10)
      expect(on.gateInterventionCount).toBeUndefined()
      // off 臂同样 undefined
      const off = await collectMetrics('r-off', 's-fix', 'off+verify', 'A', 0, 3, 0, 10)
      expect(off.gateInterventionCount).toBeUndefined()
    } finally {
      vi.doUnmock('@/lib/db')
      vi.resetModules()
    }
  })

  it('防呆断言（F4 核心）：SEQGATE 未设时 on-seqgate 臂不得静默等同 on 臂', () => {
    // 若此断言失败 = 配置名拼错/漏改 envForConfig → seqgate 臂静默退化（fail-unsafe 场景）
    expect(CONFIG.envForConfig('on-seqgate+verify').EXPERIMENT_SEQGATE).toBe('on')
    expect(CONFIG.envForConfig('on+verify').EXPERIMENT_SEQGATE).toBeUndefined()
  })
})

// —— P9-乙 T4: work/<runId> teardown 接线——runOne 注册精确路径进 createdWorkDirs，文件级 afterAll 逐个删。
//    本 describe 注册一个 mkdtemp 目录验证数组接线；文件级 afterAll 删除后，OS 层核实目录已消失（见 teardown 验证）——
describe('P9-乙 T4: work teardown 接线（createdWorkDirs 注册 + 文件级 afterAll 清理）', () => {
  it('注册 mkdtemp 精确路径进 createdWorkDirs（无通配，路径来自返回值本身）', () => {
    const dir = mkdtempSync(join(CONFIG.workDir, '__t4-teardown-probe-'))
    createdWorkDirs.push(dir)
    // 注册的是 mkdtempSync 的真实返回路径（精确、非前缀拼凑）
    expect(createdWorkDirs).toContain(dir)
    expect(existsSync(dir)).toBe(true)
  })
})

// —— P9-乙 T5: 全矩阵三臂门控（P9 拍板 verify 固定 on；首跑实证 configs 全 5 配置会跑成 75 run 的接线缺口）——
describe('P9-乙 T5: 三臂门控 P9_ARMS', () => {
  it('P9_ARMS 严格相等：仅 "1" 激活（同 F4 口径，杜绝第四静默降级路径）', () => {
    expect(isP9ArmsOnly({ P9_ARMS: '1' })).toBe(true)
    expect(isP9ArmsOnly({ P9_ARMS: '0' })).toBe(false)
    expect(isP9ArmsOnly({ P9_ARMS: 'true' })).toBe(false)
    expect(isP9ArmsOnly({})).toBe(false)
  })
  it('三臂 = configs 去掉 no-verify 且顺序保持（45 run 的格集合钉死）', () => {
    expect(CONFIG.configs.filter((c) => !c.includes('no-verify'))).toEqual(['on+verify', 'off+verify', 'on-seqgate+verify'])
  })
  it('parseGateCell：非 P7_GATE=1 → null；默认格 on-seqgate+verify|A；参数格正确解析', () => {
    expect(parseGateCell({})).toBeNull()
    expect(parseGateCell({ P7_GATE: '0' })).toBeNull()
    expect(parseGateCell({ P7_GATE: '1' })).toEqual({ config: 'on-seqgate+verify', taskId: 'A' })
    expect(parseGateCell({ P7_GATE: '1', P7_GATE_CELL: 'off+verify|A' })).toEqual({ config: 'off+verify', taskId: 'A' })
  })
  it('parseGateCell：格式非法 fail-closed throw（不允许静默跑错格）', () => {
    expect(() => parseGateCell({ P7_GATE: '1', P7_GATE_CELL: 'off+verify' })).toThrow(/非法/)
    expect(() => parseGateCell({ P7_GATE: '1', P7_GATE_CELL: 'off+verify|D' })).toThrow(/非法/)
    expect(() => parseGateCell({ P7_GATE: '1', P7_GATE_CELL: 'off+verify|A|extra' })).toThrow(/非法/)
    expect(() => parseGateCell({ P7_GATE: '1', P7_GATE_CELL: '|A' })).toThrow(/非法/)
  })
})

// —— 60+ 次 run（3任务 × configs 全臂 × 5 seed；5 固定 seed 同 seed 配对主效应）——
const SEEDS = [0, 1, 2, 3, 4]
const SENTINEL = process.env.P5_SENTINEL === '1'
describe.skipIf(!process.env.GLM_API_KEY || SENTINEL)('P5 pilot: 受控实验全矩阵跑批（configs 全臂 × 3 任务 × 5 seed）', () => {
  // setupExperiment 仅 30-run 需要（建库 + 实验 agents + preflight 真 LLM 调用）。
  // harness 纯函数单测不调它——preflight 需要真实 GLM key，无 key 时只跑单测 describe
  beforeAll(async () => {
    // 幂等重置：跨次运行不留旧 metrics.jsonl（否则 30-run 重跑叠加成 60/90 行，破坏每格 N=5 受控对比，T7 stats 会错）
    rmSync(join(CONFIG.resultsDir, 'metrics.jsonl'), { force: true })
    await setupExperiment()
  }, 35 * 60 * 1000)
  // P10 T3-fix-r1（Step7-3）：本批注册了多少条真 LLM run——check 机判靠它做「标记 vs 落盘」双账对齐，
  // 不再让启动器猜 vitest 的 passed 计数（那个数含恒跑单测，条数随任务增删而漂移）。
  let batchExpected = 0
  afterAll(async () => {
    // 生成报告（Spec §11）
    const report = generateReport(loadMetrics())
    console.log('\n===== P5 PILOT REPORT =====\n' + report)
    // 机器可读收尾标记：runs=注册数 rows=实际落盘数；两者不等 ⇒ 批中途掉行（见 run-gate-smoke.ps1 check）
    console.log('[P5-BATCH] runs=' + batchExpected + ' rows=' + loadMetrics().length)
  }, 60 * 1000)

  // P9-乙 T5 Gate 冒烟过滤格：默认 on-seqgate+verify × A（T6 起可由 P7_GATE_CELL 参数化，如探带格 off+verify|A）
  const P7_GATE = parseGateCell()
  // P9-乙 T5 全矩阵三臂：P9_ARMS=1 跳过 no-verify 格（未设=5 配置全量，P6 2×2 语义不变）
  const P9_ARMS = isP9ArmsOnly()
  for (const task of TASKS) {
    for (const config of CONFIG.configs) {
      if (P9_ARMS && config.includes('no-verify')) continue
      for (const seed of SEEDS) {
        if (P7_GATE && (config !== P7_GATE.config || task.id !== P7_GATE.taskId)) continue
        batchExpected++ // 过完两道过滤才算真注册了一条 LLM run（gate/matrix 模式下这个数分别是 5 / 45）
        it(`${config} ${task.id} seed=${seed}`, async () => {
          // P6 A1: mock factory 按 currentTaskId 取 task 罐头（架构师 decompose 消费）
          mocks.state.currentTaskId = task.id
          const m = await runOne({ config, taskId: task.id, seed })
          // M2：断言 m 结构完整（原 includes(m.failureMode) 对 5 值联合类型恒真，是重言式）
          expect(m.runId).toBeTruthy()
          expect(typeof m.pass).toBe('boolean')
          expect(m.rounds).toBeGreaterThanOrEqual(0)
        }, 35 * 60 * 1000)
      }
    }
  }
})

// P10（spec §2.2-③）：控制组哨兵——只跑 setupExperiment（含 preflight），探带批末「判环境不判模型」回归用
describe.skipIf(!SENTINEL || !process.env.GLM_API_KEY)('P10 sentinel: preflight-only（控制组回归）', () => {
  it('setupExperiment preflight 通过', async () => { await setupExperiment() }, 5 * 60 * 1000)
})
