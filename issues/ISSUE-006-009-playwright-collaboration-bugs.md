# Playwright E2E 协作流程 4 项问题

> 创建时间: 2026-07-19 | 最后更新: 2026-08-06
> 状态: 🟢已解决（4/4，ISSUE-008 执行层强制 verify 于 2026-08-06 修复）
> 测试报告: docs/qa-reports/2026-07-19-playwright-e2e-collaboration.md

## 问题概览

| ISSUE | 问题 | 严重度 | 根因层级 | 状态 |
|-------|------|--------|----------|------|
| 006 | 依赖安装循环 | 🟡 中 | 权限机制 | ✅ 已修复 |
| 007 | 进程超时阈值过短 | 🔴 高 | 超时配置 | ✅ 已修复并验证 |
| 008 | 无自动测试触发 | 🟢 低 | 流程缺失 | ✅ 已修复并验证（2026-08-06 执行层强制 verify） |
| 009 | Agent 角色匹配偏差 | 🟢 低 | Prompt 设计 | ✅ 已修复并验证 |

---

## ISSUE-006：依赖安装循环 [已修复]

**现象**：Agent 反复尝试 `pip install pygame`（3次），每次都需要用户批准，导致任务耗时大幅增加。

**根因**：`process-registry.ts:705` — permissionMode 为 `'default'` 时，每次 CLI 发起 `control_request`（`can_use_tool` 子类型），系统都将请求转为 `permission_request` 推送给前端，等待用户手动批准。系统没有"已批准过相同操作则自动放行"的缓存机制。

**修复方案**（2026-07-27 已实现）：
- 在 `ProcessEntry` 接口中增加 `permissionCache?: Map<string, boolean>` 字段
- 在 `respondPermission` 函数中写入权限缓存（allow 和 deny 都缓存，上限 100 条）
- 在控制请求处理中增加缓存检查：`const permKey = ${request.tool_name}:${JSON.stringify(request.input)}`

**相关代码**：
- `src/lib/adapter/process-registry.ts:700-748` — 权限请求处理逻辑（已增加缓存检查）
- `src/lib/adapter/process-registry.ts:1064-1091` — respondPermission（已增加缓存写入）

**单测覆盖**（2026-08-05 补充）：`tests/permission-cache.test.ts` 8 项（写缓存 allow/deny、100 条淘汰、缓存命中自动批准/拒绝、不同 input 重新审批、updatedInput 修改后批准不缓存防审批反转）。默认模式 E2E 待补。

**2026-08-05 审查加固**（pre-commit-audit 发现）：
- updatedInput 审批反转：用户修改 input 后批准时，缓存原记录原始 input 会导致下次原始请求自动放行绕过修改 → 已修复：input 被修改时跳过缓存写入
- 已知局限（暂不修）：deny 缓存命中时静默自动拒绝，前端无可见记录；用户改主意需重启进程/切 permissionMode 才能解锁。fail-closed 方向无安全问题，加可见痕迹属功能增强

---

## ISSUE-007：进程超时阈值过短 [已修复并验证]

**现象**：后端工程师在重写 tkinter 版本时，60 秒无数据输出被判定为 stalled，进程被杀，任务进度全部丢失。

**根因**：`process-registry.ts:73` 定义 `NO_DATA_TIMEOUT_MS = 60 * 1000`。Claude Code CLI 在执行复杂任务时，LLM 内部推理（thinking）阶段、大文件读写操作期间不产生 stdout 输出，60 秒对复杂代码生成过于激进。

**修复方案**（2026-07-27 已实现）：
```typescript
// 修改前
const NO_DATA_TIMEOUT_MS = 60 * 1000 // 60 seconds

// 修改后
const NO_DATA_TIMEOUT_MS = 3 * 60 * 1000 // 3 minutes — LLM thinking 阶段无 stdout，外层 15min 兜底
```

**验证结果**（2026-07-27 Playwright E2E）：
- 复杂任务（Python 贪吃蛇游戏，235 行 tkinter 版本）在 ~60s 内完成
- 未触发超时错误
- 任务成功完成，语法检查通过

**相关代码**：
- `src/lib/adapter/process-registry.ts:73` — 常量定义（已修改）

---

## ISSUE-008：任务完成后无自动测试触发 [已解决 ✅ 2026-08-06]

**现象**：复杂任务（贪吃蛇游戏）完成后，系统没有自动触发测试工程师验证产出物。用户看到"完成"但没有验证。

**根因**：
1. `execution.ts:479-493` — 执行引擎"任务全部完成即结束"，无测试阶段
2. `prompts.ts:42-94` — Orchestrator 的 8 种 action 中无 `test/verify` 动作
3. `index.ts:35` — AGENT_BEHAVIOR_RULES 中"代码修改后运行测试"仅为 LLM 软提示

**已尝试的修复**（2026-07-27）：
- 在 ORCHESTRATOR_DECISION_PROMPT 中增加 `verify` action
- 增加规则说明：⚠️ verify 使用规则（必须遵守）
- 增加示例：单 Agent 场景下 Orchestrator 自己验证
- 增加编排原则：代码类任务完成后 → verify（必须！）

