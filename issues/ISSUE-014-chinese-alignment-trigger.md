# 中文消息无法触发 Orchestrator 对齐流程
> 创建时间: 2026-05-21 | 状态: 🟢已解决

## 问题描述

发送中文任务型消息时，`isTaskIntent` 正则能正确匹配，但会话 phase 停留在 `idle`，PM 确认流程未被触发。英文消息正常工作。

**复现步骤：**
1. 创建新的 group 类型会话（含 orchestrator 成员）
2. 发送中文消息："做一个TODO应用"
3. 观察会话 phase → 始终为 `idle`
4. 发送英文消息："Build a login page"
5. 观察会话 phase → 正常变为 `pm-confirming`

**预期行为：** 中文任务消息应和英文一样触发对齐流程
**实际行为：** 中文消息只返回 Orchestrator 的文字回复，phase 不推进

## 出现原因

初步定位：Orchestrator 调用 LLM 后，返回的 JSON 可能因中文编码问题导致解析失败，`advancePhase()` 未被调用。

相关代码：
- `src/lib/orchestrator/index.ts` — `isTaskIntent` 正则匹配正常
- `src/lib/orchestrator/index.ts:603-609` — `executeTaskBatch` 的 catch 块静默吞掉错误，无日志输出

## 解决方案

1. 在 `executeTaskBatch` catch 块中添加 `console.error` 记录具体错误
2. 检查 LLM 返回内容的 JSON 解析逻辑，确保中文字符正确处理
3. 添加 `advancePhase` 的调用日志，确认是否被触发

## 相关文件
- `src/lib/orchestrator/index.ts`
- `src/app/api/sessions/[id]/chat/route.ts`

## 参考资料
- 测试于 2026-05-21，dev server 运行在 localhost:3001
