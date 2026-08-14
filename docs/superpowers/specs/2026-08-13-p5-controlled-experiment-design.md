# P5（=C）受控实验设计：状态机 vs LLM 自由推进

> 日期：2026-08-13 | 状态：已批准（用户逐条审阅 + pre-commit 三视角审查整改后定稿）
> 项目：AgentHub A方向（显式状态机） | 规划文档 §9.2（OpenBench + ClawBench 范式）

## 1. 目标

验证核心假设——**状态机（代码管骨架）比 LLM 自由推进更可靠**，用 `pass^k` + conformance + 失效模式分布度量。

pilot（本 spec）的目的：
1. 跑通观测管道（decisionTrace + conformance 复用 P3/P4 已有资产）
2. 量化 seed noise（ClawBench 47% 警示）
3. 初步看方向性差异——**当传闻看，不当结论**

## 2. 已拍板决策（用户确认）

| 决策 | 选择 |
|------|------|
| 执行规模 | pilot 先行，**5 次/格** → 3任务×2配置×5次 = **30 次运行** |
| 任务集 | 自建 oracle 小任务，3 档歧义度 |
| 配置矩阵 | 最小对比：状态机 on vs off（不加第 3 维度） |
| 自由推进定义 | **完整绕过**（真自由）：决策层校验全跳 + transitionPhase fail-closed 跳 |
| 执行层保真 | **决策真实 + 执行 mock**（vi.mock 注入，见 §5.2） |
| 开关形式 | env 全局开关 `EXPERIMENT_STATE_MACHINE=off`，默认 on，生产零影响 |
| 模型 | 智谱 glm-4.7-flash（本地诊断惯例 + 便宜）；报告固化 model+config 供复现 |

## 3. 实验定义

### 3.1 自变量：状态机 on / off
- **ON**（现状）：决策点 `canonicalCorrect` + 业务守卫（execute 闸门/done 守卫）+ `applyTransition` 转移校验 + `transitionPhase` fail-closed 全生效
- **OFF**（`EXPERIMENT_STATE_MACHINE=off`）：**只关决策层 enforcement，不关 trace 记录**（见 §5.1）
  - 跳过 canonicalCorrect（Hybrid 纠正）
  - 跳过业务守卫（execute 闸门/done 守卫）
  - 决策点 applyTransition 放行（表内→表值 / 表外→保持当前 state，**但仍记录 trace**）
  - transitionPhase fail-closed 校验跳过（写库照常）
  - **handler 内既有兜底仍在**（transitionToExecution 0-task 补拆、handleArchitectPlan 拆解）——这是设计意图不是缺陷，测的就是"决策层约束的价值"（见 §8.1）

### 3.2 任务集（3 档歧义度）
| 任务 | 类型 | 测什么 |
|------|------|--------|
| A | 极度清晰，规范路径唯一 | 基线，on/off 都应走通 |
| B | 需 QA 澄清（信息不全） | LLM 会不会问 vs 瞎跳 |
| C | 易走捷径（如"改个配置"） | LLM 会不会跳过对齐直接 execute |

每个任务：用户消息 + 确定性 oracle（pass 判定，见 §4）。

### 3.3 运行矩阵
3 任务 × 2 配置 × 5 次 = **30 次运行**。每次独立 session、独立 projectDir、独立 run 判定落盘。

**seed 配对（审查整改）**：5 个固定 seed × 3 任务；ON/OFF **同 seed 各跑一次** → McNemar 用 15 对。seed 影响 LLM 采样温度/随机参数（若 glm 支持），或至少保证任务与配置的种子化顺序稳定。

## 4. 判定指标（oracle）