**修复效果**：prompt 优化后仍未触发 verify action。LLM 倾向于选择 done而非 verify。

**根本原因**：仅靠 prompt 引导不足以改变 LLM 决策。需要在执行引擎层面强制触发 verify。

**2026-08-05 补充修复（路由缺口）**：pre-commit-audit 发现即使 LLM 返回 verify，chat-router.ts 的 switch 也无 case 处理 → 静默 no-op，无 done 事件，会话卡死。已在 switch 补 `case 'verify'`：有 target 委派验证，无 target Orchestrator 自验证（tests/chat-router.test.ts 2 项针对性测试）。执行层强制触发仍是待办。

**✅ 已实现（2026-08-06，执行层强制 verify + pre-commit 三视角审查整改）**：
- **落点**：`handleArchitectPlan`（alignment.ts）任务创建循环后——`prisma.task.create` 全仓唯一入口，所有基于任务的工作流都经此建任务。拆解出代码任务时自动追加 verify 任务，经既有依赖就绪门控在代码完成后自动执行（verify 创建本身执行引擎零改动）。
- **识别代码任务**：`isCodeTask()` — declaredFiles 含代码后缀（审查整改后含 ts/tsx/js/jsx/py/java/go/rs/c/cpp/h/cs/php/sh/html/css/scss/less/vue/svelte/sql/kt/swift/lua/pl/dart/scala 等 30+ 种），或任务描述以代码后缀结尾（如"产出 snake_game.py"）。纯文档/讨论任务不触发。
- **verify 任务形态**：id `verify-<uuid>`（前缀用于识别，避免多轮对齐重复创建）；dependencies = 全部代码任务 id（任一失败 → verify blocked，不验证半成品）；declaredFiles = `[]`（不产生文件，跳过越界校验，F3 无串报）；assignedAgentId = 测试工程师（session 内）?? null。代码任务结果经 `<dependency>` 块注入 verify 上下文。
- **覆盖入口**：正常对齐流（align_decompose→handleArchitectPlan）、跳过对齐流（transitionToExecution 空任务兜底→handleArchitectPlan）、redo 流（不新建 verify；链式依赖下 blocked verify 由 execution.ts 新增的"blocked 依赖补齐自动复活"机制在 redo 后重新执行）。
- **测试**：tests/alignment.test.ts 新增 9 项（代码任务→创建 verify / 无代码任务→不创建 / 已存在→不重复 / 无测试工程师→null / isCodeTask 4 项含新后缀 / buildVerifyDescription），tests/execution-edge-cases.test.ts 新增 2 项（blocked 复活 + 不过度复活），tests/architect-output-schema.test.ts 适配（过滤 verify- 前缀 create 断言）。**926→937 测试全绿，src/ tsc 零错误，真回归守卫实测旧代码下红 7 项**。

**🔍 pre-commit 三视角审查整改（2026-08-06）**：
3 个并行 subagent（攻击者/生命周期/声明vs实现）审查，共确认：
- **❌ 修复：redo 链式依赖级联失效**（生命周期+声明vs实现独立发现）。代码任务 A→C 有依赖，verify deps=[A,B,C]：A 失败 → C/verify blocked；redo A 时 redo route 用**一次性快照**解锁下游，快照里 C 仍 blocked → verify otherDepsOk 不满足被漏解锁，永久滞留 blocked 而 phase 照常进 done（**复现"完成但未验证"**）。**修复**：execution.ts while 循环顶部加"blocked 任务依赖全部 completed → 复活 pending"，通用修复所有同类滞留（不复活依赖仍 failed 的任务）。2 项针对性测试，真回归守卫旧代码下红。
- **❌ 修复：isCodeTask 覆盖不足**。declaredFiles 缺 .html/.vue/.sql 等后缀 → 静态页/建表任务静默不验证；description 分支因 `$` 锚仅命中"以代码后缀结尾"的描述（真实描述极少如此，是设计取舍——避免"说明 .ts 文件格式"类误判）。**修复**：后缀清单扩到 30+ 种。
- **✅ 通过**：verify 主生命周期（pending→in_progress→completed + failed-dep→blocked 不可抢跑）、提前 return 位置安全（无漏建/误建）、依赖注入无注入面（id 均为 UUID）、verify- 前缀不可预植、零硬编码密钥。

