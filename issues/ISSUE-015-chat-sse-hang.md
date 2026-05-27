# Chat SSE 流在 LLM 调用失败时挂起无响应
> 创建时间: 2026-05-21 | 状态: 🟢已解决

## 问题描述

向 `/api/sessions/[id]/chat` 发送消息后，SSE 流返回部分数据后卡住，客户端等待 20-35 秒后超时。当 Claude Code CLI 未配置或调用失败时，请求永远挂着不返回。

**复现步骤：**
1. 确保 Claude Code CLI 未正确配置（或故意使用错误路径）
2. 向会话发送消息
3. SSE 流返回 `{"type":"status","content":"思考中..."}` 后无后续数据
4. 客户端无限等待

**预期行为：** LLM 调用失败时应在 10 秒内返回错误事件，告知用户失败原因
**实际行为：** 请求挂起，无超时兜底

## 出现原因

`handleOrchestratorChat` 硬编码 `platform: 'claude-code'`（`claude-code-adapter.ts:24`），当 CLI 不可用时：
1. 子进程启动失败或无响应
2. 没有设置超时机制
3. 错误被静默吞掉，SSE 流保持打开状态

## 解决方案

1. 给 LLM 调用添加超时（建议 30 秒）
2. CLI 调用失败时立即通过 SSE 发送错误事件并关闭流
3. 添加 fallback 逻辑：CLI 不可用时尝试 LLMAdapter

## 相关文件
- `src/lib/adapters/claude-code-adapter.ts`
- `src/app/api/sessions/[id]/chat/route.ts`
- `src/lib/orchestrator/index.ts`

## 参考资料
- 多次 curl 测试均复现，超时时间 20-35 秒不等