### 4.1 pass（收敛型，审查后收紧 + 修正 OFF 冲突）
```
pass ⇔ 全部成立：
  ① 终点 state = done（DB 判定，非 SSE 事件）
  ② applied 边真实包含规范序列（审查澄清：判据钉死，不设"等效"歧义）：
     存在一条 applied actualTransition 满足 action==='align_decompose' && to==='align_arch'
     ∧ 存在一条 applied actualTransition 满足 action==='execute' && to==='exec'
     ∧ 存在最终 exec→done（action==='done' && from==='exec' && to==='done'）
     （从 decisionTrace 的 applied actualTransition 里查）
  ③ 【仅 ON 模式评估】零 illegal_transition + 零 escalate_but_legal
     （这两个是代码漂移，非 LLM 的锅；OFF 不评估——OFF 的表外 no-op 是预期实验条件）
```
- **escalate 不罚，单独计**——它是 ON 模式拦住 LLM 的功劳
- **OFF 一步 idle→done 会被条件 ② 拦下**（没走过拆解/执行）→ 不算 pass
- **OFF 的表外提议**不计入 ③（③ 仅 ON）；OFF 的非法尝试率用独立口径（§4.3），不与 pass 纠缠

### 4.2 失效模式分类（每 run 归一类，互斥）
| 模式 | 判定 |
|------|------|
| `pass` | §4.1 成立 |
| `escalate-exhausted` | escalate 超 N 次（N=3，罐头消息见 §6） |
| `stuck` | 轮数 >30 或 **no-progress 检测**（连续 5 轮 phase 无变化）——不用纯 wall-clock（审查整改：ON 多 5-8 次真实调用，纯时长对 ON 不公平） |
| `error` | LLM 超时/异常/决策降级（非卡死） |
| `no-pass` | 终点非 done 且非以上（决策不收敛） |

### 4.3 指标主次（审查校准口径）
- **头号对比**：OFF 非法尝试率 vs ON（ON 用 escalateCount + correctionCount 表达，OFF 用 **llmProposal.action vs 转移表** 独立比对——旁路 action self/delegate/discuss/verify 不算非法，复刻 lookupTransition + NON_TRANSITIONING，见 §5.3）
- **第二**：ON 的 correctionCount（代码救 LLM 几次）
- escalate 不对比（OFF 恒 0 是必然，无信息量）
- 辅助：conformance violations 四类（仅 ON 有意义）、决策轮数、latency（mock 层计时，作协变量不混入失效模式）

### 4.4 统计
- 每格报 pass 数组（0/5、2/5…）+ pass 率 + bootstrap CI（≥1000 resample）
- 两配置 **同 seed 配对 McNemar**（15 对，功效有限，只当参考）
- seed noise = 同格内 5 次的 pass 方差
- **报告逐格贴 pass 数组，不报均值**
- 每 run 判定完成后**立即落盘**（runId + on/off + task + pass + failureMode + 各计数），崩溃不丢前 N-1 个 run（审查整改）

## 5. 实现设计

### 5.1 开关注入（生产改动，需实现 + 回归守卫）
**两个调用点**（审查整改——非"唯一注入点"，因为决策点直接调纯函数）：

**`state-machine.ts`** 导出 override 版，纯函数保持不动（测试依赖）：
```ts
export function applyTransition(state: State, action: string): ... // 原逻辑不变
// bypass 返回带 inTable 标志（审查必改 2）：表外/表内自环都 nextState===state，
// 无法靠 nextState 反推是否表内——决策点需据此区分 trace 的 applied。
export function applyTransitionWithOverride(
  state: State, action: string, bypass: boolean
): { ok: true; nextState: State; inTable: boolean } | { ok: false; reason: string } {
  if (bypass) {
    const row = TRANSITIONS[state]
    if (row && Object.hasOwn(row, action)) return { ok: true, nextState: row[action], inTable: true }
    // 旁路 action（NON_TRANSITIONING）也是 inTable 语义（任意状态合法，不记非法）
    if (NON_TRANSITIONING.has(action as Action)) return { ok: true, nextState: state, inTable: true }
    return { ok: true, nextState: state, inTable: false }   // 表外 action：保持当前 state，无幻 phase
  }
  return applyTransition(state, action)  // 非 bypass：保持原语义（不含 inTable，调用方按非实验路径处理）
}
export function isExperimentOff(): boolean { return process.env.EXPERIMENT_STATE_MACHINE === 'off' }
```
- `transitionPhase` 内部改调 `applyTransitionWithOverride(state, action, isExperimentOff())`
- **`chat-router.ts:140` 决策点改调 `applyTransitionWithOverride`**（这是关键——不改这行 OFF 闸门没关）。**无需显式跳过 escalate return**：bypass 下 override 恒 `ok:true`，`:160 if(!transition.ok)` 天然不触发。**但 141-158 的 trace 块照常走**：llmProposal 保留原提议、validation 打 `validator:'experiment-off'` 标记、`actualTransition` 据 `inTable` 区分——`inTable:true` → `applied:true, escalated:false`；`inTable:false` → `applied:false, escalated:false`（表外 no-op 是预期实验条件，不判非法）
- `chat-router` 决策点 OFF 时跳过 canonicalCorrect + 业务守卫（execute 闸门/done 守卫）
- **副作用（已确认）**：redo/route.ts:53 调纯 `applyTransition`——OFF **不**影响 redo 闸门（harness 不触发 redo，无影响；但 spec 明示避免误解）

