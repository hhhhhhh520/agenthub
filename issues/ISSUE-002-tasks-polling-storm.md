# Tasks 轮询风暴

> 创建时间: 2026-06-07 | 状态: 🟢 已修复（2026-09-10，退避轮询方案）

## 问题描述

任务执行期间，前端每 1-3 秒轮询 `/api/sessions/{id}/tasks`，"redo" 时降到 1 秒间隔。30 秒内产生 50+ 次请求。

## 根本原因

`agent-panel.tsx` 使用 `setInterval` 轮询任务列表，SSE 的 `task_status` 事件只推送 `{taskId, status}`，不包含完整 Task 对象（名称、输出等），前端不得不轮询获取详情。

## 影响范围

- 只在 AI agent 执行任务期间触发，非常态
- "redo" 时最严重（1 秒间隔）
- 单人本地使用场景下影响可忽略

## 延迟修复原因

个人项目，单用户本地运行，SQLite 数据库，当前轮询量完全可承受。

## 修复记录（2026-09-10）

采用"退避轮询"方案而非 SSE 真推送，原因：既有 SSE 的 `task_status` 是**增量载荷**——`src/lib/services/execution.ts` 内 `sendEvent` 只推 `{taskId, status}`（部分带 `retryCount`），不含完整 Task 对象（名称/output/trace）。前端要渲染任务板就得拿全量列表，改真推送需要把载荷扩成完整 Task 并补齐断线重连后的全量对齐，工作量以天计且引入新故障面；单用户本地场景轮询量本就可承受，故取退避轮询。

> ⚠️ 措辞更正（2026-09-13 pre-commit 审查）：本段原述"任务状态由 `src/mcp-server` 独立进程直写 SQLite，Next.js 层没有状态变更钩子可挂事件"，**与实现相反**。核实：`src/mcp-server/index.ts:92` 对 task 仅有 `prisma.task.findMany`（只读），全仓无 mcp-server 的 task 写入；task 状态写入全部发生在 Next.js 层（`execution.ts` 多行、`alignment.ts:212/238`、redo/sessions 路由），且 `sendEvent({type:'task_status'})` 就写在同层写点旁边（`execution.ts:165/190/262/283/341/401/489/515`）。真正的障碍是**载荷粒度**，不是钩子缺失。

改动：
- 新增 `src/lib/poll-interval.ts`（纯函数 `computePollInterval`，便于单测）+ `tests/poll-interval.test.ts`（6 用例）
- `agent-panel.tsx` 轮询改造：`setInterval` 固定 3s → 递归 `setTimeout` 动态节奏（现于 96-136 行）
  - 连续失败 ≥5 次不再**永久停摆**，转 30s 低频探测，成功一次即恢复
  - 常规轮询连续无变化时空闲降频 3s → 10s，有变化恢复 3s
  - redo 快速档保持 1s（**例外**：故障探测期 `errorCount ≥ 5` 时 redo 也让位于 30s 探测——`computePollInterval` 判定顺序为 errorProbe ≻ redoFast，`tests/poll-interval.test.ts:39` 已把该例外钉死）
- 顺带收益：请求串行化（旧版固定 tick 与 fetch 完成解耦，慢响应会叠加并发请求）

## 历史修复方向讨论（保留）

1. **简单方案**：轮询间隔改为 5-10 秒
2. **根治方案**：SSE 推送完整 Task 对象，移除前端轮询

## 相关文件

- `src/components/agent-panel.tsx` — 轮询 effect（line 96-136）
- `src/lib/poll-interval.ts` — 节奏纯函数 `computePollInterval` + 常量
- `src/lib/services/execution.ts` — `task_status` 事件发射点（165/190/262/283/341/401/489/515），是"扩载荷改真推送"的入口

> ⚠️ 路径更正（2026-09-13）：原列 `src/lib/orchestrator/task-events.ts` **不存在**（全历史无此路径）。真实 `task_status` 推送在 `src/lib/services/execution.ts`。
