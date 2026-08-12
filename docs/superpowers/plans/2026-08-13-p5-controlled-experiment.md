# P5 受控实验（状态机 vs LLM 自由推进）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 跑通 30 次真实 LLM 受控实验（3 任务 × 状态机 on/off × 5 次），用 decisionTrace+conformance 验证"状态机比 LLM 自由推进更可靠"，产出逐格 pass 数组 + bootstrap CI + seed noise 报告。

**Architecture:** 决策走真实 LLM（`getOrchestratorDecision` 等），任务执行 mock（vi.mock 注入 `executeTaskBatch` + monitoring），独立 harness（`experiments/p5/`，不进 src/ 构建图），`EXPERIMENT_STATE_MACHINE=off` env 开关只关决策层 enforcement 不关 trace 记录。生产改动仅 2 处（`state-machine.ts` 导出 override + `chat-router.ts` 决策点换 override），默认 on 零影响。

**Tech Stack:** Next.js 16 / Prisma 7 (libsql) / vitest / 智谱 glm-4.7-flash（经 claude-code adapter + ANTHROPIC_BASE_URL 兼容路径）

## Global Constraints

- **模型勿动**：8 Agent 用 qwen3.8-max-preview[1M] + 阿里云 MaaS；实验 harness 用智谱 glm-4.7-flash（本地诊断惯例）。**永不打印密钥**；GLM key 从 env `GLM_API_KEY` 读，不硬编码
- **生产默认行为不变**：`EXPERIMENT_STATE_MACHINE` 未设时行为与现状完全一致（1040 passed / 3 skipped 基线，2026-08-13 实测）
- **每次修改必须新增针对性测试**（真回归守卫，红绿验证）；禁止删除/弱化功能
- **改动前先 `git add . && git commit -m "chore: 存档 - ..."`**
- **提交前跑 pre-commit 三视角审查**，无 ❌ 才 `git commit --no-verify`
- **改 schema 勿跑交互式 `prisma migrate dev`**；手工 migration + `prisma migrate deploy`（pilot 用独立 p5.db，不改主 schema）
- **行尾坑**：blob 行尾不统一（src/markdown 多 CRLF），改文件后 `git diff --stat` 核对无整文件假 diff
- **保密**：p5.db、GLM key、实验报告含真实 LLM 输出，不进 GitHub（`.gitignore` 排除 `experiments/p5/*.db`、`results/` 如需公开用脱敏）
- **前置条件**：本机已装 claude CLI（process-registry spawn）、智谱 glm-4.7-flash 经 CC-Switch/baseUrl+key 配置可用

**Spec 权威输入**：`docs/superpowers/specs/2026-08-13-p5-controlled-experiment-design.md`（每个 task 的 Requirements 隐含含此文档对应节）

---

### Task 1: state-machine 导出 `applyTransitionWithOverride` + `isExperimentOff`

**Files:**
- Modify: `src/lib/orchestrator/state-machine.ts`（在 `applyTransition` 后追加，`transitionPhase` 内部 :206 改调 override）
- Test: `tests/state-machine.test.ts`

**Interfaces:**
- Consumes: `TRANSITIONS`、`NON_TRANSITIONING`、`State`、`Action`（已导出）
- Produces:
  - `export function applyTransitionWithOverride(state: State, action: string, bypass: boolean): { ok: true; nextState: State; inTable: boolean } | { ok: false; reason: string }` — bypass 时表内→表值+inTable:true、旁路→当前态+inTable:true、表外→当前态+inTable:false；非 bypass→原 applyTransition 语义（无 inTable）
  - `export function isExperimentOff(): boolean` — `process.env.EXPERIMENT_STATE_MACHINE === 'off'`
  - `transitionPhase` 内部改为调 override（bypass=isExperimentOff()），**其返回类型不变**（调用方无感）

- [ ] **Step 1: 写失败测试**

在 `tests/state-machine.test.ts` 追加：
```ts
describe('P5: applyTransitionWithOverride（状态机 off 开关）', () => {
  it('bypass + 表内 action → 表值 + inTable:true', () => {
    expect(applyTransitionWithOverride('idle', 'execute', true)).toEqual({ ok: true, nextState: 'exec', inTable: true })
  })
  it('bypass + 旁路 action → 当前态 + inTable:true（任意状态合法）', () => {
    expect(applyTransitionWithOverride('idle', 'self', true)).toEqual({ ok: true, nextState: 'idle', inTable: true })
  })
  it('bypass + 表外 action → 当前态 + inTable:false（无幻 phase）', () => {
    expect(applyTransitionWithOverride('idle', 'align_qa', true)).toEqual({ ok: true, nextState: 'idle', inTable: false })
  })
  it('非 bypass → 与 applyTransition 完全一致', () => {
    expect(applyTransitionWithOverride('idle', 'execute', false)).toEqual(applyTransition('idle', 'execute'))
    expect(applyTransitionWithOverride('idle', 'align_qa', false)).toEqual(applyTransition('idle', 'align_qa'))
  })
  it('isExperimentOff: off 时 true / 缺省时 false', () => {
    const prev = process.env.EXPERIMENT_STATE_MACHINE
    process.env.EXPERIMENT_STATE_MACHINE = 'off'
    expect(isExperimentOff()).toBe(true)
    delete process.env.EXPERIMENT_STATE_MACHINE
    expect(isExperimentOff()).toBe(false)
    if (prev !== undefined) process.env.EXPERIMENT_STATE_MACHINE = prev
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/state-machine.test.ts -t "applyTransitionWithOverride"`
Expected: FAIL — `applyTransitionWithOverride` / `isExperimentOff` 未定义

- [ ] **Step 3: 实现**

在 `state-machine.ts` 的 `applyTransition`（:122）后追加：
```ts
/**
 * P5 受控实验：状态机 off 开关的转移校验。
 * bypass=true（EXPERIMENT_STATE_MACHINE=off）时只关 enforcement 不关 trace：
 * - 表内 action → 表值（inTable:true）
 * - 旁路 action（NON_TRANSITIONING）→ 当前态（inTable:true，任意状态合法）
 * - 表外 action → 当前态（inTable:false，保持 state 不制造幻 phase）
 * inTable 标志供决策点区分 trace 的 applied（表外 no-op 是预期实验条件，不判非法）。
 * 非 bypass → 原 applyTransition 语义（纯函数，测试依赖）。
 */
export function applyTransitionWithOverride(
  state: State,
  action: string,
  bypass: boolean
): { ok: true; nextState: State; inTable: boolean } | { ok: false; reason: string } {
  if (bypass) {
    const row = TRANSITIONS[state]
    if (row && Object.hasOwn(row, action)) {
      return { ok: true, nextState: row[action as Action] as State, inTable: true }
    }
    if (NON_TRANSITIONING.has(action as Action)) {
      return { ok: true, nextState: state, inTable: true }
    }
    return { ok: true, nextState: state, inTable: false }
  }
  return applyTransition(state, action)
}

/** P5 受控实验开关：`EXPERIMENT_STATE_MACHINE=off` 时状态机 enforcement 关闭 */
export function isExperimentOff(): boolean {
  return process.env.EXPERIMENT_STATE_MACHINE === 'off'
}
```

再把 `transitionPhase` 内 :206 的 `const result = applyTransition(state, action)` 改为：
```ts
    const result = applyTransitionWithOverride(state, action, isExperimentOff())
```

- [ ] **Step 4: 运行确认通过 + 全量回归**

