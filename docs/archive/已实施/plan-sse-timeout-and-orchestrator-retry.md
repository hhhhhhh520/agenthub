# SSE 超时延长 + Orchestrator 自动纠偏计划

> 创建时间: 2026-06-09
> 状态: 部分完成（SSE超时已改，Orchestrator自动纠偏已实现delegateToAgent路径）

## 背景

当前 AgentHub 存在两个问题：
1. SSE 连接超时设为 5 分钟，复杂任务（如多 Agent 协作）容易超时
2. Orchestrator 的纠偏只是发消息，不会触发 Agent 重新执行，纠偏无效

## 改动一：SSE 超时延长到 30 分钟

### 修改文件

`src/app/api/sessions/[id]/chat/route.ts`

### 具体改动

| 行号 | 当前代码 | 改为 |
|------|---------|------|
| 94 | `const SSE_TIMEOUT_MS = 5 * 60_000` | `const SSE_TIMEOUT_MS = 60 * 60_000` |
| 107 | `'请求超时（5分钟），请重试'` | `'请求超时（60分钟），请重试'` |

### 改动说明

- 第 94 行：超时时间从 5 分钟改为 60 分钟
- 第 107 行：错误提示信息同步更新

## 改动二：Orchestrator 自动纠偏（最大重试 3 次）

### 修改文件

1. `src/lib/services/review.ts`（主要修改）
2. `src/app/api/sessions/[id]/chat/route.ts`（调用点 3 和 4）

### 具体改动

#### 0. 确保导入 `executeSingleAgent`

在 `review.ts` 文件顶部，确认已导入 `executeSingleAgent`：

```typescript
// 当前导入
import { executeSingleAgent, runDiscussion, callLLMForAnalysis } from '@/lib/orchestrator'

// 如果没有，需要添加
import { executeSingleAgent } from '@/lib/orchestrator'
```

#### 1. 修改 `reviewResult` 函数签名

```typescript
// 当前
export async function reviewResult(
  result: string,
  taskDescription: string,
  sessionId: string,
  sendEvent: SendEvent
): Promise<{ quality: string }>

// 改为
export async function reviewResult(
  result: string,
  taskDescription: string,
  sessionId: string,
  sendEvent: SendEvent,
  retryContext?: {
    agent: { name: string; systemPrompt: string; platform: string; model?: string; baseUrl?: string; apiKey?: string; id?: string; tools?: string }
    maxRetries?: number
    currentRetry?: number
    chatSessionId?: string
    projectDir?: string
  }
): Promise<{ quality: string }>
```

#### 2. 修改 `reviewResult` 函数体

将第 21-25 行的纠偏逻辑改为自动重试：

```typescript
// 当前代码（第 21-25 行）
if (review.needsCorrection && review.correctionNote) {
  const correctionMsg = `Orchestrator 纠偏：${review.correctionNote}`
  await prisma.message.create({ data: { role: 'orchestrator', rawContent: correctionMsg, sessionId } })
  sendEvent({ agentId: 'orchestrator', type: 'text', content: correctionMsg, data: { quality: 'poor' } })
  return { quality: review.quality || 'poor' }
}

// 改为
if (review.needsCorrection && review.correctionNote) {
  const correctionMsg = `Orchestrator 纠偏：${review.correctionNote}`
  await prisma.message.create({ data: { role: 'orchestrator', rawContent: correctionMsg, sessionId } })
  sendEvent({ agentId: 'orchestrator', type: 'text', content: correctionMsg, data: { quality: 'poor' } })

  // 如果有重试上下文且未超过最大重试次数，自动重新执行 Agent
  const maxRetries = retryContext?.maxRetries ?? 3
  const currentRetry = retryContext?.currentRetry ?? 0

  if (retryContext?.agent && currentRetry < maxRetries) {
    sendEvent({ agentId: 'orchestrator', type: 'text', content: `正在要求 Agent 改进（第 ${currentRetry + 1}/${maxRetries} 次重试）...` })

    const retryPrompt = `之前的结果有问题：${review.correctionNote}\n\n原始任务：${taskDescription}\n\n请重新完成任务，确保修复上述问题。`

    try {
      const { result: retryResult } = await executeSingleAgent(
        {
          ...retryContext.agent,
          workDir: retryContext.projectDir,
        },
        retryPrompt,
        '',
        (agentId, chunk) => {
          if (chunk.type === 'status') return
          sendEvent({ agentId, type: chunk.type, content: chunk.content, data: chunk.data })
        },
        retryContext.chatSessionId,
        retryContext.projectDir,
      )

      // 保存重试结果
      await prisma.message.create({
        data: { role: 'agent', rawContent: retryResult, sessionId, agentId: retryContext.agent.name },
      })

      // 递归检查重试结果
      return reviewResult(retryResult, taskDescription, sessionId, sendEvent, {
        ...retryContext,
        currentRetry: currentRetry + 1,
      })
    } catch {
      // 重试失败，明确标记为差
      return { quality: 'poor' }
    }
  }

  return { quality: review.quality || 'poor' }
}
```

#### 3. 修改所有 `reviewResult` 调用点

`reviewResult` 共有 4 个调用点，需要在 `delegateToAgent` 调用时传入重试上下文：

##### 调用点 1：`review.ts:80`（delegateToAgent 函数）

