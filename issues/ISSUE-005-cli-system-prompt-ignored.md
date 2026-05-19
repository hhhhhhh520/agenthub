# Claude Code CLI 忽略 --system-prompt 参数
> 创建时间: 2026-05-19 | 状态: 🟢已解决

## 问题描述
Claude Code CLI 的 `--system-prompt` 参数被 CLI 默认的系统提示覆盖，无法控制 LLM 的行为。CLI 始终以 Agent 模式运行，使用自己的技能和上下文。

## 出现原因
Claude Code CLI 是一个完整的 Agent 系统，有自己的默认系统提示、技能加载、Hook 执行等。`--system-prompt` 参数可能被追加到默认提示之后，但默认提示的优先级更高。

## 解决方案
将 system prompt 合并到 user prompt 中，不依赖 `--system-prompt` 参数：
```typescript
const combinedPrompt = `${systemPrompt}\n\n---\n\n用户输入：${userPrompt}\n\n你必须严格按照上述指令返回结果，不要说其他话。`
```

## 相关文件
- `src/lib/orchestrator/index.ts` - `callLLM()` 函数