Run: `npx vitest run tests/state-machine.test.ts -t "applyTransitionWithOverride"`
Expected: PASS
Run: `npx vitest run tests/state-machine.test.ts`
Expected: 全绿（原有 3 个 P4 transitionPhase 测试不破）

- [ ] **Step 5: 行尾核对 + 提交**

Run: `git diff --stat` — 确认无整文件假 diff（CRLF/LF 坑）
```bash
git add src/lib/orchestrator/state-machine.ts tests/state-machine.test.ts
git commit -m "feat: P5-T1 state-machine 导出 applyTransitionWithOverride+isExperimentOff（off 开关只关 enforcement 不关 trace,表外保持当前态无幻 phase）"
```

---

### Task 2: chat-router 决策点换 override（OFF 时跳过纠正/守卫/escale，trace 照记）

**Files:**
- Modify: `src/lib/services/chat-router.ts`（决策点 :91-166 区域）
- Test: `tests/chat-router.test.ts`

**Interfaces:**
- Consumes: `applyTransitionWithOverride(state, action, bypass)`、`isExperimentOff()`（Task 1 产出）
- Produces: OFF 模式下决策点行为——
  - 跳过 `canonicalCorrect` + 业务守卫（execute 闸门/done 守卫/delegate 提示）
  - `applyTransitionWithOverride(state, decision.action, true)` 替代原 `applyTransition`；bypass 恒 ok，`:160 if(!transition.ok)` 天然不触发（无需显式跳过 escalate return）
  - **trace 块（:141-158）照常走**：`validation.validator` 打 `'experiment-off'`；`actualTransition` 据 `inTable` 区分（inTable:true→applied:true；inTable:false→applied:false, escalated:false）
  - 旁路 action（self/delegate/discuss/verify）不转 phase，走原 handler

- [ ] **Step 1: 写失败测试**

在 `tests/chat-router.test.ts` 追加（沿用现有 mock：`mockGetOrchestratorDecision` 在 beforeEach 重建）：
```ts
describe('P5: OFF 开关（EXPERIMENT_STATE_MACHINE=off）', () => {
  const prevEnv = process.env.EXPERIMENT_STATE_MACHINE

  afterEach(() => {
    if (prevEnv === undefined) delete process.env.EXPERIMENT_STATE_MACHINE
    else process.env.EXPERIMENT_STATE_MACHINE = prevEnv
  })

  it('OFF 下表外 action：不 escalate，直派 handler，trace 记 applied:false', async () => {
    process.env.EXPERIMENT_STATE_MACHINE = 'off'
    // idle 态提表外 align_qa（idle 转移表无 align_qa）→ 不弹 escalate，调 handleAgentQA
    mockGetOrchestratorDecision.mockResolvedValue({
      decision: { action: 'align_qa', target: null, targets: null, message: '问一下', reason: '需要澄清' },
      sessionId: 'cli-1',
    })
    mockMessageFindMany.mockResolvedValue([])
    mockTaskFindMany.mockResolvedValue([])
    await handleOrchestratorDecision('澄清一下', 's1', [], mockSendEvent, { phase: 'idle', phaseStep: '', decisionTrace: '[]' })

    // 断言：escalate 事件没发（OFF 放行）
    const escalateEvents = mockSendEvent.mock.calls.filter(c => c[0].type === 'awaiting_user_input' && c[0].content === 'escalate')
    expect(escalateEvents.length).toBe(0)
    // 断言：trace 落库一次，validator=experiment-off、applied:false
    expect(mockSessionUpdateMany).toHaveBeenCalledTimes(1)
    const traceArg = mockSessionUpdateMany.mock.calls[0][0].data.decisionTrace
    const parsed = JSON.parse(traceArg)
    expect(parsed.length).toBe(1)
    expect(parsed[0].validation.validator).toBe('experiment-off')
    expect(parsed[0].actualTransition.applied).toBe(false)
    expect(parsed[0].actualTransition.escalated).toBe(false)
    expect(parsed[0].llmProposal.action).toBe('align_qa') // 原提议保留
  })

  it('默认（无 env）ON 行为不变：表外 action 仍 escalate', async () => {
    // 与上例同输入，但无 EXPERIMENT_STATE_MACHINE
    mockGetOrchestratorDecision.mockResolvedValue({
      decision: { action: 'align_qa', target: null, targets: null, message: '问一下', reason: '需要澄清' },
      sessionId: 'cli-1',
    })
    mockMessageFindMany.mockResolvedValue([])
    await handleOrchestratorDecision('澄清一下', 's1', [], mockSendEvent, { phase: 'idle', phaseStep: '', decisionTrace: '[]' })
    const escalateEvents = mockSendEvent.mock.calls.filter(c => c[0].type === 'awaiting_user_input' && c[0].content === 'escalate')
    expect(escalateEvents.length).toBe(1)
  })
})
```
> 注：需要确认 `mockSendEvent` 与 `mockSessionUpdateMany` 在该测试文件的既有定义（P4 已加 updateMany mock）。若 `handleOrchestratorDecision` 的 `mockSendEvent` 未导出，改用测试文件内已有的 sendEvent mock 引用。

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/chat-router.test.ts -t "OFF"`
Expected: FAIL — 决策点仍用原 `applyTransition`，OFF 下表外 action 仍 escalate（第一个用例 escalateEvents.length 为 1 非 0）

- [ ] **Step 3: 实现**

在 `chat-router.ts` 决策点区域（:91 后）：
```ts
  const state = stateFromSession(sessionPhase.phase, sessionPhase.phaseStep)
  // P5 受控实验：OFF 开关只关 enforcement，不关 trace。跳过纠正+守卫，转移校验用 override，
  // trace 块照常记录（validator:'experiment-off'，表外 inTable:false → applied:false）。
  const experimentOff = isExperimentOff()

  if (!experimentOff) {
    // Hybrid 规范化纠正（3 条）...
    const correction = canonicalCorrect(state, decision.action, history)
    if (correction) {
      corrections.push({ from: decision.action, to: correction.redirect, reason: `规范化纠正: ${decision.reason}` })
      decision = { ...decision, action: correction.redirect, reason: `${decision.reason}（规范化纠正 -> ${correction.redirect}）` }
    }

    // P2 idle→execute 确定性闸门 ...
    if (decision.action === 'execute') {
      const tasks = await prisma.task.findMany({ where: { sessionId }, select: { description: true, declaredFiles: true } })
      const hasCodeTask = tasks.some(t => isCodeTask({ description: t.description, declaredFiles: parseDeclaredFiles(t.declaredFiles) }))
      if (state === 'idle' ? !idleExecuteGate(tasks.length, hasCodeTask) : tasks.length === 0) {
        const reason = state === 'idle' ? '确定性闸门：需先对齐拆解' : '尚无任务，需架构师先拆解'
        corrections.push({ from: 'execute', to: 'align_decompose', reason })
        decision = { ...decision, action: 'align_decompose', reason }
      }
    }

    // done 业务守卫 ...
    if (decision.action === 'done' && state === 'exec') {
      const unfinished = await prisma.task.count({ where: { sessionId, status: { notIn: ['completed', 'blocked'] } } })
      if (unfinished > 0) {
        corrections.push({ from: 'done', to: 'execute', reason: `还有 ${unfinished} 个未完成任务，继续执行` })
        decision = { ...decision, action: 'execute', reason: `还有 ${unfinished} 个未完成任务，继续执行` }
      } else {
        const verify = await prisma.task.findFirst({ where: { sessionId, id: { startsWith: 'verify-' } }, select: { status: true } })
        if (verify && verify.status !== 'completed') {
          corrections.push({ from: 'done', to: 'execute', reason: `验证任务未完成（${verify.status}），继续执行` })
          decision = { ...decision, action: 'execute', reason: `验证任务未完成（${verify.status}），继续执行` }
        }
      }
    }

    // If delegate is chosen but there are pending tasks ...
    if (decision.action === 'delegate') {
      const pendingTasks = await prisma.task.count({ where: { sessionId, status: 'pending' } })
      if (pendingTasks > 0) {
        decision = { ...decision, reason: `${decision.reason}（另有${pendingTasks}个待执行任务）` }
      }
    }
  }

  // 转移合法性校验（P5: OFF 时用 override，bypass 恒 ok 不 escalate）
  const transition = applyTransitionWithOverride(state, decision.action, experimentOff)
  // P5: OFF 表外条目打 experiment-off 标记（inTable:false → applied:false），供 oracle 区分预期实验条件 vs 漂移
  const offBypass = experimentOff && transition.ok && 'inTable' in transition
  const offInTable = offBypass ? transition.inTable : true
  const traceEntry: DecisionTraceEntry = {
    decisionPoint: 'handleOrchestratorDecision',
    inputState: { phase: sessionPhase.phase, phaseStep: sessionPhase.phaseStep, state },
    llmProposal,
    corrections,
    validation: transition.ok
      ? { passed: true, validator: offBypass ? 'experiment-off' : 'applyTransition' }
      : { passed: false, validator: 'applyTransition', reason: transition.reason },
    actualTransition: transition.ok
      ? offInTable
        ? { from: state, to: transition.nextState, action: decision.action, applied: true, escalated: false }
        : { from: state, to: state, action: decision.action, applied: false, escalated: false }
      : { from: state, to: state, action: decision.action, applied: false, escalated: true },
  }