```typescript
// 当前代码
const { quality } = await reviewResult(result, taskMessage, sessionId, sendEvent)

// 改为
const { quality } = await reviewResult(result, taskMessage, sessionId, sendEvent, {
  agent: { name: agent.name, systemPrompt: agent.systemPrompt, platform: agent.platform, model: agent.model, baseUrl: agent.baseUrl, apiKey: agent.apiKey, id: agent.id, tools: agent.tools },
  maxRetries: 3,
  currentRetry: 0,
  chatSessionId: sessionId,
  projectDir: workDir,
})
```

##### 调用点 2：`review.ts:127`（runMultiAgentDiscussion 函数）

不需要修改（讨论结果不适合自动重试）

##### 调用点 3：`route.ts:182`（@mention Agent 执行）

```typescript
// 当前代码
const { quality: mentionQuality } = await reviewResult(result, message, sessionId, sendEvent)

// 改为
const { quality: mentionQuality } = await reviewResult(result, message, sessionId, sendEvent, {
  agent: { name: agent.name, systemPrompt: agent.systemPrompt, platform: agent.platform, model: agent.model, baseUrl: agent.baseUrl, apiKey: agent.apiKey, id: agent.id, tools: agent.tools },
  maxRetries: 3,
  currentRetry: 0,
  chatSessionId: sessionId,
  projectDir: workDir,
})
```

##### 调用点 4：`route.ts:211`（私聊执行）

```typescript
// 当前代码
const { quality: privQuality } = await reviewResult(result, message, sessionId, sendEvent)

// 改为
const { quality: privQuality } = await reviewResult(result, message, sessionId, sendEvent, {
  agent: { name: agent.name, systemPrompt: agent.systemPrompt, platform: agent.platform, model: agent.model, baseUrl: agent.baseUrl, apiKey: agent.apiKey, id: agent.id, tools: agent.tools },
  maxRetries: 3,
  currentRetry: 0,
  chatSessionId: sessionId,
  projectDir: workDir,
})
```

### 改动说明

- `reviewResult` 新增可选参数 `retryContext`，包含 Agent 信息和重试计数
- 当 Orchestrator 发现问题时，自动调用 `executeSingleAgent` 重新执行
- 使用递归调用实现重试，每次重试 `currentRetry + 1`
- 最大重试 3 次，超过后返回 `quality: 'poor'`
- 每次重试都会保存消息到数据库，并通过 SSE 推送给前端

## 检验方法

### 检验改动一（SSE 超时）

1. 启动开发服务器：`npm run dev`
2. 创建一个群聊，发送一个需要较长时间的任务
3. 观察任务是否能在 5-60 分钟内完成而不超时
4. 预期：之前 5 分钟会超时的任务，现在可以正常完成

### 检验改动二（Orchestrator 自动纠偏）

1. 启动开发服务器：`npm run dev`
2. 创建一个群聊，发送一个有明确要求的任务
3. 观察 Orchestrator 是否会在 Agent 结果不满意时自动要求改进
4. 预期：
   - 看到 "Orchestrator 纠偏：..." 消息
   - 看到 "正在要求 Agent 改进（第 1/3 次重试）..." 消息
   - Agent 自动重新执行
   - 最多重试 3 次

### 单元测试

运行现有测试确保无回归：

```bash
npx vitest run
```

预期：所有 660 个测试通过

## 影响范围分析

### 不受影响的部分

| 模块 | 原因 |
|------|------|
| Orchestrator 决策逻辑 | 只是执行方式变了，决策逻辑不变 |
| Agent 适配器（ClaudeCodeAdapter/OpenCodeAdapter） | 执行方式不变 |
| 数据库 schema | 表结构不需要改 |
| 权限控制 | 逻辑不变 |
| Session 管理 | 逻辑不变 |
| MCP 配置 | 逻辑不变 |
| 文件操作工具 | 逻辑不变 |

### 可能受影响的部分

| 模块 | 影响 | 风险 |
|------|------|------|
| SSE 连接时长 | 从 5 分钟延长到 60 分钟 | 低：只是数值变化 |
| `reviewResult` 函数 | 新增重试逻辑 | 中：需要确保递归不会无限循环 |
| `delegateToAgent` 函数 | 调用 `reviewResult` 时传入新参数 | 低：可选参数，向后兼容 |
| `route.ts` @mention 执行 | 调用 `reviewResult` 时传入新参数 | 低：可选参数，向后兼容 |
| `route.ts` 私聊执行 | 调用 `reviewResult` 时传入新参数 | 低：可选参数，向后兼容 |
| 前端显示 | 会看到更多重试相关消息 | 低：只是新增消息类型 |

### 风险控制

1. **递归深度控制**：`currentRetry < maxRetries` 确保最多重试 3 次
2. **向后兼容**：`retryContext` 是可选参数，不影响现有调用
3. **错误处理**：重试过程中的错误会被独立 try-catch 捕获，失败时返回 `quality: 'poor'`，不会被外层 catch 吞掉
4. **数据库一致性**：每次重试的结果都会保存到数据库

## 执行步骤

1. 先执行改动一（SSE 超时），运行测试验证
2. 再执行改动二（Orchestrator 自动纠偏），运行测试验证
3. 手动测试两个改动的端到端流程
4. 更新 CLAUDE.md 文档
