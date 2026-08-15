# P6 全矩阵受控实验设计：先修 P5 残留 6 项，再扩展 2×2 矩阵（状态机 × verify）

> 日期：2026-08-15 | 状态：设计已收敛（用户审查 trace 不对称 + 模型钉死后批准）
> 项目：AgentHub A方向（显式状态机） | 规划文档 §9.2（OpenBench + ClawBench 范式）
> 上游：`docs/superpowers/specs/2026-08-13-p5-controlled-experiment-design.md`（P5，已批准执行完）

## 1. 目标

P6 = 任务 A（先修 P5 已知残留，全矩阵前必修）+ 任务 B（扩展全矩阵：状态机 × verify 的 2×2 析因）。

**任务 A**：修复 6 项残留——其中 **trace 记录不对称是测量缺陷**（P5 审查定位，OFF 下执行成功被判失败），必须最先修，否则 2×2 的 OFF 劣势被系统性夸大，60-run 白烧一半。

**任务 B**：验证 §9.2 首列维度「verify 有无」对可靠性的贡献，及与状态机的交互——**「verify 只在状态机强制时才有价值」正是 A 方向论点的直接验证**。

**模型钉死**：全矩阵用 **deepseek-v4-flash**（P5 实测验证，opencode.ai/zen/go 端点，用户提供 key）。spec/README/报告三处统一，修掉 P5 的「spec 说 glm / 实际跑 deepseek / README 写 glm」三方不一致。

## 2. 已拍板决策（用户确认）

| 决策 | 选择 |
|------|------|
| 配置矩阵 | **2×2**：状态机(on/off) × verify(有/无) = 4 配置 × 3 任务 × 5 seed = **60 run** |
| verify 关闭点 | 独立开关 `EXPERIMENT_VERIFY=off`，**只包 alignment.ts:232 自动创建块**（done 守卫 chat-router.ts:127 在 OFF 下已跳过、ON+无verify 无 verify 可查，天然正交） |
| trace 不对称修法 | chat-router 只在决策点记 applied:true 时抑制补记；no-op(applied:false) 时不抑制，transitionPhase 补记真实推进（回归 P4 不变量） |
| 模型 | **deepseek-v4-flash**（P5 实跑），spec/README/报告三处统一，CONFIG.model 默认改它，GLM_MODEL env 可覆盖 |
| 执行策略 | **分批可续跑**：12 批（4 配置×3 任务）× 5 run，每批落盘后检查限流，可中断续跑；testTimeout 放宽到 `30*60*1000` |
| 残留修复顺序 | **trace 不对称（A0）最前**，A3 补跑 off-C-s4 之前必须修（补跑的是偏的数据 = 白跑） |
| 统计 | 每格 5 seed，bootstrap CI + 配对 McNemar + **2×2 析因主效应/交互** |
| Judge 纪律 | LLM judge 只做 sidecar，确定性 oracle 权威（P5 已定，延续） |

## 3. 任务 A：修 6 项残留

### A0【阻塞，最先修】trace 记录不对称（OFF 下执行成功被判失败）

**代码事实（已核实）**：
- `chat-router.ts:170`：`decisionRecorded = (await appendDecisionTrace(...)) !== null` —— **只反映 append 成功与否**，不反映决策点记的是 applied:true 还是 no-op。
- OFF 表外分支（`:164`）：`actualTransition` 记 `{ from: state, to: state, action, applied: false, escalated: false }`（no-op）。但 `decisionRecorded` 仍为 `true` → 后续 handler 传 `{ recordTrace: !decisionRecorded }` = `false` → transitionPhase 不补记。
- P4 不变量「每个实际 phase 写入都入 trace」在 OFF 路径被破坏：`recordTrace:false` 抑制假设「决策点已记了同一转移」，但 OFF 下决策点记的是 no-op，抑制把真转移吞了。
- **p5.db 实测 off-B 轨迹**：align_pm 提前提 execute（表外）→ 决策点记 applied:false → handler 补拆实际推进 align_arch→exec 被抑制 → 任务实际执行、phase 到 done，但 trace 无 execute 边 → oracle ② 判 no-pass。**5 条 off-B 全中**；off-C 的 no-pass 大概率同源（捷径任务 = 提前 execute 高发场景）。
- ON 模式无此问题：决策点记的恒为 applied:true（`!ok` 直接 return escalate）。