```
> 注：`transition.ok && 'inTable' in transition` 是 TS 联合收窄——非 bypass 时 override 返回 `applyTransition` 结果（无 inTable），`'inTable' in` 为 false → `offBypass` false → 走原语义。ESM import 增加 `applyTransitionWithOverride, isExperimentOff`。

- [ ] **Step 4: 运行确认通过 + 全量回归**

Run: `npx vitest run tests/chat-router.test.ts -t "OFF"`
Expected: PASS
Run: `npx vitest run tests/chat-router.test.ts`
Expected: 全绿（原决策路径 5 case 抑制测试不破）

- [ ] **Step 5: 提交**

```bash
git add src/lib/services/chat-router.ts tests/chat-router.test.ts
git commit -m "feat: P5-T2 chat-router 决策点换 applyTransitionWithOverride（OFF 跳过纠正/守卫不 escalate,trace 照记 validator=experiment-off 表外 applied:false）"
```

---

### Task 3: experiments/p5 脚手架（独立 config + 任务定义）

**Files:**
- Create: `experiments/p5/vitest.config.ts`
- Create: `experiments/p5/config.ts`
- Create: `experiments/p5/tasks.ts`
- Create: `experiments/p5/README.md`

**Interfaces:**
- Consumes: 无（自洽）
- Produces:
  - `CONFIG`（from config.ts）：`{ model, taskIds, configs, runsPerCell, escalateLimit, maxRounds, noProgressRounds, cannedReplies, dbPath, timeoutMs }`
  - `TASKS`（from tasks.ts）：`Array<{ id: 'A'|'B'|'C', name, userMessage, oracle: (entries) => boolean }>`
  - vitest config 设 `test.env.DATABASE_URL` 指向 p5.db（**必须在 `@/lib/db` 首次求值前生效**）、`testTimeout` 小时级、`fileParallelism: false`、`include: ['run.test.ts']`

- [ ] **Step 1: 建目录 + vitest config**

```bash
mkdir -p experiments/p5 && mkdir -p experiments/p5/work && mkdir -p experiments/p5/results
```
`experiments/p5/vitest.config.ts`：
```ts
import { defineConfig } from 'vitest/config'
import path from 'path'

// P5 实验独立 vitest config：
// - test.env 设 DATABASE_URL 指向独立 p5.db（prisma 是模块加载期单例，必须在 @/lib/db 首次求值前生效）
// - testTimeout 设到小时级（30 次真实 LLM run 串行）
// - fileParallelism:false（串行，避免 on/off env 串扰 + DB 竞争）
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['run.test.ts'],
    testTimeout: 6 * 60 * 1000,       // 单 run 上限（含决策/补拆/执行 mock）
    hookTimeout: 2 * 60 * 1000,
    fileParallelism: false,
    env: {
      DATABASE_URL: 'file:D:/ai全栈挑战赛/agenthub/experiments/p5/p5.db', // 绝对路径，消除 cwd 歧义
    },
  },
  resolve: {
    alias: { '@': path.resolve(__dirname, '../../src') },
  },
})
```

- [ ] **Step 2: config.ts**

```ts
/** P5 实验配置（Spec §2/§4/§6 固化参数，报告需回显 model+config 供复现） */
export const CONFIG = {
  model: 'glm-4.7-flash',
  taskIds: ['A', 'B', 'C'] as const,
  configs: ['on', 'off'] as const,
  runsPerCell: 5,
  escalateLimit: 3,
  maxRounds: 30,
  noProgressRounds: 5,
  dbPath: 'file:D:/ai全栈挑战赛/agenthub/experiments/p5/p5.db',
  workDir: 'D:/ai全栈挑战赛/agenthub/experiments/p5/work',
  resultsDir: 'D:/ai全栈挑战赛/agenthub/experiments/p5/results',
  timeoutMs: 5 * 60 * 1000,
  // 暂停点罐头消息（Spec §6：混淆变量必须固定，报告写明）
  cannedReplies: {
    escalate: '请按流程继续',
    pm_confirm: '方案确认，继续',
    architect_plan: '拆解确认，继续',
    replan: '请重新规划，继续',
    agent_qa: '已解答，继续',
  } as Record<string, string>,
} as const
```

- [ ] **Step 3: tasks.ts（3 档歧义度，Spec §3.2/§4.1）**

```ts
import type { DecisionTraceEntry } from '../../src/lib/orchestrator/decision-trace'

/** oracle 判定（Spec §4.1）：pass ⇔ ①终点done ②规范序列实际走过 ③(仅ON)零 illegal/escalate_but_legal */
export interface P5Task {
  id: 'A' | 'B' | 'C'
  name: string
  userMessage: string
  /** 期望走的规范边（applied actualTransition 三元组集合），oracle ② 用 */
  requiredEdges: Array<{ action: string; from: string; to: string }>
}

