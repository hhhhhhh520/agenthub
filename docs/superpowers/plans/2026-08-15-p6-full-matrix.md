# P6 全矩阵 Implementation Plan（先修 P5 残留 6 项，再扩展状态机×verify 2×2 矩阵）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复 P5 已知残留 6 项（含 trace 记录不对称测量缺陷），再扩展 2×2 全矩阵（状态机 on/off × verify 有/无 = 4 配置 × 3 任务 × 5 seed = 60 run）。

**Architecture:** 生产改动仅 3 处（chat-router trace 抑制修法 + state-machine 补记 applied 收窄 + alignment verify 开关），均为 env 开关门控、默认未设零影响；实验 harness 侧改罐头差异化/超时/upsert/report/2×2 配置矩阵。

**Tech Stack:** Next.js + Prisma + vitest。实验 harness 在 `experiments/p5/`（独立 vitest config + 独立 p5.db）。

## Global Constraints

- **模型钉死**：全矩阵用 deepseek-v4-flash（opencode.ai/zen/go 端点）。`CONFIG.model` 默认 + `setup.ts` baseUrl 默认 + report 打印 + P5 spec/README 四处一致。key 从 `GLM_API_KEY` env 读，永不硬编码、永不打印。
- **`EXPERIMENT_STATE_MACHINE=off` 与 `EXPERIMENT_VERIFY=off` 只用于实验 harness，生产默认保持未设**（零影响）。
- 每次修改必须新增针对性测试（真回归守卫）；禁止删除/弱化功能以规避测试。
- 改 schema 勿跑交互式 `prisma migrate dev`（本计划不改 schema）。
- 行尾坑：改文件后 `git diff --stat` 核对无整文件假 diff（blob 多 CRLF）。
- 每任务独立提交；前一个全绿再下一个；提交前 pre-commit 三视角审查（无 ❌ 才 `git commit --no-verify`）。
- 开发文档（进度/规划/接续prompt）不上 GitHub。
- 权威 spec：`docs/superpowers/specs/2026-08-15-p6-full-matrix-design.md`（任务编号 A0-A5/T7 与之对应）。

---

### Task 1: A0 核心——chat-router 决策路径 trace 抑制修法（trace 记录不对称）

**Files:**
- Modify: `src/lib/services/chat-router.ts:170`（加 decisionApplied）+ `:198/:203/:207/:211/:225`（5 处抑制点）
- Test: `tests/chat-router.test.ts`（P5 OFF describe，:411 起，新增 3 守卫）

**Interfaces:**
- Consumes: `appendDecisionTrace` 返回值（`:170` 现有）+ `traceEntry.actualTransition.applied`
- Produces: handler 收到的 `recordTrace`/`recordExecuteTrace` 语义变化——**决策点记 applied:true 才抑制补记；no-op(applied:false) 不抑制**
- 依赖 T2（transitionPhase 补记 applied 收窄）：T2 改了补记条目语义，T1 的守卫 1 断言需配合

**根因（spec §3 A0）**：`decisionRecorded` 只反映 append 成功与否；OFF 表外决策点记 `applied:false` no-op 但 `decisionRecorded=true` → handler 传 `recordTrace:false` 抑制 → transitionPhase 不补记真转移 → oracle ② 判 no-pass（执行成功被判失败）。

- [ ] **Step 1: 写失败测试**——在 `tests/chat-router.test.ts` 的 `describe('P5: OFF 开关（EXPERIMENT_STATE_MACHINE=off）')`（:411）内新增（复用现有 mock：`mockSessionUpdateMany`/`mockGetOrchestratorDecision`/`mockHandlePMConfirm` 等）：

