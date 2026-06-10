# 执行阶段卡住

> 创建时间: 2026-06-11 | 状态: 🔴未解决

## 问题描述

用户确认方案后，Orchestrator 长时间 "等待回复中..."，没有进入执行阶段。输入框被禁用，无后续消息。

## 出现原因

三个可能的卡住点：

### 1. handleAgentQA 并行调用阻塞（最可能）

`alignment.ts:197-223`：`Promise.allSettled` 并行调用所有 Agent，任何一个 Agent 的 LLM 适配器挂起就阻塞整个流程。没有超时机制。

### 2. Orchestrator 回退到 align_confirm

`validateDecision`（`chat-router.ts:94-123`）没有 `phaseStep` 级别防护。Orchestrator 在 `phaseStep: 'architect_plan'` 时可能选了 `align_confirm`，导致重新走 PM 确认流程。

### 3. taskCount === 0 循环

`chat-router.ts:45-49`：如果 `handleArchitectPlan` 创建 tasks 失败，Orchestrator 选 `execute` 时会被强制改为 `align_decompose`，形成死循环。

## 解决方案

1. `handleAgentQA` 的 `Promise.allSettled` 加超时（每个 Agent 60s）
2. `validateDecision` 加 `phaseStep` 防护：`architect_plan` 之后不能回退到 `align_confirm`
3. `chat-router.ts:45-49` 加最大重试次数限制

## 相关文件

- `src/lib/services/alignment.ts:197-223`（handleAgentQA）
- `src/lib/services/chat-router.ts:94-123`（validateDecision）
- `src/lib/services/chat-router.ts:45-49`（taskCount 检查）
- `src/lib/orchestrator/prompts.ts:9-61`（ORCHESTRATOR_DECISION_PROMPT）

## 截图证据

- `C:\Users\18387\13-execution-started.png`（架构师方案后无后续消息）
- `C:\Users\18387\14-execution-progress.png`（仍然等待中）
- `C:\Users\18387\15-execution-waiting.png`（仍然等待中）
- `C:\Users\18387\16-execution-final.png`（仍然等待中）