### 5.2 mock 注入（vi.mock，审查后修正形状 + 扩 monitoring）
**已核实链路**：
- 决策 `getOrchestratorDecision`（index.ts:269）→ `executeSingleAgent` → 真实 LLM（**保留**）
- 任务执行 `executeTaskBatch`（index.ts:406）→ 内部自建 adapter，不走 executeSingleAgent
- executeTaskBatch 仅经 barrel 导入（execution.ts:4），返回形状 `{ results, preloadedIds, failedTaskIds, failedTaskReasons }`（index.ts:347）

```ts
vi.mock('@/lib/orchestrator', async (importOriginal) => {
  const mod = await importOriginal()
  return { ...mod, executeTaskBatch: vi.fn(mockExecuteTaskBatch) }
})
// mockExecuteTaskBatch(tasks, ...):
//   results = new Map(tasks.map(t => [t.id, { result: 'SUCCESS', sessionId: undefined }]))  ← 对象形状
//   preloadedIds: [], failedTaskIds: [], failedTaskReasons: {}
```
**审查整改（mock 范围）**：
- **monitoring LLM 也 mock**：`handleExecution` 每任务真实 monitoring（execution.ts:434）未被 mock 会拖爆 run。在 harness 里 wrapper `executeSingleAgent`：systemPrompt 含 `'代码审查专家'`（监控专用）→ 返回 `{ result: '{"needsCorrection":false}' }`。
- mock 值必须 `{ result, sessionId }` 对象（`execution.ts:292` 解构），否则 `undefined.slice` 崩 → 30/30 error。

> **实现偏差（2026-08-14 冒烟后记录，deviation from spec）**：实际实现比 spec 更激进——`executeSingleAgent` 对**所有非决策调用**（PM/架构师/QA/delegate/self/decompose）返回固定任务 JSON，不只 mock monitoring + executeTaskBatch。原因：① 冒烟实测 delegate/discuss/self 走真实 CLI 编码会 hang（executeSingleAgent 真实路径），而 spec 原样"透传真实"会让 30-run 挂死；② provider（opencode.ai/zen/go + deepseek-v4-flash）慢，对齐 PM/QA 也 mock 以控时长。**决策识别**：`getOrchestratorDecision` 内部直调原 `executeSingleAgent`（模块内部绑定，mock 拦不到）→ 决策天然真实；另用 `agent.systemPrompt` 含 `'决定下一步该做什么'`（ORCHESTRATOR_DECISION_PROMPT 硬编码模板，LLM 不可污染）作安全网。**discuss 路径**（`runDiscussion` 走 adapter 直连不经 executeSingleAgent）单独 mock 防真实 CLI。**preflight** 固定 prompt `'只回复两个字：就绪'` 放行真实（保 provider 快速失败闸门）。**影响**：决策上下文含固定任务 JSON 噪音（PM/QA 落库为消息），ON/OFF 同侧可抵消；罐头恒代码任务压缩 task 间差异，pilot 灵敏度降低但方向信号仍显著（task B McNemar p≈0.025）。decompose 固定 JSON 恒可解析 → `decomposeTasks` fallback（走 callLLM）不触发。
- **禁 MCP**：`vi.mock('@/lib/mcp-config', () => ({ buildMCPConfig: () => undefined }))`——MCP 子进程硬编码 dev.db（mcp-config.ts:14），实验期禁掉避免数据分叉。
- harness 只用 `clearAllMocks()`，**不用 `resetAllMocks()`**（会清掉 mock impl 导致全任务 failed）。