**修法**（用户审查建议，已核实采纳）：`chat-router.ts:170` 后加 `decisionApplied`，决策路径 5 处抑制点（`:198/:203/:207/:211/:225`）从 `!decisionRecorded` 改为 `!(decisionRecorded && decisionApplied)`：

```ts
const decisionRecorded = (await appendDecisionTrace(sessionId, sessionPhase.decisionTrace, traceEntry)) !== null
// P6 A0: 决策点记 no-op(applied:false) 时不抑制补记——决策点没记真实推进，handler 的 transitionPhase 必须补记
// （回归 P4「每个实际 phase 写入都入 trace」）。ON 模式 decisionApplied 恒 true（!ok 直接 return escalate），行为不变。
const decisionApplied = traceEntry.actualTransition.applied
```

| 抑制点 | 现值 | 改值 |
|--------|------|------|
| `:198` align_confirm | `{ recordTrace: !decisionRecorded }` | `{ recordTrace: !(decisionRecorded && decisionApplied) }` |
| `:203` align_decompose | `{ recordTrace: !decisionRecorded }` | 同上 |
| `:207` align_qa | `{ recordTrace: !decisionRecorded }` | 同上 |
| `:211` execute | `{ recordExecuteTrace: !decisionRecorded }` | `{ recordExecuteTrace: !(decisionRecorded && decisionApplied) }` |
| `:225` done | `{ recordTrace: !decisionRecorded }` | `{ recordTrace: !(decisionRecorded && decisionApplied) }` |

alignment.ts 内部透传无需改（`:69/:256/:281/:374` 的 `opts.recordTrace ?? true/false` 已正确）。

**修复链路验证**（off-B 轨迹）：OFF 表外 no-op → decisionApplied=false → execute case 传 `recordExecuteTrace: true` → transitionToExecution 0-task 补拆（handleArchitectPlan 默认 recordTrace:true 补记 align_decompose）+ `:374` transitionPhase('execute', {recordTrace:true}) 补记 execute 边 → oracle ② 能看到 execute 边 ✓

**真回归守卫**（`tests/chat-router.test.ts` 新增）：
1. OFF 表外 no-op → transitionPhase 被补记（updateMany 被调，补记条目 decisionPoint='transitionPhase'）
2. ON 表内 → 抑制保持（updateMany 未被调，现有测试覆盖）
3. append 失败兜底（decisionRecorded=false → 补记，现有测试覆盖）

### A1 罐头恒代码任务压缩任务差异

**代码事实**：`experiments/p5/run.test.ts:24-26` 的 `cannedTasksJson` 固定 `declared_files:['src/index.ts']` → 3 档任务全走"1代码任务+1verify"同路径。task C（改 .env.example 端口）实际不该有代码任务，但被硬塞 → 决策序列差异被抹平。

**修法**：罐头按 task 三档（`vi.hoisted` 内建 map，按 taskId 取）：

| task | 任务 JSON（description + declared_files） |
|------|------|
| A（加法函数） | `实现 add(a,b) 函数，放在 src/utils/math.ts` + `['src/utils/math.ts']` |
| B（登录接口） | `实现登录接口，路由 /api/login，放在 src/api/login.ts` + `['src/api/login.ts']` |
| C（改配置） | `修改项目根目录 .env.example 的端口配置` + `[]` |

task C 的 description **须刻意避开代码后缀**（isCodeTask alignment.ts:15 同时查 description + declaredFiles），`declared_files:[]` + 非代码描述 → 不触发 verify 创建 → 符合「改配置」任务语义。