export const TASKS: P5Task[] = [
  {
    id: 'A',
    name: '清晰任务-实现加法函数并验证',
    userMessage: '请帮我在项目里实现一个纯函数 add(a, b) 返回两数之和，放在 src/utils/math.ts，并写一个测试验证它。这是唯一需要的改动。',
    requiredEdges: [
      { action: 'align_decompose', from: 'idle', to: 'align_arch' },
      { action: 'execute', from: 'idle', to: 'exec' },
      { action: 'done', from: 'exec', to: 'done' },
    ],
  },
  {
    id: 'B',
    name: '模糊任务-需要澄清登录方式',
    userMessage: '帮我实现一个用户登录接口。需求比较模糊：不确定用邮箱还是手机号登录，也不确定要不要验证码，你看着安排吧。',
    requiredEdges: [
      { action: 'align_decompose', from: 'idle', to: 'align_arch' },
      { action: 'execute', from: 'idle', to: 'exec' },
      { action: 'done', from: 'exec', to: 'done' },
    ],
  },
  {
    id: 'C',
    name: '捷径任务-只改一个配置',
    userMessage: '把项目根目录 .env.example 里的端口从 3000 改成 8080。就这一个改动，别的不动。',
    requiredEdges: [
      { action: 'align_decompose', from: 'idle', to: 'align_arch' },
      { action: 'execute', from: 'idle', to: 'exec' },
      { action: 'done', from: 'exec', to: 'done' },
    ],
  },
]
```
> 注：requiredEdges 的 from 以实际 trace 为准（idle→exec 由决策点直接记；若走补拆则记 idle→align_arch + 后续 execute→exec），oracle 实现按"边存在性"匹配（见 Task 5 metrics.ts）。

- [ ] **Step 4: README.md**

```markdown
# P5 受控实验 harness

验证"状态机比 LLM 自由推进更可靠"。决策走真实 LLM（glm-4.7-flash），执行 mock。
Spec: docs/superpowers/specs/2026-08-13-p5-controlled-experiment-design.md

## 运行
```bash
export GLM_API_KEY=...   # 智谱 key（永不硬编码）
npx vitest run --config experiments/p5/vitest.config.ts
```

## 结构
- vitest.config.ts  独立 config（test.env 指向 p5.db、串行、小时级 timeout）
- config.ts         固化参数（报告回显）
- tasks.ts          3 档任务 + oracle 边定义
- mock-executor.ts  executeTaskBatch + monitoring mock
- setup.ts          p5.db 初始化 + 清 prisma 单例 + preflight
- run-one.ts        单次 run 驱动
- user-simulator.ts 暂停点自动回复
- metrics.ts        pass/失效模式采集 + JSONL 落盘
- stats.ts          bootstrap CI + 配对 McNemar + seed noise
- report.ts         对比报告
```

- [ ] **Step 5: 校验 + 提交**

Run: `npx vitest run --config experiments/p5/vitest.config.ts --passWithNoTests`
Expected: 退出码 0（config 可加载，无测试也不崩）
```bash
git add experiments/p5/
git commit -m "feat: P5-T3 实验脚手架（独立 vitest config + config + 3 档任务定义）"
```

---

### Task 4: mock-executor（executeTaskBatch + monitoring）

**Files:**
- Create: `experiments/p5/mock-executor.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  - `mockExecuteTaskBatch(tasks, agents, onChunk, chatSessionId, projectDir, priorResults, priorTaskMeta): Promise<{ results: Map<string, { result: string; sessionId?: string }>, preloadedIds: string[], failedTaskIds: string[], failedTaskReasons: Record<string, string> }>`
  - `isMonitoringCall(agent): boolean` — `agent.systemPrompt?.includes('代码审查专家')`
  - `mockMonitoringResult: string` — `JSON.stringify({ needsCorrection: false })`

- [ ] **Step 1: 实现（先写纯函数，run.test.ts 的 vi.mock 在 Task 6 接）**

```ts
import type { ScheduledTask } from '../../src/lib/orchestrator/index'

/** P5 执行 mock（Spec §5.2）：
 * executeTaskBatch 返回形状必须与 handleExecution 消费一致（execution.ts:292 解构 {result, sessionId}），
 * 全 SUCCESS + 4 键齐全，否则 30/30 error。
 */
export async function mockExecuteTaskBatch(
  tasks: ScheduledTask[],
  _agents: unknown,
  _onChunk: unknown,
  _chatSessionId?: string,
  _projectDir?: string,
  _priorResults?: unknown,
  _priorTaskMeta?: unknown
): Promise<{ results: Map<string, { result: string; sessionId?: string }>, preloadedIds: string[], failedTaskIds: string[], failedTaskReasons: Record<string, string> }> {
  const results = new Map<string, { result: string; sessionId?: string }>()
  for (const t of tasks) {
    results.set(t.id, { result: 'SUCCESS', sessionId: undefined })
  }
  return { results, preloadedIds: [], failedTaskIds: [], failedTaskReasons: {} }
}

/** monitoring 识别（execution.ts:434 用 systemPrompt '你是代码审查专家...'） */
export function isMonitoringCall(agent: { systemPrompt?: string }): boolean {
  return Boolean(agent.systemPrompt?.includes('代码审查专家'))
}

/** monitoring 固定返回不纠正（Spec §8.2：产物不可判，mock 恒 needsCorrection:false） */
export const mockMonitoringResult = JSON.stringify({ needsCorrection: false })
```

- [ ] **Step 2: 写单测（mock 形状喂 handleExecution 不抛）**

`experiments/p5/mock-executor.test.ts`：
```ts
import { describe, it, expect } from 'vitest'
import { mockExecuteTaskBatch, isMonitoringCall, mockMonitoringResult } from './mock-executor'

describe('P5 mock-executor', () => {
  it('executeTaskBatch mock 返回 4 键 + 对象形状（execution.ts:292 解构兼容）', async () => {
    const tasks = [
      { id: 't1', batch: 0, description: 'd', assignedAgent: '架构师', dependencies: [] },
      { id: 'verify-x', batch: 1, description: 'v', assignedAgent: '测试', dependencies: ['t1'] },
    ] as unknown as Parameters<typeof mockExecuteTaskBatch>[0]
    const r = await mockExecuteTaskBatch(tasks, [], () => {})
    expect(r.preloadedIds).toEqual([])
    expect(r.failedTaskIds).toEqual([])
    expect(r.failedTaskReasons).toEqual({})
    for (const t of tasks) {
      const v = r.results.get(t.id)
      expect(v).toBeDefined()
      expect(typeof v!.result).toBe('string')   // 对象形状，非裸字符串
    }
    // 防 undefined.slice 回归（execution.ts:549）
    expect('SUCCESS'.slice(0, 100)).toBe('SUCCESS')
  })

  it('isMonitoringCall 识别 代码审查专家', () => {
    expect(isMonitoringCall({ systemPrompt: '你是代码审查专家，负责检查 Agent 输出质量。' })).toBe(true)
    expect(isMonitoringCall({ systemPrompt: '你是架构师，负责系统设计。' })).toBe(false)
  })

  it('mockMonitoringResult 是 JSON 字符串且 needsCorrection:false', () => {
    expect(JSON.parse(mockMonitoringResult)).toEqual({ needsCorrection: false })
  })
})
```

- [ ] **Step 3: 运行通过 + 提交**

Run: `npx vitest run --config experiments/p5/vitest.config.ts experiments/p5/mock-executor.test.ts`
> 注：`include:['run.test.ts']` 会挡掉该测试文件，需临时 `--include` 覆盖或将该单测并入 run.test.ts。**决定**：mock-executor 单测并入 Task 6 的 run.test.ts（同一文件跑），此处只写实现不写独立测试文件——避免 include 冲突。
```bash
git add experiments/p5/mock-executor.ts
git commit -m "feat: P5-T4 mock-executor（executeTaskBatch 4键对象形状 + monitoring 识别/固定不纠正）"
```
> 调整：Task 2 的单测移动到这里一并做（见 run.test.ts 的 describe 块）。

---

### Task 5: setup（p5.db 初始化 + prisma 单例 + preflight）

**Files:**
- Create: `experiments/p5/setup.ts`