### 5.3 非法尝试率口径（审查校准）
- 旁路 action（self/delegate/discuss/verify）任意状态合法，**不算非法尝试**
- `isLegalTransition`（decision-trace.ts:162）未导出 → harness 复刻 `lookupTransition` + `NON_TRANSITIONING`（NON_TRANSITIONING 已导出）
- OFF 口径：`llmProposal.action`（原提议）vs 转移表 + 旁路集 → 非法尝试率
- ON 口径：escalateCount + correctionCount（escalate 是"代码拦得好"的功劳）

### 5.4 目录结构（独立 harness，不进 src/）
```
experiments/p5/                  ← repo 根，不进 Next 构建图（src/ 不 import 它）
├── vitest.config.ts             ← 独立 config：继承 @→src 别名、testTimeout 小时级、test.env 设 DATABASE_URL
├── run.test.ts                  ← vitest 入口（30 次运行的 driver，含 vi.mock + setup）
├── setup.ts                     ← beforeAll：清 globalThis.prisma、migrate deploy p5.db、preflight 真实决策调用
├── tasks.ts                     ← 3 个 oracle 任务定义
├── mock-executor.ts             ← executeTaskBatch + monitoring mock
├── user-simulator.ts            ← 暂停点自动回复策略（§6）
├── metrics.ts                   ← pass/失效模式/非法尝试率/耗时采集（每 run 落盘 JSONL）
├── stats.ts                     ← bootstrap CI + 配对 McNemar + seed noise
├── report.ts                    ← 输出对比报告（逐格 pass 数组）
├── config.ts                    ← model/开关/上限参数
└── README.md
```
**运行方式**：`npx vitest run experiments/p5/run.test.ts`（独立 config，不污染默认 tests include）

## 6. 暂停点恢复策略（审查整改——从"仅 escalate"扩到全部暂停点）

全链路 5 个 `awaiting_user_input` 暂停点（ON 规范路径必经）：
| 类型 | 触发 | 固定回复（罐头消息，落库为 user 消息） |
|------|------|------|
| `escalate` | 非法转移被拦 | "请按流程继续"（上限 3 次，超限 → `escalate-exhausted`） |
| `pm_confirm` | handlePMConfirm 后 | "方案确认，继续" |
| `architect_plan` | handleArchitectPlan 后 | "拆解确认，继续" |
| `replan` | 0 任务补拆 | "请重新规划，继续" |
| `agent_qa` | handleAgentQA 后 | "已解答，继续" |

- **每条罐头消息必须 `prisma.message.create({ role:'user' })` 落库再进下一轮**——escalate 拒绝文本只走 SSE 不持久化（chat-router.ts:161），不落库则 LLM 历史看不到被拒，会重提同一非法 action
- 罐头消息固定（混淆变量必须固定），报告写明
- escalate 的 3 次上限只约束 escalate，不约束其他暂停点（那是正常流程不是失效）

## 7. 隔离与错误处理

### 7.1 独立 DB（审查整改——vi.stubEnv 无效）
prisma 是模块加载期单例（db.ts 读 env），`vi.stubEnv` 在测试体内无效。改为：
- **`experiments/p5/vitest.config.ts` 的 `test.env` 设 `DATABASE_URL=file:./p5.db`**——在 `@/lib/db` 首次求值前生效，全程 30 次 run 恒定
- `beforeAll`：`delete (globalThis as any).prisma`（防 worker 复用串库）+ `npx prisma migrate deploy`（空库无表，不部署则 30/30 error）。**注意 cwd**：`file:./p5.db` 是相对路径，按子进程 cwd 解析——migrate deploy 的 cwd 必须与 vitest `test.env` 的 `DATABASE_URL` 相对基准一致（建议都用绝对路径 `file:D:/ai全栈挑战赛/agenthub/experiments/p5/p5.db` 消除歧义），并确认 `prisma/schema.prisma` 路径可寻
- 独立 projectDir：每 run `mkdtempSync`（否则 shadow-git 在仓库根快照 + cleanupUndeclared 可能删 p5.db）