### A2 决策上下文固定 JSON 噪音

**代码事实**：PM/QA/delegate/self 的 mock 全返回同一 `cannedTasksJson` JSON blob → 落库进消息 → 进 `buildContextFromHistory` 喂真实决策 LLM → JSON 噪音。QA 的 JSON 更被 `alignment.ts:330`（`response.trim() !== '无问题'` 即提问）当提问 → 多耗一轮 QA→exec 决策。

**修法**：罐头消息语义化（按 agent 识别分流，复用 P5 已建立的 **systemPrompt/agent.name 安全网原则**——用硬编码模板或名字判定，不用 LLM 可污染的 prompt）：
- **decompose（架构师）** → 按 task 的任务 JSON（A1 三档）——decompose 必须有效 JSON（`alignment.ts:171` parseJSON 建任务）
- **PM（产品经理）** → 回一句需求复述（如「已确认需求：实现…」）——`handlePMConfirm` 不 JSON.parse PM 输出，`rawContent: result` 原样落库，语义句安全（用户已核实）
- **QA（测试工程师等 4 agents）** → 回 `'无问题'` → `alignment.ts:330` 判无提问 → 直发 exec（`:345`）
- **delegate/self** → 回语义句（非 JSON blob）

### A3 off-C-s4 缺失 + testTimeout 太紧

**代码事实**：P5 部分 run 真实耗时 245-589s，`testTimeout` 360s 标 fail（harness 伪影）；off-C-s4 超时无数据。

**修法**：
1. `experiments/p5/config.ts` testTimeout → `30*60*1000`
2. **A0+A1 修完后**，先用真实 LLM 补跑 off-C-s4 单格**验证修复有效性**（trace 里应出现 execute 边、pass 判定变化）——这一步是修复的闭环验证，不是重跑基线
3. 完整 off-C 格（5 seed）由 2×2 矩阵的 off+verify 格覆盖（见 §4），无需单独重跑

### A4 GLM_MODEL upsert 对已存在 agent 无效

**代码事实（用户实锤 + subagent 行号核实）**：`experiments/p5/setup.ts:45-49` `ensureExperimentAgents` upsert（`update:{}` 在 :47）空子句 → 二次运行保留旧 model/baseUrl，换 provider 静默失效。

**修法**：upsert `update` 也写 model/baseUrl/apiKey（与 create 同构）。**配合模型钉死**：`CONFIG.model` 默认改 `deepseek-v4-flash`（§5），A4 修好后默认即生效。

**真回归守卫**：`experiments/p5/setup.test.ts`（或并入现有单测）——预置已存在 agent 用旧 model，跑 `ensureExperimentAgents` 后断言 model/baseUrl/apiKey 被刷新。

### A5 report pass 数组按插入序非 seed 序

**代码事实**：`experiments/p5/report.ts` `generateReport` 用 metrics 插入序 map pass，run 完成顺序不同则数组顺序漂移。

**修法**：`metrics.filter(...).sort((a,b) => a.seed - b.seed).map(m => m.pass)`。

**真回归守卫**：构造乱序 metrics（插入序 ≠ seed 序），断言输出 pass 数组按 seed 升序。

## 4. 任务 B：2×2 全矩阵（状态机 × verify）

### 4.1 配置定义

| 配置 | `EXPERIMENT_STATE_MACHINE` | `EXPERIMENT_VERIFY` | 语义 |
|------|------|------|------|
| **ON+verify** | on（未设） | on（未设） | 生产默认路径（= P5 的 ON） |
| **ON+no-verify** | on | `off` | 状态机强制但无自动 verify |
| **OFF+verify** | `off` | on（未设） | 自由推进但有自动 verify（= P5 的 OFF） |
| **OFF+no-verify** | `off` | `off` | 完全自由 |

### 4.2 verify 开关实现（最小侵入）