```ts
it('P6 A0: OFF 表外 no-op → 不抑制 handler 补记（recordTrace 传 true）', async () => {
  process.env.EXPERIMENT_STATE_MACHINE = 'off'
  mockSessionFindUnique.mockResolvedValue({ id: 's1', phase: 'alignment', phaseStep: 'architect_plan', decisionTrace: '[]' })
  mockTaskCount.mockResolvedValue(0)   // done 守卫在 OFF 下跳过，无任务不影响
  mockGetOrchestratorDecision.mockResolvedValue({ action: 'execute', reason: '直接执行' })  // align_arch 提 execute
  await handleOrchestratorDecision('执行', 's1', agents, sendEvent, { phase: 'alignment', phaseStep: 'architect_plan', decisionTrace: '[]' }, undefined, 'work', 'auto')
  // OFF 下 align_arch→execute 若为表外 → 决策点记 applied:false no-op → handler 必须补记
  expect(mockTransitionToExecution).toHaveBeenCalledWith(expect.any(String), 's1', agents, expect.any(Function), expect.any(String), expect.any(Number), expect.objectContaining({ recordExecuteTrace: true }))
})
```

> 注：若 `align_arch→execute` 是表内合法边（applied:true），此测试断言改为表外 action（如 align_arch 提 `done`）。**写测试前先读 `TRANSITIONS`（state-machine.ts）确认哪个 action 在 align_arch 表外**，让 OFF 走 no-op 分支。

- [ ] **Step 2: 跑测试验证失败**——`npx vitest run tests/chat-router.test.ts -t "P6 A0"`。当前传 `{ recordExecuteTrace: !decisionRecorded }` = false → 断言 expect true 必红。

- [ ] **Step 3: 实现**——`chat-router.ts:170` 后加：

```ts
const decisionRecorded = (await appendDecisionTrace(sessionId, sessionPhase.decisionTrace, traceEntry)) !== null
// P6 A0: 决策点记 no-op(applied:false) 时不抑制补记——决策点没记真实推进，handler 的 transitionPhase 必须补记
// （回归 P4「每个实际 phase 写入都入 trace」）。ON 模式 decisionApplied 恒 true（!ok 直接 return escalate），行为不变。
const decisionApplied = traceEntry.actualTransition.applied
```

5 处抑制点 `!decisionRecorded` → `!(decisionRecorded && decisionApplied)`：
| 位置 | 现值 | 改值 |
|------|------|------|
| `:198` align_confirm | `{ recordTrace: !decisionRecorded }` | `{ recordTrace: !(decisionRecorded && decisionApplied) }` |
| `:203` align_decompose | 同左 | 同上 |
| `:207` align_qa | 同左 | 同上 |
| `:211` execute | `{ recordExecuteTrace: !decisionRecorded }` | `{ recordExecuteTrace: !(decisionRecorded && decisionApplied) }` |
| `:225` done | `{ recordTrace: !decisionRecorded }` | `{ recordTrace: !(decisionRecorded && decisionApplied) }` |

- [ ] **Step 4: 跑测试验证通过**——新守卫 + 全 `chat-router.test.ts`（现有 OFF/ON 测试不破：ON 下 decisionApplied 恒 true → 行为不变）。

- [ ] **Step 5: 补第 2 条守卫（ON 抑制保持）**——现有 `:121-126`（align_decompose 传 `recordTrace:false`）与 `:143`（append 失败 → true）已覆盖；新增一条显式断言 OFF 表内（applied:true）仍抑制：

```ts
it('P6 A0: OFF 表内合法转移 → 决策点已记 applied:true → 仍抑制补记', async () => {
  // 选一个 OFF 下表内合法的 action（如 align_arch 提 align_qa），断言 handler 收到 recordTrace:false
})
```

- [ ] **Step 6: 提交**——`git add src/lib/services/chat-router.ts tests/chat-router.test.ts && git commit -m "feat: P6 A0 trace 不对称修法——决策点记 no-op(applied:false) 时不抑制 transitionPhase 补记,回归 P4 不变量"`

---

### Task 2: A0 trace 保真度——transitionPhase 补记 applied 用 inTable 收窄

**Files:**
- Modify: `src/lib/orchestrator/state-machine.ts:249`
- Test: `tests/state-machine.test.ts`（P5 OFF 区 :312 起）

**Interfaces:**
- Consumes: `applyTransitionWithOverride` 返回的 `inTable`（bypass 分支带，非 bypass 无）
- Produces: 补记条目 `actualTransition.applied` 语义修正——OFF 表外 self-edge 记 false