**⚠️ 已知限制 + 残留（v1 接受）**：
- **多轮对齐**（同一 session 再次 align_decompose 追加任务）：`existingVerify` guard 只做去重、不把新代码任务并入既有 verify.deps → 第二轮新增代码任务不被验证。健壮修复需区分"新代码任务 vs 重拆的重复任务"（UUID 每次重建，无稳定对应关系），留待后续。
- **monitoring 语义错配**：monitoring 按"生产任务"判定 verify 的只读报告——若 verify 如实报告"产出有问题"，monitoring 可能误判为"verify 没做好"触发纠偏重跑 verify（空转，不修底层问题）。既有的 correctionCount 上限(2次)保证不会无限重试，但上限依赖"成功路径不清内存 correctionCount"的巧合，是埋着的回归地雷。
- **findBestAgent 对 null-agent verify 可能误派**：无测试工程师时 assignedAgentId=null → findBestAgent 先匹配前端/后端关键词（verify description 内嵌代码任务描述，含"页面/接口"等词会先命中），再轮询兜底。verify 仍会执行（description 显式"只检查不修改"），但可能派给职责是写代码的 agent，验证质量不可控。
- **buildMonitoringPrompt 插值不过 escapeContractTags**（既有注入 sink，非本次引入，本次 verify 聚合 description 放大了注入面）；**escapeContractTags 挡不住带属性的闭合标签**（如 `</authoritative_input x>`，正则只允许标签名后空白+`>`）。均属既有安全防御弱点，公开部署前需修。
- verify 任务未进 `formatArchitectPlan` 方案展示，用户仅靠一条 sendEvent 文本得知其存在（透明度取舍）。

**建议的执行层修改**：
```typescript
// 在 execution.ts 中，任务完成后检查是否有代码类任务
const codeTasks = tasks.filter(t => 
  t.status === 'completed' && 
  /\.(py|js|ts|java|go|rs)$/.test(t.description || '')
)

if (codeTasks.length > 0 && !session.verified) {
  // 强制创建 verify 任务
  tasks.push({
    id: `verify-${Date.now()}`,
    description: `验证代码任务产出物`,
    assignedAgent: agents.find(a => a.name.includes('测试'))?.name || 'Orchestrator',
    status: 'pending'
  })
  session.verified = true
  continue  // 继续执行循环
}
```

**相关代码**：
- `src/lib/services/alignment.ts` — handleArchitectPlan 自动追加 verify 任务 + isCodeTask/buildVerifyDescription（实现点）
- `src/lib/services/execution.ts:479-493` — 执行循环结束逻辑（verify 作为普通任务流经，无需改动）
- `src/lib/orchestrator/prompts.ts:42-94` — Orchestrator 决策 prompt（已增加 verify）

---

## ISSUE-009：Agent 角色匹配偏差 [已修复并验证]

**现象**：简单文件创建任务（"在当前目录创建 hello.txt"）分配给"前端工程师"，而非更通用的角色。

**根因**：`prompts.ts:86` 的示例将"简单修改"锚定到"前端工程师"，暗示简单任务应该分配给前端工程师。

**修复方案**（2026-07-27 已实现）：
1. 在 ORCHESTRATOR_DECISION_PROMPT 中增加 self 示例：
   ```
   用户: "在当前目录创建 hello.txt"
   → {"action":"self","target":null,"targets":null,"message":"好的，我来创建","reason":"简单文件操作，Orchestrator自己执行"}
   ```

2. 在 TASK_DECOMPOSITION_PROMPT 中增加角色匹配规则：
   ```
   - assignedAgent 必须与任务内容匹配：
     - 前端/UI/CSS/组件/页面/按钮/样式 → 前端工程师
     - 后端/API/数据库/脚本/Python/接口 → 后端工程师
     - 架构/设计/方案 → 架构师
     - 测试/验证/test → 测试工程师
     - 产品/需求/PRD → 产品经理
     - 简单文件操作（创建/删除/重命名） → Orchestrator 自己执行（self action）
   ```

3. 在 index.ts 中增加 findBestAgent 函数，改进 fallback 逻辑

**验证结果**（2026-07-27 Playwright E2E）：
- 简单任务（创建 hello.txt）：Orchestrator 选择 `self` action 自己执行 ✅
- Orchestrator 思考过程："这个任务已经在上一轮完成了"（正确识别为简单任务）

**相关代码**：
- `src/lib/orchestrator/prompts.ts:85-92` — 决策 prompt 示例（已增加 self 示例）
- `src/lib/orchestrator/prompts.ts:132-140` — 任务拆解 prompt（已增加角色匹配规则）
- `src/lib/orchestrator/index.ts:93-105` — findBestAgent 函数（新增）

---

## 修改文件汇总

| 文件 | 修改内容 |
|------|----------|
| `src/lib/adapter/process-registry.ts:73` | 超时常量 60s → 3min |
| `src/lib/adapter/process-registry.ts:8-36` | ProcessEntry 增加 permissionCache 字段 |
| `src/lib/adapter/process-registry.ts:700-730` | 权限缓存检查逻辑 |
| `src/lib/adapter/process-registry.ts:1064-1091` | respondPermission 增加缓存写入 |
| `src/lib/orchestrator/prompts.ts:42-103` | 增加 verify action + 角色匹配规则 |
| `src/lib/orchestrator/prompts.ts:132-140` | 任务拆解增加角色匹配规则 |
| `src/lib/orchestrator/index.ts:86` | OrchestratorDecision 类型增加 verify |
| `src/lib/orchestrator/index.ts:93-105` | 新增 findBestAgent 函数 |
