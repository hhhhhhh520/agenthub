# P7-A 去引导区分度实验 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 通过把 delegate/self 罐头从「引导 execute」回退为中性 + failKind 按 off/on 分列诊断，重建状态机 ON/OFF 在实验 harness 里的区分度。

**Architecture:** 只改实验 harness（`experiments/p5/`），生产源码零 touch。三条改动线：① mock 罐头拆分 delegate(中性抽象 JSON)/self(中性文本)；② `RunMetrics` 加可选 `failKind` 字段 + `collectMetrics` 穷尽判定；③ report 加 failKind 诊断段。另加 `P7_GATE` 单格过滤支撑「先冒烟再铺满」的 Gate 决策。

**Tech Stack:** Vitest 4.x + TypeScript，`experiments/p5/` harness（config/tasks/run-one/metrics/report/stats/run.test.ts）。

## Global Constraints

- 生产源码（`src/lib/`）**零改动**——只允许碰 `experiments/p5/`。
- 模型/provider 钉死不动：`deepseek-v4-flash` + `GLM_MODEL/GLM_BASE_URL` env；key 从 env 读永不硬编码/打印。
- 「行为引导红线」(spec §4.1 + 安全审查 F1)：罐头措辞不得含 `执行 / 继续 / 已就绪 / 实现 / 可执行` 引导根。定稿前须经 `p5.db` 轨迹实证。
- failKind(安全审查 F2/F4/F5)：对 `resolveFailureMode` 全部 5 值穷尽、total（绝不 throw）、命名用 `defect` 不复用 `stuck`。
- `RunMetrics.failKind` 为 **optional**（安全审查 F6）：不破坏 JSONL 前后兼容/resume 旧行；report/loadMetrics 显式处理 `undefined`。
- delegate shape 契约(安全审查 F3)：delegate 返回可解析 `{tasks:[]}` JSON；self 返回不可解析文本；判别器用 `agent?.name === 'Orchestrator'` 精确相等，不用模糊子串。
- oracle/`tasks.ts` requiredEdges **零改动**（spec §4.3）；oracle ② 从 decisionTrace 读，不读 mock 罐头（spec §9）。
- 每次 task 前 `git add . && git commit -m "chore: 存档 - ..."`；每次修改新增针对性测试（红绿验证）；提交前 pre-commit 三视角审查。
- spec/plan 存 `docs/superpowers/`（本地 untracked 不推 GitHub）。
- 决策路径真实 LLM 保持（`ORCHESTRATOR_DECISION_PROMPT` 判定放行真实）；执行全 mock 保持。

---
## File Structure

| 文件 | 职责 | 改动 |
|------|------|------|
| `experiments/p5/run.test.ts` | harness 主测试 + vi.mock 罐头 factory | **改**：delegate/self 拆分 + P7_GATE 单格过滤 |
| `experiments/p5/metrics.ts` | RunMetrics / oracle / collectMetrics / JSONL | **改**：FailKind 字段 + failKind 判定 |
| `experiments/p5/run-one.ts` | 单次 run 驱动 | **改**：minimalErrorRow 补 failKind:'defect' |
| `experiments/p5/report.ts` | generateReport | **改**：failKind 诊断段 |
| 生产 `src/lib/` | — | **零改动** |

## 提交顺序
1. `chore: 存档 - P7-A 开始前基线`
2. `feat(p5): P7-A 罐头拆分——delegate 中性JSON/self 中性文本 + shape 契约测试`
3. `feat(p5): P7-A failKind 按 off/on 分列诊断（metrics + run-one，穷尽 total 防抖）`
4. `feat(p5): P7-A report failKind 诊断段 + P7_GATE 单格运行`
5. `docs: P7-A 运行手册 + Gate 决策记录 + PROGRESS/memory/接续 prompt 同步`

---

### Task 1: 罐头拆分 delegate/self（去行为引导）

**Files:**
- Modify: `experiments/p5/run.test.ts`（vi.hoisted mock factory + delegate/self 断言）
- Test: `experiments/p5/run.test.ts`（同一文件内 `P6 A1+A2 罐头差异化` describe）