### 7.2 错误处理
- **终止条件 = DB `session.phase==='done'`**，非 SSE 'done' 事件（决策 LLM 出错时 chat-router 静默降级成自由聊天也发 done 事件，chat-router.ts:77——不能当完成）
- 每轮用"decisionTrace 追加数或 session.phase 是否变化"判进展
- LLM 超时/决策降级 → 该 run 标 `error`，计入失效模式，不静默丢弃
- no-progress 检测：连续 5 轮 phase 无变化 → `stuck`（不纯用 wall-clock）
- `afterEach(() => vi.unstubAllEnvs())`（stub 默认不还原，防 ON 用例被 OFF 污染）
- `afterAll`：`processRegistry.gracefulShutdown()/killAll()`（防存活 CLI 进程让 vitest 不退出）+ 看门狗超时后主动 kill 该 run 的 CLI 进程（防 promise 泄漏）
- **preflight**：跑 1 次真实决策调用验证 CLI + glm provider 配好，失败快速失败不烧 30 次

### 7.3 每 run 落盘
每 run 判定完成后立即写 JSONL（`runId + on/off + task + seed + pass + failureMode + 各计数 + decisionTrace 路径`），崩溃不丢前 N-1 个 run；report 支持从落盘数据重算。

## 8. 诚实性声明（防 reviewer 质疑）

### 8.1 OFF 不是纯 LLM 对照
OFF 只关**决策层**校验；handler 内既有兜底仍在（0-task 补拆、拆解）。含义：
- OFF 下 LLM 从 idle 直提 execute（表内合法）→ handler 补拆会补齐拆解边 → oracle ② 可能满足
- 所以"跳过对齐"的捷径在 OFF 下可能被 handler 兜底掩盖，任务 C 的区分度主要靠**非法尝试率**而非 pass 率
- 这是诚实框架（A 方向测决策层约束的价值），不是缺陷
- **审查补充**：OFF 下 LLM 从 idle 直提 execute 时，决策点记 `idle→exec` + 补拆记 `idle→align_arch`，trace **没有** align_arch→exec 边（transitionPhase 被 recordTrace:false 抑制）——依赖顺序/直接跟随的指标会失真，oracle ② 只看边存在性所以不受影响

### 8.2 mock 执行意味着产物不可判
pass 只看决策路径质量，不判产物正确性（mock 结果固定 SUCCESS + monitoring mock 恒 needsCorrection:false）。实验测的是**决策可靠性**，不是 agent 干活能力——后者需要全真实执行（成本，不做）。

## 9. 测试（真回归守卫）
- `applyTransitionWithOverride` 表外 action 保持当前 state（红绿验证）
- OFF 开关下 chat-router 决策点跳过 escalate return 但仍记 trace（红绿验证）
- ON 默认（无 env）→ 全量测试不破（**基线 1040 passed / 3 skipped，P4 末实测**，2026-08-13 复测确认；如新增 harness 单测需在 P5 提交内一并反映新总数）
- harness 纯函数单测：metrics/stats/oracle 判定（含 OFF 不评估 ③）
- **mock 返回形状喂给 handleExecution 不抛**（防 `undefined.slice` 类回归）
- 禁 MCP 生效、DATABASE_URL 指向 p5.db 且非 dev.db（断言）

## 10. 不做（明确排除）
- 不做 usage/token 埋点（cost 用调用次数估算，精确化留全矩阵）
- 不做 dev server/API 驱动（直接 import orchestrator，快且可控）
- 不引入真实 CLI 执行（成本）
- 不改 schema、不改生产默认行为（生产改动仅 §5.1 两处 + 决策点，默认 on 零影响）
- 不做全矩阵（pilot 后另写 spec）

## 11. 交付物
1. 30 次运行数据 + 对比报告（逐格 pass 数组、bootstrap CI、seed noise、非法尝试率、correctionCount）
2. `experiments/p5/` 可复现 harness（model+config 固化、JSONL 落盘可重算）
3. 结论：方向性差异当传闻；管道有效性 + seed noise 数 是 pilot 的成功标准

## 12. 生产改动清单（唯一）
| 文件 | 改动 | 默认行为 |
|------|------|----------|
| `state-machine.ts` | 导出 `applyTransitionWithOverride` + `isExperimentOff`；transitionPhase 内部改调 override | on，零影响 |
| `chat-router.ts` | 决策点 :140 改调 override；OFF 时跳过 canonicalCorrect/业务守卫/escalate return（trace 照记） | on，零影响 |