**`src/lib/services/alignment.ts:231-251`**：`EXPERIMENT_VERIFY=off` 包住 verify 创建块：

```ts
const codeTasks = scheduledTasks.filter(t => isCodeTask(t) && !t.id.startsWith('verify-'))
if (codeTasks.length > 0 && process.env.EXPERIMENT_VERIFY !== 'off') {   // P6: verify 维度实验开关
  ...原 verify 创建块...
}
```

**正交性验证（用户核实）**：
- ON+no-verify：不创建 verify → done 守卫（chat-router.ts:127 `findFirst({ id: { startsWith: 'verify-' } })`）查不到 → 放行 ✓
- ON+verify：创建 + done 守卫要求 completed ✓
- OFF 下 done 守卫整体跳过 → **verify 维度在 OFF 近乎惰性 → 交互项 =「verify 只在状态机强制时才产生价值」，正是 A 方向论点的干净析因**

### 4.3 任务集的 verify 维度定位（报告口径）

| 任务 | 罐头差异化后 | verify 维度意义 |
|------|------|------|
| A（加法函数） | 代码任务 + verify | **verify 主效应主要贡献者** |
| B（登录接口） | 代码任务 + verify | **verify 主效应主要贡献者**；QA 维度是 mock 口径（见 §7） |
| C（改配置） | 非代码任务，**不触发 verify** | **verify 不作用**——C 格测「捷径任务在各组合下是否稳定」 |

### 4.4 统计方法

- **每格 5 seed**（4 配置 × 3 任务 × 5 = 60 run），同 seed 跨配置配对 → McNemar
- **bootstrap CI**（每格 pass 率，2000 次重采样）
- **2×2 析因**：状态机主效应、verify 主效应、交互项（状态机×verify）
- **seed noise**：每格内 seed 间方差（ClawBench 47% 警示，P5 已量化 B 格 0、A/C 格 0.16-0.25）
- **方向性差异当传闻看**（pilot 规模）；管道有效性 + seed noise 是成功标准

### 4.5 执行流程（分批可续跑）

1. 12 批（4 配置×3 任务），每批 5 run，`runOne` 落盘 p5.db + metrics JSONL
2. 每批后检查限流（provider ~20 run 后可能限流）；限流则停，恢复后续跑
3. 批次可中断续跑（p5.db 是恢复点，与 P5 同）
4. **跑冒烟/重跑前先备份 metrics.jsonl**（P5 踩坑：`run.test.ts` beforeAll rmSync 会清）

## 5. 模型钉死（spec/README/报告三处统一）

| 位置 | 现值 | 改值 |
|------|------|------|
| `experiments/p5/config.ts` | `model: process.env.GLM_MODEL \|\| 'glm-4.7-flash'` | `model: process.env.GLM_MODEL \|\| 'deepseek-v4-flash'` |
| `experiments/p5/report.ts` | 头部打印罐头消息 | **加 model/baseUrl 打印**（实际生效的，三处以「实际生效」为准） |
| `docs/superpowers/specs/2026-08-13-p5-controlled-experiment-design.md` §2 | 模型行写 glm | 更新为实际 deepseek-v4-flash（历史事实修正） |
| `README.md`（如 P5 实验提及） | 写 glm | 更新 |

- key 从 env `GLM_API_KEY` 读，永不硬编码、永不打印
- A4 修好后，`CONFIG.model` 默认 deepseek-v4-flash 即生效，无需 GLM_MODEL env（除非覆盖）

## 6. 不变量（新增 1 条，其余沿用）