**Interfaces:**
- Consumes: 现有 `mocks` vi.hoisted 对象（`cannedTasksByTask`、`state`、`preflightPromptMarker`、`qaPromptMarker`）。
- Produces: 新增 `mocks.DELEGATE_NEUTRAL_JSON`；mock 里 delegate/self 两条独立 return 路径。
- 供 Task 4 用：判别器约定 `agent?.name === 'Orchestrator'` → self；其余非 架构师/测试/PM → delegate。

- [ ] **Step 1: 写失败测试（shape 契约 + 反引导，红）**

在 `experiments/p5/run.test.ts` 的 `P6 A1+A2 罐头差异化` describe 内，把现有 `'其余(delegate/self)语义句'` 测试(:187-192)替换为下面 3 个测试：

```ts
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
    { name: 'Orchestrator', systemPrompt: ORCHESTRATOR_SELF_SYSTEM_PROMPT }, 'prompt', '', () => {})
  expect(r.result).toBe('我已处理，结果如下。')
  expect(() => JSON.parse(r.result)).toThrow()
})
```
（`ORCHESTRATOR_SELF_SYSTEM_PROMPT` 用现有 mock factory 可识别的 self 触发——见 Step 3 判别器，测试里直接用能命中 self 分支的 systemPrompt。为最小改动，self 测试传 `{ name: 'Orchestrator', systemPrompt: '你是 Orchestrator' }` 即可，判别只依赖 name。）

- [ ] **Step 2: 跑测试确认红**
Run: `cd /d/ai全栈挑战赛/agenthub && npx vitest run --config experiments/p5/vitest.config.ts run.test.ts -t '罐头差异化'`
Expected: FAIL——`JSON.parse` 对旧引导句抛 SyntaxError；`description` 为 undefined。

- [ ] **Step 3: 实现罐头拆分 + 判别器（绿）**

在 vi.hoisted factory 里（`mocks` 返回对象加一字段）：

```ts
const DELEGATE_NEUTRAL_JSON = JSON.stringify({
  tasks: [{ id: 1, description: '拆解得出的子任务', assignedAgent: '后端工程师', dependencies: [], declared_files: [] }],
})
```
并在 `return { mockExecuteTaskBatch, preflightPromptMarker, qaPromptMarker, cannedTasksByTask, state, DELEGATE_NEUTRAL_JSON }` 暴露。

在 mock 的 `executeSingleAgent` body `:72-76`，把唯一的 `return { result: '委派任务已受理...' }` 换成：

```ts
      const sp = agent?.systemPrompt ?? ''
      if (sp.includes('架构师')) return { result: mocks.cannedTasksByTask[mocks.state.currentTaskId] }
      if (sp.includes('测试工程师')) return { result: '无问题' }
      if (sp.includes('产品经理')) return { result: '已确认需求，请架构师拆解。' }
      // P7-A: delegate/self 拆开（旧唯一 return 语义句引导 execute 抹平 ON/OFF 对比）。
      // self = orchestrator 自执行（handleOrchestratorChat 恒传 name:'Orchestrator'，chat-router.ts:271）
      //       → 中性文本，不可解析（F3 shape 契约）。
      // delegate = 委派目标 agent（delegateToAgent 传真实名如 后端工程师，review.ts:143）
      //       → 中性抽象 JSON（F1 无引导根）。判别用 name 精确相等，非模糊子串。
      // ⚠️ 边界（计划 Task 1 注）：sp.includes('架构师') 在 name 判别前 → 若委派目标是架构师，
      //       会命中上方架构师分支返回三档罐头 JSON 而非中性 delegate JSON。当前 3 任务委派目标
      //       均为后端工程师（不触发），故不阻塞；未来若加「委派给架构师」的任务需重排分支优先级。
      if (agent?.name === 'Orchestrator') return { result: '我已处理，结果如下。' } // self
      return { result: mocks.DELEGATE_NEUTRAL_JSON } // delegate
```

- [ ] **Step 4: 跑测试确认绿**
Run: `cd /d/ai全栈挑战赛/agenthub && npx vitest run --config experiments/p5/vitest.config.ts run.test.ts`
Expected: harness 全部纯单测 PASS（delegate/self shape 契约 2 个新测试 + 其余 P6 单测不回归）。注意：**这个任务不加 `P7_GATE` 过滤，60-run driver 因 `skipIf(!GLM_API_KEY)` 无 key 时自动 skip**，不会误跑。