**问题（spec §3 A0 trace 保真度）**：`:249` 硬编码 `applied:true`。OFF 表外 action 经 handler 的 transitionPhase 补记时记 `{from:state,to:state,applied:true}` self-edge → 伪 illegal_transition 污染 conformance。

- [ ] **Step 1: 写失败测试**——`tests/state-machine.test.ts`：

```ts
it('P6 A0: transitionPhase 补记 OFF 表外 self-edge 记 applied:false', async () => {
  const prev = process.env.EXPERIMENT_STATE_MACHINE
  process.env.EXPERIMENT_STATE_MACHINE = 'off'
  try {
    mockSessionFindUnique.mockResolvedValue({ id: 's1', phase: 'idle', phaseStep: '', decisionTrace: '[]' })
    await transitionPhase('s1', 'align_qa')  // idle→align_qa 表外
    const traceCall = mockSessionUpdateMany.mock.calls.find(c => c[0].data?.decisionTrace)
    const entry = JSON.parse(traceCall![0].data.decisionTrace)
    expect(entry[0].actualTransition.applied).toBe(false)
  } finally { if (prev === undefined) delete process.env.EXPERIMENT_STATE_MACHINE; else process.env.EXPERIMENT_STATE_MACHINE = prev }
})
```

- [ ] **Step 2: 跑测试验证失败**——当前 `applied:true` 硬编码 → 断言 false 必红。

- [ ] **Step 3: 实现**——`:249`：

```ts
// P6 A0 trace 保真度：补记 applied 用 inTable 收窄——OFF 表外(bypass inTable:false)保持当前态非真转移,记 false
// 不污染 conformance；ON 无 inTable(true) 与 OFF 表内(true, 含 redo 自环 exec→exec) 保持 P4 语义。
actualTransition: { from: state, to: result.nextState, action, applied: 'inTable' in result ? result.inTable : true, escalated: false },
```

- [ ] **Step 4: 跑测试验证通过**——新守卫 + 全 `state-machine.test.ts`（现有 redo 自环 applied:true 测试不破：redo 是表内边）。

- [ ] **Step 5: 提交**——`git commit -m "feat: P6 A0 trace 保真度——transitionPhase 补记 applied 用 inTable 收窄,OFF 表外 self-edge 记 false"`

---

### Task 3: A1+A2 罐头差异化 + 语义化（run.test.ts）

**Files:**
- Modify: `experiments/p5/run.test.ts:22-33`（vi.hoisted 罐头）+ mock 分流逻辑（:53-55 fallback）
- Test: 并入 run.test.ts（纯函数单测）

**Interfaces:**
- Consumes: `TASKS`（tasks.ts 三档任务 id）+ `CONFIG`
- Produces: 按 task 三档罐头 + QA '无问题' + PM/delegate/self 语义句

**问题（spec §3 A1/A2）**：`cannedTasksJson` 固定 `declared_files:['src/index.ts']` → task C（改配置）被硬塞代码任务；PM/QA 返回 JSON blob 落库成决策上下文噪音，QA 的 JSON 被 `alignment.ts:330` 当提问多耗一轮。

- [ ] **Step 1: 改 vi.hoisted 罐头为三档 map**（`run.test.ts:22-33`）：

```ts
const mocks = vi.hoisted(() => {
  const preflightPromptMarker = '只回复两个字：就绪'
  // P6 A1: 罐头按 task 差异化——A/B 代码任务(触发 verify), C 非代码任务(declared_files:[] + 非代码描述, isCodeTask 不命中)
  const cannedTasksByTask: Record<string, string> = {
    A: JSON.stringify({ tasks: [{ id: 1, description: '实现 add(a,b) 函数并放在 src/utils/math.ts', assignedAgent: '后端工程师', dependencies: [], declared_files: ['src/utils/math.ts'] }] }),
    B: JSON.stringify({ tasks: [{ id: 1, description: '实现登录接口，路由 /api/login，放在 src/api/login.ts', assignedAgent: '后端工程师', dependencies: [], declared_files: ['src/api/login.ts'] }] }),
    C: JSON.stringify({ tasks: [{ id: 1, description: '修改项目根目录 .env.example 的端口配置为 8080', assignedAgent: '后端工程师', dependencies: [], declared_files: [] }] }),
  }
  const mockExecuteTaskBatch = vi.fn(async (tasks: any[]) => { ... })
  return { mockExecuteTaskBatch, preflightPromptMarker, cannedTasksByTask }
})
```

