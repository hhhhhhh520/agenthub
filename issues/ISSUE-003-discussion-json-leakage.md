# 讨论结果 JSON 泄漏

> 创建时间: 2026-06-10 | 状态: 🟢已解决（2026-08-07）
> 更新: 2026-08-07 表面修复 + 根本修复 + pre-commit 三视角审查（攻击者/生命周期抓到进程隔离回归，已修复）

## 问题描述

@所有人 讨论完成后，Orchestrator 汇总的消息中包含原始 JSON 数据，如：
- `completed({"agent":"测试工程师","round":2,"message":"..."})`
- `{"agent":"前端工程师","round":3,"message":"..."}`
- `completed|`

这些本该由前端 `useChat` hook 正确处理的 chunk（status、tool_use、tool_result），被当成普通文本拼到了讨论结果里。

## 出现原因（修订）

三层叠加：

1. **status chunk 透传（直接泄漏源）**：`runMultiAgentDiscussion`（`review.ts`）的 onChunk 回调未过滤 `status` chunk（`'completed'`/`'retrying in Xms...'`，产自 `process-registry.ts:553/612/907/1085`），全部透传 SSE。前端 `use-chat.ts` 对 `status` 事件**没有专用分支**，落进 catch-all 被当 streaming 文本显示。
2. **讨论 Agent 可调用工具（工具面）**：`runDiscussion` 为每个讨论 Agent 注入 `buildMCPConfig`，Agent 有 MCP 工具可用 → 产生 tool_use/tool_result chunk。
3. **前端 status 双重语义（设计陷阱）**：`status` 事件同时被「适配器噪音」和「服务端有意 UX 状态」（'思考中...'、'正在拆解任务...' 等 14+ 处 `sendEvent type:'status'`）使用，前端无法简单全局忽略——这也是「前端过滤 status」方案被拒的原因。

## 解决方案（已实施）

### 表面修复（止血）
- `review.ts` runMultiAgentDiscussion onChunk 过滤：`if (chunk.type === 'status') return`（与 review.ts:78/148、chat-router.ts:200 既有模式一致）

### 根本修复（推荐方案落地）
- `runDiscussion` 不再注入 mcpConfig，物理隔离 MCP 工具；同步删除因此孤立的 `workDir` 参数（`projectDir` 原只被 mcpConfig 消费）
- `buildDiscussionPrompt` 加"禁止使用任何工具（不要读取文件、执行命令、查询数据）"

### pre-commit 审查补强（攻击者+生命周期视角 ❌）
移除 mcpConfig 后，讨论进程在 ProcessRegistry 的 key 隔离被破坏（旧代码靠 mcpConfig 里 `AGENTHUB_AGENT_NAME` 隐式区分进程）：
- 同凭证讨论 Agent 全部撞 `default:default:<cwd>` 同一 CLI 会话 → 上下文互相污染（Agent B 的 prompt 里混入 Agent A 的 system prompt+历史）
- 凭证为空时还与控制面 `callLLM`/`callLLMForAnalysis` 撞 key，讨论闲聊污染 JSON 流程

**修复**：`runDiscussion` 显式传 `chatSessionId` + `agentId: agent.name` 恢复每 (会话, Agent) 独立 registry key → 独立进程。agentId/chatSessionId 仅用于 registry key，不注入 CLI spawn（已核实）。

## 测试（939 全绿，净 +2）

| 测试 | 守卫内容 |
|------|---------|
| review-extended: adapter status chunks 不转发 SSE | 真回归守卫（旧代码下红）+ 防过度抑制（text 仍转发） |
| review-extended: runDiscussion 5 参形状 | 真回归守卫（旧代码 6 参下红），兜 MCP 回归 |
| orchestrator-extended: 每 Agent 独立进程 + 无 MCP | 真回归守卫（旧代码注入 mcpConfig 下红）+ 钉进程隔离维度 |
| prompts: buildDiscussionPrompt 禁工具 | 真回归守卫（旧代码下红） |

## 相关文件

- `src/lib/orchestrator/index.ts:626`（runDiscussion：不传 mcpConfig + 传 chatSessionId/agentId）
- `src/lib/services/review.ts:199`（onChunk 过滤 status + 调 runDiscussion 5 参）
- `src/lib/orchestrator/prompts.ts:234`（buildDiscussionPrompt 禁工具）

## 已知残留（非本次范围）

- `route.ts:132`（regenerate）与 `chat-router.ts:271`（@提及直聊）onChunk 仍透传 status chunk 到 SSE —— 同款泄漏但不在讨论路径，前端 catch-all 会把 'completed' 短暂显示（done 事件清 buffer 前）。如需根治可参照 review.ts 模式补过滤
- 控制面 `callLLM`/`callLLMForAnalysis` 进程共享 `default:default:<cwd>`（既有设计，顺序 JSON 调用，未处理）
- 前端 status 双重语义未解耦（有意 UX 状态与适配器噪音共用 'status' 类型）——如需彻底解耦需引入新事件类型，涉及 14+ 处 + 前端分支

## 参考资料

- 截图: `C:\Users\18387\09-discussion-in-progress.png` / `10-discussion-complete.png` / `12-project-detail-group.png`
- pre-commit 三视角审查: 攻击者 / 生命周期 / 声明vs实现 各 subagent 报告