- [ ] **Step 5: 提交**
```bash
cd /d/ai全栈挑战赛/agenthub && git add experiments/p5/run.test.ts && git commit -m "feat(p5): P7-A 罐头拆分——delegate 中性JSON/self 中性文本 + shape 契约测试"
```

---

### Task 2: failKind 按 off/on 分列诊断（metrics + run-one）

**Files:**
- Modify: `experiments/p5/metrics.ts`（FailKind 字段 + collectMetrics 判定）
- Modify: `experiments/p5/run-one.ts`（minimalErrorRow 补 failKind:'defect'）
- Test: `experiments/p5/run.test.ts`（`P5 harness 单测` describe 内新增 failKind 单测）

**Interfaces:**
- Consumes: `resolveFailureMode`（metrics.ts:56）返回值 `pass | escalate-exhausted | stuck | error | no-pass`；`hasRequiredEdges`；`onConformanceOk`（collectMetrics 内已算）。
- Produces: 导出 `FailKind` 类型 + `RunMetrics.failKind?: FailKind`；`collectMetrics` 返回含 failKind。
- 供 Task 3 报告用例：failKind 值域 `'skipped-spec-edge' | 'done-but-conformance' | 'defect' | undefined`。

- [ ] **Step 1: 写失败测试（failKind 判定位次，红）**

在 `P5 harness 单测` describe 内加：

```ts
import { collectMetrics, type FailKind } from './metrics' // 若 collectMetrics 未在顶部 import 则补
it('P7-A failKind: 穷尽 + 按 off/on 分列（F2/F4/F5）', () => {
  // 仅供逻辑验证——collectMetrics 本身查 DB，这里测纯的 failKind 归类seed 需 mock prisma；
  // 为不依赖 DB，用可注入的判定函数（Step 3 导出 classifyFailKind）。
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
```

- [ ] **Step 2: 跑测试确认红**
Run: `cd /d/ai全栈挑战赛/agenthub && npx vitest run --config experiments/p5/vitest.config.ts run.test.ts -t 'failKind'`
Expected: FAIL——`classifyFailKind` 未定义（ReferenceError）。

- [ ] **Step 3: 实现 classifyFailKind + 接线（绿）**

`experiments/p5/metrics.ts` 顶部加类型导出 + 纯函数（判定位次）：**error 优先 defect → 未 done defect → 缺规范边 skipped-spec-edge → conformance done-but-conformance → 兜底 defect**：

```ts
export type FailKind = 'skipped-spec-edge' | 'done-but-conformance' | 'defect'

/** P7-A failKind：no-pass 归因（F2 穷尽 5 failureMode / F4 total 绝不 throw / F5 用 defect 非 stuck 避歧义）。
 * error→defect(harness缺陷)；未done→defect；done但缺规范边→skipped-spec-edge(状态机价值，以 OFF 为主要来源——
 * CONFIG.on 实际到不了 missing-edges-no-pass: done⟹曾在 exec⟹必有 execute 边，故 on 不产生此义，但实现不强制)；
 * done但conformance违规→done-but-conformance(状态机价值,on)；其余兜底 defect。
 * 注: _config 当前未用于分支（判定位次已隐含可区分），保留参数仅为接口稳定。 */
export function classifyFailKind(
  failureMode: string,
  done: boolean,
  requiredEdgesOk: boolean,
  onConformanceOk: boolean,
  _config: string,
): FailKind | undefined {
  if (failureMode === 'pass') return undefined
  if (failureMode === 'error') return 'defect'
  if (!done) return 'defect'
  if (!requiredEdgesOk) return 'skipped-spec-edge'
  if (!onConformanceOk) return 'done-but-conformance'
  return 'defect' // escalate-exhausted / no-pass 兜底 → harness 缺陷
}
```

在 `RunMetrics` interface 加 `failKind?: FailKind`（F6 optional）。`collectMetrics` `:96-98` 处接上：