> task C 的 description 刻意无 `.ts`/`.js` 后缀（isCodeTask 同时查 description + declaredFiles），`declared_files:[]` 双保险。

- [ ] **Step 2: mock fallback 按消费者分流**（`:53-55`）——复用 systemPrompt 安全网原则（不用 LLM 可污染的 prompt 判定）：

```ts
// 3. decompose（架构师）→ 按 task 任务 JSON；QA（测试工程师等）→ '无问题'；PM（产品经理）→ 需求复述；其余 → 语义句
const sp = agent?.systemPrompt ?? ''
if (sp.includes('架构师')) return { result: mocks.cannedTasksByTask[currentTaskId] }
if (sp.includes('测试工程师')) return { result: '无问题' }        // A2: alignment.ts:330 判 !='无问题' 即提问,回'无问题'直接直发 exec
if (sp.includes('产品经理')) return { result: '已确认需求，请架构师拆解。' }  // A2: handlePMConfirm 不 JSON.parse,语义句安全
return { result: '任务已完成。' }  // delegate/self
```

> 需要把 `currentTaskId` 暴露给 mock 工厂（`vi.hoisted` 内加 `currentTaskId` 变量，run 循环设置）。

- [ ] **Step 3: 跑 harness 单测**——`npx vitest run --config experiments/p5/vitest.config.ts`（纯单测部分，非 30-run driver 需真实 key）。断言：task C 罐头 `declared_files:[]` + isCodeTask false；QA 罐头 '无问题'。

- [ ] **Step 4: 提交**——`git commit -m "feat: P6 A1+A2 罐头差异化——按 task 三档(非代码任务触发)+QA 回'无问题'语义化,消 JSON 噪音"`

---

### Task 4: A3 两套超时放宽

**Files:**
- Modify: `experiments/p5/config.ts:14` + `experiments/p5/vitest.config.ts:13`

**Interfaces:** 无（配置变更）

**问题（spec §3 A3）**：vitest testTimeout 360s 与 harness 自身 timeoutMs 300s 是两套独立约束。timeoutMs 经 `run-one.ts:62` → `globalDeadline` → `execution.ts:146` 硬判（`Date.now() > deadline → break`）。P5 实测 run 245-589s，589s 超 300s。

- [ ] **Step 1: 改 config.ts:14**——`timeoutMs: 5 * 60 * 1000` → `timeoutMs: 30 * 60 * 1000`（注释：与 vitest testTimeout 同值，globalDeadline 源头）。
- [ ] **Step 2: 改 vitest.config.ts:13**——`testTimeout: 6 * 60 * 1000` → `testTimeout: 30 * 60 * 1000`；hookTimeout 同步 `2*60*1000` → `30*60*1000`（beforeAll 的 setup 也跑真实 preflight）。
- [ ] **Step 3: 验证**——`npx tsc --noEmit` 无错 + 相关 harness 单测绿。
- [ ] **Step 4: 提交**——`git commit -m "fix: P6 A3 两套超时放宽——timeoutMs(globalDeadline)与 testTimeout 均 30min"`

---

### Task 5: A4 upsert update + 模型钉死（含 baseUrl 默认修正）

**Files:**
- Modify: `experiments/p5/setup.ts:34/:44-50`（baseUrl 默认 + upsert update）
- Modify: `experiments/p5/config.ts:4`（model 默认）
- Modify: `experiments/p5/report.ts:9`（打印 baseUrl）
- Modify: `docs/superpowers/specs/2026-08-13-p5-controlled-experiment-design.md` §2 模型行（历史事实修正）
- Modify: `README.md`（grep glm 提及，如实验相关则更新）
- Test: `experiments/p5/setup.test.ts`（新建或并入现有 harness 单测）