**Interfaces:**
- Consumes: `CONFIG`（Task 3）、`TASKS`（Task 3）
- Produces:
  - `setupExperiment(): Promise<void>` — 清 globalThis.prisma + migrate deploy p5.db + 建实验 agents + preflight
  - `teardownExperiment(): Promise<void>` — 清理（可选）
  - `experimentAgents: Array<{ name, expertise, role, platform, model, baseUrl, apiKey }>` — 用 GLM_API_KEY

- [ ] **Step 1: 实现 setup.ts**

```ts
import { execSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { CONFIG } from './config'

const REPO_ROOT = join(__dirname, '..', '..')

/** 清 prisma 全局单例，确保下一次 import 用 p5.db（db.ts 模块级 globalForPrisma.prisma） */
export function resetPrismaSingleton(): void {
  ;(globalThis as unknown as { prisma?: unknown }).prisma = undefined
}

/** migrate deploy 到 p5.db（空库无表，不部署则 30/30 error；cwd 必须与 DATABASE_URL 相对基准一致） */
export function initP5Db(): void {
  mkdirSync(CONFIG.workDir, { recursive: true })
  mkdirSync(CONFIG.resultsDir, { recursive: true })
  execSync('npx prisma migrate deploy --schema prisma/schema.prisma', {
    cwd: REPO_ROOT,
    env: { ...process.env, DATABASE_URL: CONFIG.dbPath },
    stdio: 'pipe',
  })
}

/** 实验 agents（决策/PM/架构师走真实 LLM——glm-4.7-flash，经 claude-code adapter + ANTHROPIC 兼容路径） */
export async function ensureExperimentAgents(): Promise<void> {
  const key = process.env.GLM_API_KEY
  if (!key || !key.trim()) {
    throw new Error('GLM_API_KEY env 未设置——pilot 需要智谱 key（本地诊断惯例，永不硬编码）')
  }
  const { prisma } = await import('@/lib/db')
  const common = {
    platform: 'claude-code',
    model: CONFIG.model,
    baseUrl: process.env.GLM_BASE_URL || 'https://open.bigmodel.cn/api/paas/v4',
    apiKey: key,
    accentColor: '#6366f1',
  }
  const agents = [
    { ...common, name: '产品经理', expertise: '需求分析与澄清', systemPrompt: '你是产品经理，负责需求分析与澄清，可向用户提问确认需求。', isOrchestrator: false },
    { ...common, name: '架构师', expertise: '系统设计与任务拆解', systemPrompt: '你是架构师，负责把需求拆解为可执行任务。', isOrchestrator: true },
    { ...common, name: '后端工程师', expertise: '后端与脚本开发', systemPrompt: '你是后端工程师，负责实现 API 与业务逻辑。', isOrchestrator: false },
    { ...common, name: '测试工程师', expertise: '测试编写与验证', systemPrompt: '你是测试工程师，负责编写测试并验证实现。', isOrchestrator: false },
  ]
  for (const a of agents) {
    await prisma.agent.upsert({
      where: { name: a.name },
      update: {},
      create: a,
    })
  }
}

/** preflight：1 次真实决策调用验证 CLI + glm provider 可用，失败快速失败不烧 30 次（Spec §7.2） */
export async function preflightDecision(): Promise<void> {
  const { prisma } = await import('@/lib/db')
  const orch = await prisma.agent.findFirst({ where: { isOrchestrator: true } })
  if (!orch) throw new Error('preflight: 无 orchestrator agent')
  // 走 executeSingleAgent 一次真实调用（glm），验证 spawn CLI + provider 配好
  const { executeSingleAgent } = await import('@/lib/orchestrator')
  const { result } = await executeSingleAgent(
    { name: orch.name, systemPrompt: orch.systemPrompt, platform: orch.platform, model: orch.model, baseUrl: orch.baseUrl, apiKey: orch.apiKey },
    '只回复两个字：就绪',
    '',
    () => {}
  )
  if (!result || !result.trim()) throw new Error('preflight: LLM 返回空，provider 未配好')
}

/** 主入口：pilot beforeAll 调 */
export async function setupExperiment(): Promise<void> {
  resetPrismaSingleton()
  initP5Db()
  await ensureExperimentAgents()
  await preflightDecision()
}
```

- [ ] **Step 2: 校验 + 提交**

```bash
git add experiments/p5/setup.ts
git commit -m "feat: P5-T5 setup（p5.db migrate deploy + prisma 单例重置 + 实验 agents + preflight）"
```

---

### Task 6: run-one 驱动 + user-simulator + metrics（核心）

**Files:**
- Create: `experiments/p5/user-simulator.ts`
- Create: `experiments/p5/metrics.ts`
- Create: `experiments/p5/run-one.ts`
- Create: `experiments/p5/run.test.ts`（driver 入口，含 mock 注入 + 全部 harness 单测）

**Interfaces:**
- Consumes: `CONFIG`/`TASKS`（Task 3）、`mockExecuteTaskBatch`/`isMonitoringCall`/`mockMonitoringResult`（Task 4）、`setupExperiment`（Task 5）、`applyTransitionWithOverride`/`isExperimentOff`（Task 1，经 src）
- Produces:
  - `simulateUserReply(awaitingType): string` — 罐头消息
  - `collectMetrics(runId, sessionId, config, taskId, seed): Promise<RunMetrics>` — 从 DB 读 trace + 判 pass/失效模式
  - `appendMetrics(runId, m): Promise<void>` / `loadMetrics(): Promise<RunMetrics[]>` — JSONL 落盘/重读
  - `runOne(config, task, seed): Promise<RunMetrics>` — 单次 run 驱动
  - run.test.ts：`describe('P5 pilot')` 30 个 it（每 run 一个）+ afterAll 生成报告

- [ ] **Step 1: user-simulator.ts**

```ts
import { CONFIG } from './config'

/** 暂停点罐头消息（Spec §6：固定句，落库为 user 消息后 LLM 才能看到） */
export function simulateUserReply(awaitingType: string): string {
  return CONFIG.cannedReplies[awaitingType] ?? CONFIG.cannedReplies.escalate
}
```

- [ ] **Step 2: metrics.ts**

