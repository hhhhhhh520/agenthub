# Tasks 轮询风暴

> 创建时间: 2026-06-07 | 状态: ⏸️ 已知问题-暂不修复

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

## 后续修复方向（如需）

1. **简单方案**：轮询间隔改为 5-10 秒
2. **根治方案**：SSE 推送完整 Task 对象，移除前端轮询

## 相关文件

- `src/components/agent-panel.tsx` — 轮询逻辑（line 85-88）
- `src/lib/orchestrator/task-events.ts` — task_status 事件推送
