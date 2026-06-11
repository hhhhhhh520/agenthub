# 任务面板不刷新

> 创建时间: 2026-06-10 | 状态: 🟢已解决（2026-06-10）

## 解决方案

projects/[id]/page.tsx 的内联 Agent/Task 面板替换为 AgentPanel 组件（自带 3 秒轮询），删除 74 行内联代码。

## 问题描述

任务拆解完成后，右侧面板始终显示 `Tasks (0)`，不更新。

## 出现原因

`page.tsx:80` 的 tasks 只在组件挂载时 fetch 一次（`useEffect([sessionId])`），SSE 流处理中没有 re-fetch tasks。

后端 `handleArchitectPlan`（`alignment.ts:158-170`）正确创建了 tasks，`/api/sessions/[id]/tasks` GET 端点也正常。只是前端没有刷新。

## 解决方案

在 `page.tsx` 的 `handleSend` SSE 处理结束后，re-fetch tasks 和 agents：
```typescript
// SSE 流结束后
fetch(`/api/sessions/${sessionId}/tasks`).then(r => r.json()).then(data => { if (Array.isArray(data)) setTasks(data) })
fetch(`/api/sessions/${sessionId}/agents`).then(r => r.json()).then(data => { if (Array.isArray(data)) setAgents(data) })
```

或者在收到 `phase_transition` / `awaiting_user_input` 事件时 re-fetch。

## 相关文件

- `src/app/(dashboard)/projects/[id]/page.tsx:80`（tasks fetch）
- `src/app/(dashboard)/projects/[id]/page.tsx:90-145`（handleSend SSE 处理）

## 截图证据

- `C:\Users\18387\09-discussion-in-progress.png`（右上角 Tasks (0)）
- `C:\Users\18387\12-project-detail-group.png`（右侧 Tasks (0)）