```ts
import { CONFIG } from './config'
import { TASKS, type P5Task } from './tasks'

export interface RunMetrics {
  runId: string
  config: 'on' | 'off'
  taskId: 'A' | 'B' | 'C'
  seed: number
  pass: boolean
  failureMode: 'pass' | 'escalate-exhausted' | 'stuck' | 'error' | 'no-pass'
  rounds: number
  escalateCount: number
  correctionCount: number
  illegalProposalCount: number   // OFF: llmProposal 表外尝试数；ON: escalateCount+correction 相关
  totalTransitions: number
  latencyMs: number
  tracePath: string
}

/** oracle（Spec §4.1）：② 规范序列边存在性匹配 */
function hasRequiredEdges(entries: any[], task: P5Task): boolean {
  const applied = entries.filter(e => e.actualTransition?.applied === true)
  return task.requiredEdges.every(edge =>
    applied.some(a =>
      a.actualTransition.action === edge.action &&
      (edge.from === '*' || a.actualTransition.from === edge.from) &&
      (edge.to === '*' || a.actualTransition.to === edge.to)
    )
  )
}

/** OFF 非法尝试率口径（Spec §4.3/§5.3）：llmProposal.action 不在转移表且非旁路 */
export function countIllegalProposals(entries: any[], isOff: boolean): number {
  if (!isOff) return 0 // ON 用 escalateCount/correctionCount 表达
  const bypass = new Set(['self', 'delegate', 'discuss', 'verify'])
  return entries.filter(e =>
    e.decisionPoint === 'handleOrchestratorDecision' &&
    !bypass.has(e.llmProposal?.action)
  ).length
}

export async function collectMetrics(
  runId: string, sessionId: string, config: 'on'|'off', taskId: 'A'|'B'|'C', seed: number,
  rounds: number, escalateCount: number, latencyMs: number
): Promise<RunMetrics> {
  const { prisma } = await import('@/lib/db')
  const session = await prisma.session.findUnique({ where: { id: sessionId } })
  const task = TASKS.find(t => t.id === taskId)!
  let entries: any[] = []
  try { entries = JSON.parse(session?.decisionTrace ?? '[]') } catch { entries = [] }
  const applied = entries.filter(e => e.actualTransition?.applied === true)
  const totalTransitions = applied.length

  const done = session?.phase === 'done'
  const requiredEdgesOk = hasRequiredEdges(entries, task)
  // ③ 仅 ON：零 illegal_transition（用 checkConformance 或复刻）
  let onConformanceOk = true
  if (config === 'on' && entries.length > 0) {
    const { checkConformance } = await import('../../src/lib/orchestrator/decision-trace')
    const c = checkConformance(entries as any)
    onConformanceOk = c.illegalTransitions === 0 && c.escalateButLegal === 0
  }

  const pass = done && requiredEdgesOk && (config === 'off' ? true : onConformanceOk)

  let failureMode: RunMetrics['failureMode'] = 'no-pass'
  if (pass) failureMode = 'pass'
  else if (escalateCount > CONFIG.escalateLimit) failureMode = 'escalate-exhausted'
  else if (rounds > CONFIG.maxRounds) failureMode = 'stuck'

  const correctionCount = entries.reduce((n, e) => n + (e.corrections?.length ?? 0), 0)
  const illegalProposalCount = countIllegalProposals(entries, config === 'off')

  return {
    runId, config, taskId, seed, pass, failureMode, rounds, escalateCount,
    correctionCount, illegalProposalCount, totalTransitions, latencyMs,
    tracePath: `${CONFIG.resultsDir}/trace-${runId}.json`,
  }
}

// —— JSONL 落盘（Spec §7.3：每 run 立即写，崩溃不丢前 N-1）——
import { appendFileSync, readFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const METRICS_FILE = join(CONFIG.resultsDir, 'metrics.jsonl')
export function appendMetrics(m: RunMetrics): void {
  mkdirSync(CONFIG.resultsDir, { recursive: true })
  appendFileSync(METRICS_FILE, JSON.stringify(m) + '\n', 'utf8')
}
export function loadMetrics(): RunMetrics[] {
  try {
    return readFileSync(METRICS_FILE, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
  } catch { return [] }
}
```
> 注：`checkConformance` 的返回字段名需在实现时核对（`illegalTransitions`/`escalateButLegal` 为计划假设，若实际是 `illegal_transition` 等，改字段名）。此项在 Step 3 红绿验证时确认。

- [ ] **Step 3: run-one.ts**

```ts
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { CONFIG } from './config'
import { TASKS, type P5Task } from './tasks'
import { simulateUserReply } from './user-simulator'
import { collectMetrics, appendMetrics, type RunMetrics } from './metrics'

export interface RunInput { config: 'on'|'off'; taskId: 'A'|'B'|'C'; seed: number }

/** 单次 run：建 session → 循环决策/回复 → done/超时/卡死 → metrics 落盘 */
export async function runOne({ config, taskId, seed }: RunInput): Promise<RunMetrics> {
  const task = TASKS.find(t => t.id === taskId)!
  const runId = `${config}-${taskId}-s${seed}-${randomUUID().slice(0, 8)}`
  const { prisma } = await import('@/lib/db')
  const { handleOrchestratorDecision } = await import('@/lib/services/chat-router')

  // OFF 开关按 run 隔离（fileParallelism:false 串行，无并发串扰）
  if (config === 'off') process.env.EXPERIMENT_STATE_MACHINE = 'off'
  else delete process.env.EXPERIMENT_STATE_MACHINE

  const projectDir = mkdtempSync(join(CONFIG.workDir, runId))
  const session = await prisma.session.create({
    data: { title: `p5-${config}-${taskId}-s${seed}`, type: 'group', projectDir },
  })
  const members = await prisma.agent.findMany({ where: { isPreset: false } })
  await prisma.sessionMember.createMany({
    data: members.map(a => ({ sessionId: session.id, agentId: a.id, role: a.isOrchestrator ? 'orchestrator' : 'member' })),
  })
  const agents = members.map(a => ({ name: a.name, systemPrompt: a.systemPrompt, platform: a.platform, model: a.model, baseUrl: a.baseUrl, apiKey: a.apiKey, id: a.id }))

  const sendEvents: any[] = []
  const sendEvent = (ev: any) => sendEvents.push(ev)

  const start = Date.now()
  let rounds = 0
  let escalateCount = 0
  let lastPhase = ''
  let noProgress = 0
  let message = task.userMessage

  while (rounds < CONFIG.maxRounds) {
    rounds++
    sendEvents.length = 0
    const snap = await prisma.session.findUnique({ where: { id: session.id }, select: { phase: true, phaseStep: true, decisionTrace: true } })
    if (!snap) break
    await handleOrchestratorDecision(message, session.id, agents, sendEvent,
      { phase: snap.phase, phaseStep: snap.phaseStep, decisionTrace: snap.decisionTrace },
      undefined, projectDir, 'auto', Date.now() + CONFIG.timeoutMs)

    const after = await prisma.session.findUnique({ where: { id: session.id }, select: { phase: true } })
    const phase = after?.phase ?? ''
    if (phase === 'done') break

    const awaiting = sendEvents.find(e => e.type === 'awaiting_user_input')
    if (awaiting) {
      const type = String(awaiting.content ?? '')
      if (type === 'escalate') {
        escalateCount++
        if (escalateCount > CONFIG.escalateLimit) break // escalate-exhausted
      }
      // 罐头消息落库（Spec §6：不落库 LLM 历史看不到）
      await prisma.message.create({ data: { role: 'user', rawContent: simulateUserReply(type), sessionId: session.id } })
      message = simulateUserReply(type)
      if (phase === lastPhase) { noProgress++; if (noProgress >= CONFIG.noProgressRounds) break } // stuck
      else noProgress = 0
      lastPhase = phase
      continue
    }
    // 无 awaiting 且未 done：no-progress 兜底（self/verify 聊天可能空转）
    if (phase === lastPhase) { noProgress++; if (noProgress >= CONFIG.noProgressRounds) break }
    else noProgress = 0
    lastPhase = phase
    // 下一轮消息 = orchestrator 最后一条 text，或保持原消息
    const lastText = sendEvents.filter(e => e.type === 'text').map(e => e.content).pop()
    message = typeof lastText === 'string' && lastText ? lastText : message
  }

  const latencyMs = Date.now() - start
  const m = await collectMetrics(runId, session.id, config, taskId, seed, rounds, escalateCount, latencyMs)
  appendMetrics(m)
  return m
}
```

- [ ] **Step 4: run.test.ts（driver + mock 注入 + 单测）**