**问题（spec §3 A4 + §5）**：upsert `update:{}` 空子句 → 二次运行保留旧 model/baseUrl。且 **spec 遗漏**：setup.ts:34 baseUrl 默认仍 `https://open.bigmodel.cn/api/paas/v4`（智谱端点），模型钉死 deepseek 后不设 GLM_BASE_URL 会 deepseek 模型打智谱端点 = 错配。

- [ ] **Step 1: 改 config.ts:4**——`model: process.env.GLM_MODEL || 'glm-4.7-flash'` → `|| 'deepseek-v4-flash'`。
- [ ] **Step 2: 改 setup.ts**——`:34` baseUrl 默认 `'https://open.bigmodel.cn/api/paas/v4'` → `'https://opencode.ai/zen/go'`；`:47` `update: {}` → `update: { model: CONFIG.model, baseUrl: process.env.GLM_BASE_URL || 'https://opencode.ai/zen/go', apiKey: key }`。
- [ ] **Step 3: 改 report.ts:9**——`model: ${CONFIG.model}` → `model: ${CONFIG.model} | baseUrl: ${process.env.GLM_BASE_URL || 'https://opencode.ai/zen/go'}`。
- [ ] **Step 4: 写 upsert 守卫**——预置已存在 agent 用旧 model，跑 `ensureExperimentAgents` 后断言 DB agent.model/baseUrl/apiKey 被刷新（mock prisma.agent.upsert 或真实 DB + resetPrismaSingleton）。
- [ ] **Step 5: 同步 P5 spec §2 模型行 + README**——grep 确认 P5 spec 的"模型 | 智谱 glm-4.7-flash"行与 README 提及，更新为实际 deepseek-v4-flash（历史事实）。
- [ ] **Step 6: 验证 + 提交**——`git commit -m "fix: P6 A4+模型钉死——upsert update 写 model/baseUrl/apiKey + 默认 deepseek-v4-flash/opencode.ai/zen/go,修 baseUrl 错配"`

---

### Task 6: A5 report pass 数组按 seed 排序

**Files:**
- Modify: `experiments/p5/report.ts:22`

**问题（spec §3 A5）**：`:22` `cell.map(m => m.pass)` 按 metrics 插入序，run 完成顺序不同则数组漂移。

- [ ] **Step 1: 改 :22**——`const passes = cell.sort((a, b) => a.seed - b.seed).map(m => m.pass)`（`cell` 是 filter 出的新数组，sort 原地安全）。
- [ ] **Step 2: 写守卫**——构造乱序 metrics（seed 3,1,2），断言输出 pass 数组按 seed 升序。
- [ ] **Step 3: 提交**——`git commit -m "fix: P6 A5 report pass 数组按 seed 排序,消除插入序漂移"`

---

### Task 7: verify 开关（EXPERIMENT_VERIFY=off 只关自动创建）

**Files:**
- Modify: `src/lib/services/alignment.ts:232`
- Test: `tests/alignment.test.ts`

**Interfaces:**
- Produces: 新增实验开关 `EXPERIMENT_VERIFY=off`（只关 verify 自动创建，done 守卫天然正交：OFF 下已跳过、ON+no-verify 无 verify 可查）

- [ ] **Step 1: 写失败测试**——`tests/alignment.test.ts`：

```ts
it('P6: EXPERIMENT_VERIFY=off 不自动创建 verify 任务', async () => {
  const prev = process.env.EXPERIMENT_VERIFY
  process.env.EXPERIMENT_VERIFY = 'off'
  try {
    // mock handleArchitectPlan 依赖（prisma.task.create 等），构造含代码任务 → 断言无 verify- 前缀 task.create
    await handleArchitectPlan('拆解', 's1', agents, sendEvent, {})
    expect(mockTaskCreate).not.toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ id: expect.stringMatching(/^verify-/) }) }))
  } finally { if (prev === undefined) delete process.env.EXPERIMENT_VERIFY; else process.env.EXPERIMENT_VERIFY = prev }
})

it('P6: 未设 EXPERIMENT_VERIFY → 默认创建 verify 任务', async () => {
  // 现有 handleArchitectPlan 测试已覆盖（默认建 verify），补一条显式断言未设 env 时创建
})
```