```ts
  const pass = error ? false : (done && requiredEdgesOk && (config.startsWith('off') ? true : onConformanceOk))
  const failureMode = resolveFailureMode(pass, escalateCount, rounds, error)
  const failKind = classifyFailKind(failureMode, done, requiredEdgesOk, onConformanceOk, config)
```
return 对象加 `failKind`。

`experiments/p5/run-one.ts` `minimalErrorRow`(:138-142) return 加 `failKind: 'defect' as const`。

- [ ] **Step 4: 跑测试确认绿**
Run: `cd /d/ai全栈挑战赛/agenthub && npx vitest run --config experiments/p5/vitest.config.ts run.test.ts`
Expected: PASS——新 failKind 单测过，现有 metrics/report fixture（含 `failKind` 缺失的 `as any` 行）因 optional 字段不回归。

- [ ] **Step 5: 提交**
```bash
cd /d/ai全栈挑战赛/agenthub && git add experiments/p5/metrics.ts experiments/p5/run-one.ts && git commit -m "feat(p5): P7-A failKind 按 off/on 分列诊断（metrics+run-one，穷尽 total 防抖）"
```

---

### Task 3: report failKind 诊断段 + P7_GATE 单格运行

**Files:**
- Modify: `experiments/p5/report.ts`（`## failKind 诊断` 段）
- Modify: `experiments/p5/run.test.ts`（60-run driver 加 `P7_GATE` 单格过滤 + report failKind 单测）
- Test: `experiments/p5/run.test.ts`（`P5 report` describe 内新增）

**Interfaces:**
- Consumes: `RunMetrics.failKind?`（Task 2 产物）、`CONFIG.configs`、`CONFIG.taskIds`。
- Produces: report 含 `## failKind 诊断（no-pass 分解）` 段；`P7_GATE=1` 时 60-run 循环缩成单格。
- 供 Task 4 运行手册：`P7_GATE=1` 触发单格冒烟，读 report 的 failKind 分布做 Gate 决策。

- [ ] **Step 1: 写失败测试（report failKind 段 + P7_GATE 过滤语义，红）**

在 `P5 report` describe 内加：

```ts
it('P7-A: report 含 failKind 诊断段（no-pass 分解，value vs defect 两列）', () => {
  const metrics: RunMetrics[] = [
    { runId: 'v1', config: 'off+verify', taskId: 'A', seed: 0, pass: false, failureMode: 'no-pass', rounds: 3, escalateCount: 0, correctionCount: 0, illegalProposalCount: 1, totalTransitions: 2, latencyMs: 10, tracePath: '', failKind: 'skipped-spec-edge' },
    { runId: 'e1', config: 'on+verify', taskId: 'A', seed: 1, pass: false, failureMode: 'error', rounds: 2, escalateCount: 0, correctionCount: 0, illegalProposalCount: 0, totalTransitions: 0, latencyMs: 8, tracePath: '', failKind: 'defect' },
  ]
  const report = generateReport(metrics)
  expect(report).toContain('## failKind 诊断（no-pass 分解）')
  // 表格式输出（与 Step 3 实现的行一致，勿用人类格式子串）：
  // v1=skipped-spec-edge(价值格,s1) → value=1 defect=0, fmLine 只统计 defect→ '—'
  // e1=failKind defect + failureMode error → value=0 defect=1, fmLine='error:1'
  expect(report).toContain('| off+verify | A | 1 | 0 | — |')
  expect(report).toContain('| on+verify | A | 0 | 1 | error:1 |')
})
```

driver 侧（`P5 pilot: 60 次受控实验` describe，向 it 定义处加过滤）在循环 tôt 加——用 Step 3 的过滤，测试里单独断言不必要（逻辑极简），以 Task 4 手动跑 gate 验证。

- [ ] **Step 2: 跑测试确认红**
Run: `cd /d/ai全栈挑战赛/agenthub && npx vitest run --config experiments/p5/vitest.config.ts run.test.ts -t 'failKind 诊断段'`
Expected: FAIL——report 无 `## failKind 诊断` 子串。

- [ ] **Step 3: 实现 report 段 + P7_GATE 过滤（绿）**

`experiments/p5/report.ts` 在 `失效模式分布` 段（:86-90）后插入：