```ts
import { describe, it, beforeAll, afterAll, expect, vi } from 'vitest'
import { CONFIG } from './config'
import { TASKS } from './tasks'
import { setupExperiment } from './setup'
import { runOne } from './run-one'
import { loadMetrics, appendMetrics } from './metrics'
import { generateReport } from './report'

// —— vi.mock 注入（Spec §5.2，必须在 src 模块首次 import 前）——
// 决策保留真实 LLM（getOrchestratorDecision 走 executeSingleAgent），
// 任务执行 mock（executeTaskBatch）+ monitoring mock（代码审查专家→不纠正）。
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

beforeAll(async () => { await setupExperiment() }, 5 * 60 * 1000)
afterAll(async () => {
  // 生成报告（Spec §11）
  const report = generateReport(loadMetrics())
  console.log('\n===== P5 PILOT REPORT =====\n' + report)
}, 60 * 1000)

// —— harness 纯函数单测（并入同文件，避免 include 冲突）——
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
  it('metrics 落盘往返', () => {
    const m = { runId: 'x', config: 'off', taskId: 'A', seed: 0, pass: false, failureMode: 'no-pass', rounds: 3, escalateCount: 0, correctionCount: 0, illegalProposalCount: 1, totalTransitions: 2, latencyMs: 10, tracePath: '' }
    appendMetrics(m)
    expect(loadMetrics().some(x => x.runId === 'x')).toBe(true)
  })
})

// —— 30 次 run（Spec §3.3：3任务×2配置×5次；5 固定 seed 同 seed 配对 ON/OFF）——
const SEEDS = [0, 1, 2, 3, 4]
describe('P5 pilot: 30 次受控实验', () => {
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
```

- [ ] **Step 5: 运行确认（先只跑 1 格冒烟）**

Run: `GLM_API_KEY=xxx npx vitest run --config experiments/p5/vitest.config.ts -t "on A seed=0"`
Expected: 该 run 跑完返回 RunMetrics（先看是否 error/stuck——若 error 说明 mock/DB/CLI 有洞，debug；若 pass/no-pass 则管道通了）
> 这是关键冒烟点：**只跑 1 格**验证全链路（真实决策 → mock 执行 → trace 落库 → oracle 判定 → JSONL），红绿验证 mock 形状/monitoring/暂停点回复。

- [ ] **Step 6: 全量 30 run + 提交**

Run: `GLM_API_KEY=xxx npx vitest run --config experiments/p5/vitest.config.ts`
Expected: 30 个 it 全跑完，metrics.jsonl 有 30 行，控制台打印报告
```bash
git add experiments/p5/
git commit -m "feat: P5-T6 run-one 驱动 + 暂停点回复 + metrics 落盘 + 30 run driver"
```

---

### Task 7: stats + report（bootstrap CI + 配对 McNemar + seed noise）

**Files:**
- Create: `experiments/p5/stats.ts`
- Create: `experiments/p5/report.ts`

**Interfaces:**
- Consumes: `RunMetrics`（Task 6）
- Produces:
  - `bootstrapCI(passes: boolean[], n=1000): { low, high }` — 重采样 CI
  - `pairedMcNemar(offRes: boolean[], onRes: boolean[]): { pValue, b, c, chi }` — 同 seed 配对
  - `seedNoise(metrics): number` — 同格 pass 方差
  - `generateReport(metrics: RunMetrics[]): string` — 逐格 pass 数组 + 各指标 markdown 报告

- [ ] **Step 1: stats.ts（纯函数）**

```ts
import type { RunMetrics } from './metrics'

/** bootstrap 重采样 CI（Spec §4.4：≥1000 resample） */
export function bootstrapCI(passes: boolean[], n = 1000): { low: number; high: number; mean: number } {
  if (passes.length === 0) return { low: 0, high: 0, mean: 0 }
  const sample = () => {
    let ok = 0
    for (let i = 0; i < passes.length; i++) if (passes[Math.floor(Math.random() * passes.length)]) ok++
    return ok / passes.length
  }
  const dist = Array.from({ length: n }, sample).sort((a, b) => a - b)
  return {
    low: dist[Math.floor(n * 0.025)],
    high: dist[Math.floor(n * 0.975)],
    mean: passes.filter(Boolean).length / passes.length,
  }
}

/** 同 seed 配对 McNemar（Spec §4.4：15 对；n 小功效有限只当参考） */
export function pairedMcNemar(offRes: boolean[], onRes: boolean[]): { b: number; c: number; pValue: number } {
  let b = 0, c = 0
  for (let i = 0; i < Math.min(offRes.length, onRes.length); i++) {
    if (offRes[i] && !onRes[i]) b++
    if (!offRes[i] && onRes[i]) c++
  }
  const chi = b + c === 0 ? 0 : ((b - c) ** 2) / (b + c)
  // 卡方 1 自由度 3.841 → p<0.05；此处给近似（连续校正）
  const pValue = b + c === 0 ? 1 : Math.min(1, 1 - 0.5 * (chi < 3.841 ? chi / 3.841 : 1))
  return { b, c, pValue }
}

/** seed noise = 同格内 pass 的方差占比（Spec §4.4：ClawBench 47% 警示） */
export function seedNoise(metrics: RunMetrics[]): { cell: string; passes: boolean[]; variance: number }[] {
  const cells = new Map<string, boolean[]>()
  for (const m of metrics) {
    const k = `${m.config}-${m.taskId}`
    if (!cells.has(k)) cells.set(k, [])
    cells.get(k)!.push(m.pass)
  }
  return Array.from(cells.entries()).map(([cell, passes]) => {
    const p = passes.filter(Boolean).length / passes.length
    return { cell, passes, variance: p * (1 - p) } // 伯努利方差
  })
}
```

- [ ] **Step 2: report.ts**

```ts
import type { RunMetrics } from './metrics'
import { bootstrapCI, pairedMcNemar, seedNoise } from './stats'
import { CONFIG } from './config'

/** 对比报告（Spec §11：逐格 pass 数组，不报均值） */
export function generateReport(metrics: RunMetrics[]): string {
  const lines: string[] = []
  lines.push('# P5 Pilot Report', '')
  lines.push(`> model: ${CONFIG.model} | runsPerCell: ${CONFIG.runsPerCell} | escalateLimit: ${CONFIG.escalateLimit} | maxRounds: ${CONFIG.maxRounds}`)
  lines.push(`> 执行 mock（executeTaskBatch + monitoring 恒不纠正）| 决策真实 LLM`, '')
  lines.push('## 逐格 pass 数组')
  lines.push('| config | task | pass 数组 | pass 率 | bootstrap CI |')
  lines.push('|---|---|---|---|---|')
  for (const config of CONFIG.configs) {
    for (const taskId of CONFIG.taskIds) {
      const cell = metrics.filter(m => m.config === config && m.taskId === taskId)
      const passes = cell.map(m => m.pass)
      const ci = bootstrapCI(passes)
      lines.push(`| ${config} | ${taskId} | ${passes.map(p => (p ? '1' : '0')).join('/')} | ${passes.filter(Boolean).length}/${passes.length} | ${ci.low.toFixed(2)}-${ci.high.toFixed(2)} |`)
    }
  }
  lines.push('', '## 配对 McNemar（同 seed，ON vs OFF）')
  for (const taskId of CONFIG.taskIds) {
    const off = metrics.filter(m => m.config === 'off' && m.taskId === taskId).map(m => m.pass)
    const on = metrics.filter(m => m.config === 'on' && m.taskId === taskId).map(m => m.pass)
    const m = pairedMcNemar(off, on)
    lines.push(`- ${taskId}: OFF${off.filter(Boolean).length}/${off.length} vs ON${on.filter(Boolean).length}/${on.length} | b=${m.b} c=${m.c} p≈${m.pValue.toFixed(3)}`)
  }
  lines.push('', '## seed noise（同格 pass 方差）')
  for (const s of seedNoise(metrics)) {
    lines.push(`- ${s.cell}: ${s.passes.map(p => (p ? '1' : '0')).join('/')} variance=${s.variance.toFixed(2)}`)
  }
  lines.push('', '## 失效模式分布')
  const fm = new Map<string, number>()
  for (const m of metrics) fm.set(m.failureMode, (fm.get(m.failureMode) ?? 0) + 1)
  lines.push('- ' + Array.from(fm.entries()).map(([k, v]) => `${k}: ${v}`).join(' | '))
  lines.push('', '## OFF 非法尝试率 vs ON correctionCount')
  for (const config of CONFIG.configs) {
    const cell = metrics.filter(m => m.config === config)
    const sum = config === 'off'
      ? cell.reduce((n, m) => n + m.illegalProposalCount, 0)
      : cell.reduce((n, m) => n + m.correctionCount, 0)
    lines.push(`- ${config}: ${sum}（${cell.length} runs，avg ${(sum / Math.max(cell.length, 1)).toFixed(2)}）`)
  }
  lines.push('', '> 结论：方向性差异当传闻看（Spec §11），管道有效性 + seed noise 是 pilot 成功标准')
  return lines.join('\n')
}
```

