# Playwright E2E 协作流程 4 项问题

> 创建时间: 2026-07-19 | 最后更新: 2026-07-27
> 状态: 🟡部分已解决（3/4 已修复，1/4 需要执行层修改）
> 测试报告: docs/qa-reports/2026-07-19-playwright-e2e-collaboration.md

## 问题概览

| ISSUE | 问题 | 严重度 | 根因层级 | 状态 |
|-------|------|--------|----------|------|
| 006 | 依赖安装循环 | 🟡 中 | 权限机制 | ✅ 已修复 |
| 007 | 进程超时阈值过短 | 🔴 高 | 超时配置 | ✅ 已修复并验证 |
| 008 | 无自动测试触发 | 🟢 低 | 流程缺失 | ⚠️ 需要执行层修改 |
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

## ISSUE-008：任务完成后无自动测试触发 [需要执行层修改]

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
- `src/lib/services/execution.ts:479-493` — 执行循环结束逻辑
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