- [ ] **Step 2: 跑测试验证失败**——当前无条件创建 → 第一条断言必红。
- [ ] **Step 3: 实现**——`alignment.ts:232`：

```ts
const codeTasks = scheduledTasks.filter(t => isCodeTask(t) && !t.id.startsWith('verify-'))
// P6: verify 维度实验开关——EXPERIMENT_VERIFY=off 只关自动创建(实验 harness),生产默认未设零影响。
// done 守卫(chat-router.ts:127)天然正交:OFF 下已跳过,ON+no-verify 无 verify 可查。
if (codeTasks.length > 0 && process.env.EXPERIMENT_VERIFY !== 'off') {
```

- [ ] **Step 4: 跑测试验证通过**——新守卫 + 全 `alignment.test.ts`（现有 verify 创建测试不破）。
- [ ] **Step 5: 提交**——`git commit -m "feat: P6 verify 维度开关——EXPERIMENT_VERIFY=off 只关 alignment 自动创建,生产默认未设"`

---

### Task 8: 2×2 配置矩阵（configs 4 配置 + run env 透传 + report 主效应/交互）

**Files:**
- Modify: `experiments/p5/config.ts`（configs 扩 4 + envForConfig）
- Modify: `experiments/p5/run-one.ts:10/:22-24`（RunInput.config 类型 + env 透传）
- Modify: `experiments/p5/report.ts`（4 配置逐格 + 状态机/verify 主效应 + 交互）
- Modify: `experiments/p5/metrics.ts`（如 RunMetrics 需加维度字段）
- Test: 并入 harness 单测

**Interfaces:**
- Consumes: Task 6 的 seed 排序（主效应 McNemar 需同 seed 配对）
- Produces: `CONFIG.envForConfig(config)` → `{ EXPERIMENT_STATE_MACHINE?, EXPERIMENT_VERIFY? }`；report 输出 4 配置逐格 + 状态机主效应 + verify 主效应 + 交互

**配置定义（spec §4.1）**：`on+verify` / `on+no-verify` / `off+verify` / `off+no-verify`。

- [ ] **Step 1: config.ts 扩 configs**——`configs: ['on', 'off'] as const` → `configs: ['on+verify', 'on+no-verify', 'off+verify', 'off+no-verify'] as const`，加：

```ts
export const envForConfig = (config: string) => ({
  EXPERIMENT_STATE_MACHINE: config.startsWith('off') ? 'off' : undefined,
  EXPERIMENT_VERIFY: config.includes('no-verify') ? 'off' : undefined,
})
```

- [ ] **Step 2: run-one.ts 透传**——`RunInput.config: 'on'|'off'` → `CONFIG.configs[number]`；`:23-24`：

```ts
const env = CONFIG.envForConfig(config)
if (env.EXPERIMENT_STATE_MACHINE === 'off') process.env.EXPERIMENT_STATE_MACHINE = 'off'
else delete process.env.EXPERIMENT_STATE_MACHINE
if (env.EXPERIMENT_VERIFY === 'off') process.env.EXPERIMENT_VERIFY = 'off'
else delete process.env.EXPERIMENT_VERIFY
```

- [ ] **Step 3: report.ts 重构**——保留逐格 pass 数组（4 配置自动扩）+ 加主效应/交互：

```ts
// 状态机主效应（verify 固定,同 seed ON vs OFF）
for (const verify of ['verify', 'no-verify']) {
  const on = metrics.filter(m => m.config === `on+${verify}` && m.taskId === tid).sort((a,b)=>a.seed-b.seed).map(m=>m.pass)
  const off = metrics.filter(m => m.config === `off+${verify}` && m.taskId === tid).sort((a,b)=>a.seed-b.seed).map(m=>m.pass)
  const m = pairedMcNemar(off, on)
  lines.push(`- ${tid} (${verify}): ON+${verify}${on.filter(Boolean).length}/${on.length} vs OFF+${verify}${off.filter(Boolean).length}/${off.length} | b=${m.b} c=${m.c} p≈${m.pValue.toFixed(3)}`)
}
// verify 主效应（状态机固定,同 seed verify vs no-verify）——同构,四组各一次
// 交互:2×2 列联表 pass 率表
lines.push('| task | verify | ON 率 | OFF 率 | Δ(ON-OFF) |')
```