```ts
  // —— P7-A: failKind 诊断（no-pass 分解，状态机价值 vs harness 缺陷）——
  lines.push('', '## failKind 诊断（no-pass 分解）')
  lines.push('| config | task | 状态机价值 | harness 缺陷 | defect(by failureMode) |')
  lines.push('|---|---|---|---|---|')
  const cellFail = (config: string, taskId: string): RunMetrics[] => metrics.filter(m => m.config === config && m.taskId === taskId && m.pass === false)
  for (const config of CONFIG.configs) for (const taskId of CONFIG.taskIds) {
    const noPass = cellFail(config, taskId)
    if (noPass.length === 0) continue
    const value = noPass.filter(m => m.failKind === 'skipped-spec-edge' || m.failKind === 'done-but-conformance').length
    const defect = noPass.filter(m => m.failKind === 'defect' || m.failKind === undefined).length // undefined=旧resume行防 (F6)
    const fm = new Map<string, number>()
    for (const m of noPass.filter(x => x.failKind === 'defect')) fm.set(m.failureMode, (fm.get(m.failureMode) ?? 0) + 1)
    const fmLine = fm.size ? Array.from(fm.entries()).map(([k, v]) => `${k}:${v}`).join(' ') : '—'
    lines.push(`| ${config} | ${taskId} | ${value} | ${defect} | ${fmLine} |`)
  }
  lines.push('', '> 归因: 状态机价值=skipped-spec-edge(off 捷径被拦)+done-but-conformance(on 违规)；harness 缺陷=defect(stuck/error/escalate-exhausted/no-pass)')
```

`experiments/p5/run.test.ts` 60-run driver 循环处（:383-397）加单格过滤（Gate 支撑）：

```ts
  const P7_GATE = process.env.P7_GATE === '1' ? { config: 'off+verify', taskId: 'A' } : null
  for (const task of TASKS) for (const config of CONFIG.configs) for (const seed of SEEDS) {
    if (P7_GATE && (config !== P7_GATE.config || task.id !== P7_GATE.taskId)) continue
    it(...) // 原样
  }
```

- [ ] **Step 4: 跑测试确认绿**
Run: `cd /d/ai全栈挑战赛/agenthub && npx vitest run --config experiments/p5/vitest.config.ts run.test.ts`
Expected: PASS——report failKind 单测过，`P7_GATE` 未设时 60-run driver 行为与 P6 完全一致（无 key skip）。

- [ ] **Step 5: 提交**
```bash
cd /d/ai全栈挑战赛/agenthub && git add experiments/p5/report.ts experiments/p5/run.test.ts && git commit -m "feat(p5): P7-A report failKind 诊断段 + P7_GATE 单格运行"
```

---

### Task 4: Gate 冒烟 + 全矩阵运行 + 文档同步（运行手册）

**Files:**
- Run: `experiments/p5/run.test.ts`（driver，需 GLM_API_KEY）
- Docs: `experiments/p5/README.md` + 根 `PROGRESS.md` + memory + 会话归档 + P8 接续 prompt
- 注: 本 task 运行 harness，**需真实 GLM_API_KEY**；无 key 时记录为待运行，不虚构结果。

**Interfaces:**
- Consumes: Task 1-3 产物（中性罐头 + failKind + P7_GATE 过滤 + report 段）。
- Produces: 运行结果 metrics.jsonl + report.md；Gate 决策记录；文档同步。

- [ ] **Step 1: 冒烟前基线——确认生产全量 + harness 单测绿**
Run: `cd /d/ai全栈挑战赛/agenthub && npx vitest run`（生产，基线 1055 passed/3 skipped）+ `npx vitest run --config experiments/p5/vitest.config.ts run.test.ts`（harness 单测）
Expected: 两者全绿，生产零回归（Task 1-3 未碰 src/lib）。

