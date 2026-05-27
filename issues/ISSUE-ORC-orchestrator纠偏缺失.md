# Orchestrator 纠错行为缺失问题
> 创建时间: 2026-05-23 | 状态: 🔴未解决

## 问题描述

设计文档（第 311-316 行）定义了 Orchestrator 的群聊角色：
- **主持人**: 控制阶段切换（对齐 → 执行）
- **监督者**: 沉默观察，站在上帝视角看整体方向
- **纠偏者**: 发现跑偏时 @Agent 纠正

但实际实现中存在多处缺失和问题。

## 问题清单

### ISSUE-ORC-001: 对齐流程未实现

**位置**: `src/app/api/sessions/[id]/chat/route.ts`

设计文档（第 88-96 行）定义的对齐流程：
```
Orchestrator: @产品经理 请确认需求
产品经理: ...确认...
用户: 对...

Orchestrator: @架构师 请出技术方案 + 任务拆解
架构师: ...方案...

Orchestrator: 其他 Agent 有问题吗？
前端工程师: ...
...
```

**问题**：
- `PM_CONFIRMATION_PROMPT` 已定义（`src/lib/orchestrator/prompts.ts:51`）但未使用
- `buildAgentQuestionPrompt` 已定义（`src/lib/orchestrator/prompts.ts:87-108`）但未使用
- 当前 Orchestrator 直接用 `getOrchestratorDecision` 做决策，跳过了对齐阶段
- 只有导入语句（`route.ts:4`），没有实际调用代码

### ISSUE-ORC-002: 纠偏触发范围有限

**位置**: `src/app/api/sessions/[id]/chat/route.ts:606-621`

```typescript
// 6.2b: Orchestrator monitoring (only for CLI agents)
const agent = agents.find(a => a.id === task?.assignedAgentId)
if (agent?.platform !== 'llm') {
  // 纠偏逻辑...
}
```

**问题**：
- 条件 `agent?.platform !== 'llm'` 导致 LLM API Agent（产品经理、架构师）的产出不会被监督纠偏
- 只在执行阶段 CLI Agent 任务完成后触发纠偏
- 对齐阶段无纠偏机制（因为对齐流程本身未实现）

### ISSUE-ORC-003: 监督机制缺失

**位置**: `src/app/api/sessions/[id]/chat/route.ts:577-623`

设计要求："正常运行时沉默，只在关键节点介入"

**问题**：
- 只在任务完成这一个节点审查（`route.ts:606-621`）
- 没有实时监督任务执行过程的能力
- 没有监督对齐阶段讨论的能力
- 缺少"持续观察 + 关键节点介入"的双层设计

### ISSUE-ORC-004: 阶段切换不显式

**位置**: `src/lib/orchestrator/index.ts:84-101` (`getOrchestratorDecision`)

设计要求主持人"控制阶段切换（对齐 → 执行）"

**问题**：
- 只有 `self/delegate/discuss/done` 四种决策模式
- Session 表有 `phase` 和 `phaseStep` 字段，但没有显式的阶段控制逻辑
- 用户说"确认"时没有推进到下一阶段的固定流程
- Orchestrator 需要根据上下文"自主判断"当前阶段，容易出错

## 实现状态对照表

| 设计要求 | 实现状态 | 代码位置 |
|---------|---------|----------|
| 主持人：控制阶段切换 | ⚠️ 部分实现 | `getOrchestratorDecision` 无显式阶段控制 |
| 监督者：沉默观察 | ❌ 未实现 | 只在任务完成后审查，无持续监督 |
| 纠偏者：发现跑偏时纠正 | ⚠️ 部分实现 | `route.ts:606-621`，仅 CLI Agent |
| 对齐流程：PM 确认需求 | ❌ 未实现 | `PM_CONFIRMATION_PROMPT` 未使用 |
| 对齐流程：架构师方案 | ⚠️ 间接实现 | `getOrchestratorDecision` 可委派架构师 |
| 对齐流程：其他 Agent 提问 | ❌ 未实现 | `buildAgentQuestionPrompt` 未使用 |

## 相关文件

- `src/app/api/sessions/[id]/chat/route.ts` — Orchestrator 主逻辑
- `src/lib/orchestrator/index.ts` — Orchestrator 决策函数
- `src/lib/orchestrator/prompts.ts` — Prompt 定义（含未使用的对齐流程 prompts）
- `docs/design/agenthub-v2-design-decisions.md` — 设计文档第 88-96 行（对齐流程）、311-316 行（群聊角色）

## 解决方案建议

1. **实现对齐流程**：在 `handleOrchestratorDecision` 中根据 Session.phase 判断当前阶段，调用 `PM_CONFIRMATION_PROMPT` → 架构师方案 → `buildAgentQuestionPrompt`
2. **扩展纠偏范围**：移除 `platform !== 'llm'` 条件，对所有 Agent 产出进行监督
3. **增加监督机制**：在任务执行过程中定期检查输出，发现异常时提前介入
4. **显式阶段控制**：在 Orchestrator prompt 中加入当前阶段标识，根据阶段强制执行对应流程

## 参考资料

- 设计文档 `docs/design/agenthub-v2-design-decisions.md` 第 88-96 行、311-316 行