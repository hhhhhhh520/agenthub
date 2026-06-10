# 讨论结果 JSON 泄漏

> 创建时间: 2026-06-11 | 状态: 🔴未解决

## 问题描述

@所有人 讨论完成后，Orchestrator 汇总的消息中包含原始 JSON 数据，如：
- `completed({"agent":"测试工程师","round":2,"message":"..."})`
- `{"agent":"前端工程师","round":3,"message":"..."}`
- `completed|`

这些本该由前端 `useChat` hook 正确处理的 chunk（status、tool_use、tool_result），被当成普通文本拼到了讨论结果里。

## 出现原因

`route.ts:148` 和 `review.ts:193` 的 `onChunk` 回调没有过滤 chunk 类型，直接透传所有 chunk 到 SSE 流。

对比：`delegateToAgent`（`review.ts:135-138`）正确过滤了 `status` chunk。

## 根本问题

讨论流程中 Agent 使用了工具（Read、Grep、MCP），说明 `buildDiscussionPrompt` 没有限制 Agent 的行为。Agent 在讨论阶段不应该读文件、查数据库。

## 解决方案

**表面修复**（止血）：
- `route.ts:148` 的 `onChunk` 加过滤：`if (chunk.type !== 'text') return`
- `review.ts:193` 同理

**根本解**（推荐）：
- `runDiscussion` 中不传 `mcpConfig`，物理隔离工具
- `buildDiscussionPrompt` 明确禁止使用工具

## 相关文件

- `src/app/api/sessions/[id]/chat/route.ts:148`
- `src/lib/services/review.ts:193`
- `src/lib/orchestrator/index.ts:493`（runDiscussion onChunk）
- `src/lib/orchestrator/prompts.ts:160-165`（buildDiscussionPrompt）

## 截图证据

- `C:\Users\18387\09-discussion-in-progress.png`
- `C:\Users\18387\10-discussion-complete.png`
- `C:\Users\18387\12-project-detail-group.png`