- [ ] **Step 2: 单诊断格冒烟（Gate 信号 1：区分度是否恢复）**
Run: `cd /d/ai全栈挑战赛/agenthub && P7_GATE=1 GLM_API_KEY=<ark-key> npx vitest run --config experiments/p5/vitest.config.ts run.test.ts`（Ark 端点用 `GLM_BASE_URL=https://ark.cn-beijing.volces.com/api/plan` + deepseek-v4-flash）。
Expected: 只跑 `off+verify/A` ×5；afterAll 产出 report. 读取两个信号：
- **信号 A**：`off+verify A` 出现 no-pass 且 failKind=`skipped-spec-edge` → 去引导后 OFF 自由推进会走捷径被拦 = **区分度恢复** → 铺满全矩阵。
- **信号 A'**：`off+verify A` 仍 5/5 pass → mock 装置/补拆兜底仍诱导规范边 → **按 spec §5 Gate 判定「mock 装置测不出」→ 停止铺全矩阵，直接写结论收官**。

- [ ] **Step 3: Gate 决策 → 铺满 or 收官**
- 若 Step 2 信号 A（区分度恢复）：铺全矩阵——`cd /d/ai全栈挑战赛/agenthub && GLM_API_KEY=<ark-key> GLM_BASE_URL=https://ark.cn-beijing.volces.com/api/plan npx vitest run --config experiments/p5/vitest.config.ts run.test.ts`（60 run，12 批可续跑，重跑前备份 metrics.jsonl）。
- 若 Step 2 信号 A'（删不出差异）：不铺全矩阵，直接写 Gate 结论到 report。

- [ ] **Step 4: 报告 + 结论 + 文档同步**
1. `experiments/p5/results/report.md` 更新：含 failKind 诊断段、Gate 决策记录、A/B 是否恢复区分的结论。
2. 根 `PROGRESS.md` P7-A 行。
3. memory `project_agenthub_direction_a_state_machine.md`。
4. 会话归档 `D:\18387\wiki知识库\私密空间\wiki-ascii\raw\sources\claude-code\sessions\{date}-{slug}.md`。
5. P8 接续 prompt（`D:\ai全栈挑战赛\A方向-P8接续prompt.md`）——写明 Gate 结果决定是否还有后续实验。

- [ ] **Step 5: 推送（若需要）+ 凭证/敏感检查**
git 扫描密钥、确认 `.gitignore` 排 `/experiments/p5/*.db` 与 `results/`、`docs/superpowers/` 不推，然后 push。

---

## Self-Review

**Spec coverage（逐条对 spec）**：
- §2 目标「最大化区分度」→ Task 1（去引导）核心。
- §4.1 罐头唤醒 + 分歧 + delegate 中性抽象 JSON + self 中性文本 + F1 反引导根 → Task 1 Step 3/Step 1 断言。
- §4.2 failKind 按 off/on 分列 + 穷尽 5 值 + `defect` 命名 → Task 2 Step 3 classifyFailKind。
- §4.3 范围（不改 oracle/决策 prompt/verify 结构/生产）→ Task 只碰 `experiments/p5/`，Global Constraints 写明。
- §5 Gate（单诊断格先冒烟、OFF 仍 5/5 则收官）→ Task 4 Step 2/3 显式分支。
- §6 统计沿用 + failKind 报告段 → Task 3。
- §7 验证（shape 契约 F3、failKind 归因 error/escalate /F2/F4/F5、可选兼容 F6）→ Task 1 Step 1、Task 2、Task 3 Step 1。
- §9 oracle 边界（tasks.ts 零改，oracle ② 读 trace 不读 mock）→ Global Constraints + 本 plan 不含 tasks.ts。

**Placeholder scan**：无 TBD/TODO；所有 code step 含真实代码。`P7_GATE`/`classifyFailKind`/`FailKind`/`mocks.DELEGATE_NEUTRAL_JSON` 均在对应 task 定义。

**Type consistency**：
- `classifyFailKind(failureMode:string, done, requiredEdgesOk, onConformanceOk, config) → FailKind | undefined`：Task 2 定义 + Task 2 测试一致使用。
- `RunMetrics.failKind?: FailKind`：Task 2 加、Task 3 report `m.failKind === 'defect' || undefined` 消费一致。
- `'skipped-spec-edge' | 'done-but-conformance' | 'defect'` 值域跨 Task 2/3 一致。
- `mocks.DELEGATE_NEUTRAL_JSON`：Task 1 产出、Task 1 测试消费一致。
- `P7_GATE`：Task 3 实现、Task 4 运行一致。
- report 段 cell 过滤 `m.pass === false`：Task 3 report vs Task 3 测试 fixture（pass:false）一致。