> 现有 `:29-30`（ON vs OFF 配对）与 `:45-47`（`config === 'off'` 硬编码非法尝试率分支）需改造为 4 配置通用。

- [ ] **Step 4: 写 harness 单测**——`envForConfig` 四配置映射正确；`report` 对 4 配置 × 3 任务 × 5 seed 的模拟 metrics 输出含状态机主效应 + verify 主效应行（断言关键行存在且 b/c 值正确）。
- [ ] **Step 5: 跑 harness 单测 + 生产全量回归**——`npx vitest run`（生产 1050+ 基线不破）+ `npx vitest run --config experiments/p5/vitest.config.ts`（纯单测）。
- [ ] **Step 6: 提交**——`git commit -m "feat: P6 2×2 配置矩阵——configs 4 配置+envForConfig 透传,report 状态机/verify 主效应+交互"`

---

### Task 9: 全量验证 + pre-commit 三视角审查 + 提交

- [ ] **Step 1: 全量**——`npx vitest run`（生产）全绿 + `npx tsc --noEmit` src/ 0 错 + harness 单测全绿。
- [ ] **Step 2: 行尾核对**——`git diff --stat` 无整文件假 diff。
- [ ] **Step 3: pre-commit 三视角**——dispatch 3 并行 subagent（攻击者/生命周期/声明vs实现）审 T1-T8 全部改动，无 ❌ 才提交。
- [ ] **Step 4: 归档存档**——如工作树有未提交改动先存档。
- [ ] **Step 5: off-C-s4 修复闭环验证**（需真实 GLM key，用户在确认后手动跑或下会话跑）——`EXPERIMENT_STATE_MACHINE=off` + 修正后罐头跑 off-C-s4 单格，确认 trace 出现 execute 边、pass 判定符合预期。此步验证 A0 修法有效，非重跑基线。

---

### Task 10: 文档同步 + 接续 prompt + 会话归档

- [ ] **Step 1: CLAUDE.md**——加 `EXPERIMENT_VERIFY=off` 不变量行（§5 已定义）+ 全矩阵进度指针。
- [ ] **Step 2: PROGRESS.md**——P6 行（残留 6 项 + 2×2 矩阵）。
- [ ] **Step 3: README.md**——模型三处统一确认（Task 5 已改）。
- [ ] **Step 4: memory**——更新 `project_agenthub_direction_a_state_machine.md`（P6 残留修复细节 + 2×2 配置 + trace 不对称根因）。
- [ ] **Step 5: 会话归档**——`D:\18387\wiki知识库\私密空间\wiki-ascii\raw\sources\claude-code\sessions\2026-08-15-AgentHub-P6全矩阵.md`。
- [ ] **Step 6: 接续 prompt**——更新 `D:\ai全栈挑战赛\A方向-P6接续prompt.md`（标注已完成项 + 60-run 执行指引）或写 P7 接续 prompt。
- [ ] **Step 7: 提交**——`git commit -m "docs: P6 同步——CLAUDE.md 不变量+PROGRESS+memory+会话归档"`

---

## 验证

1. 每任务独立提交；前一个全绿再下一个；关键守卫红绿验证（`git stash` → 必红 → 恢复 → 绿）。
2. 全量 `npx vitest run`（基线 1050 passed/3 skipped，T1-T8 预计 +10 左右）+ `npx tsc --noEmit` src/ 0 错。
3. 行尾核对：`git diff --stat` 无整文件假 diff。
4. pre-commit 三视角并行 subagent，无 ❌ 才 `git commit --no-verify`。
5. 60-run 执行（用户确认后）：分批可续跑（12 批 × 5 run），跑前备份 metrics.jsonl，provider 限流即停。