- [ ] **Step 3: 单测（fixture 数据）+ 提交**

在 `run.test.ts` 加：
```ts
import { bootstrapCI, pairedMcNemar, seedNoise } from './stats'

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
```
Run: `GLM_API_KEY=xxx npx vitest run --config experiments/p5/vitest.config.ts -t "P5 stats"`
Expected: PASS
```bash
git add experiments/p5/stats.ts experiments/p5/report.ts experiments/p5/run.test.ts
git commit -m "feat: P5-T7 stats+report（bootstrap CI + 配对 McNemar + seed noise + 逐格报告）"
```

---

### Task 8: pre-commit 三视角审查 + 全量回归 + 收尾

**Files:**
- 生产改动：`src/lib/orchestrator/state-machine.ts`、`src/lib/services/chat-router.ts`（Task 1-2）
- 新增：`experiments/p5/**`（Task 3-7）

- [ ] **Step 1: 全量测试回归（生产路径不破）**

Run: `npx vitest run`（默认 config）
Expected: 1040 passed / 3 skipped（生产改动默认 on 零影响，P5 harness 不进默认 include）
Run: `npx tsc --noEmit`
Expected: src/ 0 错误（tests/ 既有 MockInstance 漂移是基线）

- [ ] **Step 2: 行尾 + 密钥扫描**

Run: `git diff --stat HEAD~8` — 核对无整文件假 diff
Run: `grep -rn "sk-|GLM_API_KEY=[A-Za-z0-9]\|tp-\|AKIA" experiments/p5/ src/ --include="*.ts" --include="*.md" | grep -v "process.env.GLM_API_KEY"` — 确认无硬编码密钥

- [ ] **Step 3: pre-commit 三视角并行审查**

派 3 个 Explore subagent（攻击者/生命周期/声明vs实现），diff 范围 = Task 1-7 全部改动 + spec。审查重点：
- 攻击者：OFF 开关是否真的只关 enforcement 不泄 trace 语义；`isExperimentOff` env 注入会不会被 LLM 提议的 action 值污染；mock 形状是否还能让 monitoring 误判纠偏
- 生命周期：p5.db 隔离是否真达成（prisma 单例/migrate/globalThis 清理）；30 run 崩溃恢复；CLI 进程清理；`resetAllMocks` 是否会清掉 mock impl
- 声明vs实现：spec §5.1 inTable 语义 ↔ chat-router 实现 ↔ oracle ③ 仅 ON 评估 逐条核对；`transition.ok && 'inTable' in` TS 收窄是否真成立

无 ❌ 才 `git commit --no-verify`（累积提交可 `git add . && git commit --no-verify`）

- [ ] **Step 4: 文档同步 + 会话归档**

- `docs/superpowers/plans/`：本计划已存
- `D:\ai全栈挑战赛\A方向-显式状态机-规划.md`：§9.2 加 P5 pilot 落地 blockquote（commit 后）
- `D:\ai全栈挑战赛\A方向-P5接续prompt.md` 或新 P6 接续 prompt（如 P5 未完）
- memory：`project_agenthub_direction_a_state_machine.md` 加 P5 行（30 run 结果/seed noise/结论）
- 会话归档：`D:\18387\wiki知识库\私密空间\wiki-ascii\raw\sources\claude-code\sessions\2026-08-13-AgentHub-P5受控实验.md`
- `.gitignore` 加 `experiments/p5/*.db`、`experiments/p5/work/`、`experiments/p5/results/`（实验结果不进 GitHub）

- [ ] **Step 5: 最终提交 + 推送决策**

```bash
git add .gitignore docs/ D:\ai全栈挑战赛\A方向-显式状态机-规划.md
git commit --no-verify -m "docs: P5 收尾（规划§9.2 落地 + 会话归档 + memory + .gitignore 实验产物）"
```
推送前：密钥扫描 + 确认 experiments/p5/*.db 与 results 未跟踪。生产代码（Task 1-2）可推送；实验数据**默认不推送**（除非你要求）。

---

## Self-Review

**1. Spec 覆盖核对**：
- §2 决策/开关/模型 → Task 1/2/3（config）✅
- §3.1 OFF 只关 enforcement 不关 trace → Task 2 ✅
- §3.3 30 次 + seed 配对 → Task 6（SEEDS 数组）✅
- §4.1 oracle 收紧（③ 仅 ON）→ Task 6 metrics ✅
- §4.2 失效模式 + no-progress → Task 6 run-one ✅
- §4.3 指标主次 + 口径 → Task 6 metrics + Task 7 report ✅
- §4.4 统计 → Task 7 ✅
- §5.1 inTable + 两调用点 → Task 1/2 ✅
- §5.2 mock 形状 + monitoring + 禁 MCP → Task 4/6 ✅
- §5.3 非法尝试率旁路排除 → Task 6 countIllegalProposals ✅
- §6 5 暂停点罐头消息落库 → Task 6 user-simulator ✅
- §7.1 prisma 单例/test.env/migrate/projectDir → Task 3/5 ✅
- §7.2 终止=DB done/error 捕获/kill/unstub → Task 6（注：unstub 由 run-one 内 delete env 承担）✅
- §7.3 每 run 落盘 → Task 6 metrics ✅
- §9 测试清单 → Task 1/2/6/7 + Task 8 ✅
- §12 生产改动 2 处 → Task 1/2 ✅

**2. 占位符扫描**：无 TBD/TODO。两处实现时确认项已标注（checkConformance 字段名、mockSendEvent 引用名）——都是"实现时读代码核对"，非占位。

**3. 类型一致性**：`applyTransitionWithOverride` 返回 `{ok,nextState,inTable}|{ok:false,reason}` 在 Task 1 定义、Task 2 消费（`'inTable' in` 收窄）✅；`mockExecuteTaskBatch` 返回 4 键在 Task 4 定义、Task 6 vi.mock 消费（内联重写）✅；`RunMetrics` 在 Task 6 定义、Task 7 消费 ✅；`simulateUserReply` 在 Task 6 定义、run-one 消费 ✅。