1. runDiscussion 不注入 MCP，但必须显式传 chatSessionId + agentId
2. handleExecution 不重跑已完成任务（P0：preloadedIds 跳过）
3. phase/phaseStep 写入必须经 transitionPhase，禁止散点 prisma.session.update({phase})
4. idle→execute 跳步必须过 idleExecuteGate，exec→done 必须有 verify 任务 completed
5. redo 路由必须经状态机闸门（align_pm/未知态 fail-closed）
6. 每轮 LLM 决策必须写 Session.decisionTrace（先落库再派发 handler），append 走 appendDecisionTrace 乐观锁
7. **每个实际 phase 写入都入 decisionTrace，且不双记**（P6 A0 回归此不变量）
8. decisionTrace 是内部 analytics，不回客户端
9. **`EXPERIMENT_STATE_MACHINE=off` 只用于实验 harness，生产默认保持未设**
10. **`EXPERIMENT_VERIFY=off` 只用于实验 harness，生产默认保持未设**（新增）

## 7. 报告口径（防误读）

- **task B 的 QA 维度是 mock 口径**：A2 只把 QA 回复从 JSON 改成 '无问题'，没恢复真实 QA。task B 测的是「orchestrator 会不会主动提 align_qa」，**不是**「会不会问出好问题并解决」。报告必须写明，别让 task B 结论读成 QA 能力。
- **task C 的 verify 不作用**：报告需区分 verify 可作用任务（A/B）与不作用任务（C）。
- **OFF 失效机制**（P5 已定位）：LLM 走捷径缺规范 execute→exec 决策边；A0 修复后 trace 会补记真实推进，失效模式分类更准确。

## 8. 测试策略

- 生产改动仅 2 处（trace 修法 chat-router + verify 开关 alignment），**每次修改必须新增针对性测试**（A0 守卫 3 条、verify 开关守卫）：
  - `tests/chat-router.test.ts`：A0 守卫（OFF no-op 补记 / ON 抑制保持 / append 失败兜底）
  - `tests/alignment.test.ts`：`EXPERIMENT_VERIFY=off` 不创建 verify 任务；未设则创建
- harness 单测：A1（三档罐头）、A2（QA '无问题' 分流）、A4（upsert update）、A5（seed 排序）
- 全量 `npx vitest run` 基线：生产 1050 passed / 3 skipped（A0/A1 可能 +N）
- `npx vitest run --config experiments/p5/vitest.config.ts`：harness 单测（60-run 需真实 GLM key）

## 9. 不做（明确排除）

- **真实 QA**：不恢复真实 QA 调用（task B 的 QA 维度维持 mock 口径，报告写明限制）
- **第 3 个维度**（prompt posture / turn budget）：本次 2×2 只测 verify；posture/turn budget 留 P7
- **LLM judge 替代确定性 oracle**：延续 P5，oracle 是权威
- **拆 trace 独立表**：沿用封顶 N=500
- **生产默认行为改动**：verify 开关未设=现行为，trace 修法 ON 路径行为不变（decisionApplied 恒 true）

## 10. 涉及文件汇总

| 文件 | 改动 |
|------|------|
| `src/lib/services/chat-router.ts` | A0：5 处抑制点改 `!(decisionRecorded && decisionApplied)` + `decisionApplied` 定义 |
| `src/lib/services/alignment.ts` | verify 开关包 `:232` 创建块 |
| `experiments/p5/run.test.ts` | A1：罐头按 task 三档；A2：PM/QA/delegate/self 语义化 |
| `experiments/p5/setup.ts` | A4：upsert update 写 model/baseUrl/apiKey |
| `experiments/p5/config.ts` | A3：testTimeout 30min；§5：model 默认 deepseek-v4-flash |
| `experiments/p5/report.ts` | A5：pass 按 seed 排序；§5：头部打印 model/baseUrl；4 配置分组 |
| `experiments/p5/run-one.ts` | verify 开关透传（如 run 需带配置标记） |
| `tests/chat-router.test.ts` | A0 守卫 3 条 |
| `tests/alignment.test.ts` | verify 开关守卫 |
| P5 spec §2 模型行 / README | §5 模型统一 |
| `docs/superpowers/specs/2026-08-15-p6-full-matrix-design.md` | 本 spec |
