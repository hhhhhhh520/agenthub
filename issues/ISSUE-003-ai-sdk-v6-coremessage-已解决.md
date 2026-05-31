# AI SDK v6 移除 CoreMessage 类型
> 创建时间: 2026-05-19 | 状态: 🟢已解决

## 问题描述
Vercel AI SDK v6 中 `import { CoreMessage } from 'ai'` 报错：`Module '"ai"' has no exported member 'CoreMessage'`。

## 出现原因
AI SDK v6 重构了消息系统，`CoreMessage` 被移除，改用 `ModelMessage`（从 `@ai-sdk/provider-utils` 导出）。同时 `streamText` 的 API 变为使用 `system` + `prompt` 分离参数。

## 解决方案
```typescript
// 旧写法
import { streamText, type CoreMessage } from 'ai'
const messages: CoreMessage[] = []
messages.push({ role: 'system', content: systemPrompt })
messages.push({ role: 'user', content: prompt })
const result = streamText({ model, messages })

// 新写法
import { streamText } from 'ai'
const result = streamText({
  model,
  system: systemPrompt,
  prompt: userPrompt,
})
```

## 相关文件
- `src/lib/adapter/llm-adapter.ts`
