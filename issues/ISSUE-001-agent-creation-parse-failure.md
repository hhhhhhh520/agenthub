# ISSUE-001: 对话式创建 Agent 解析失败

> 创建时间: 2026-05-22 | 状态: 🟢已解决

## 问题描述

用户发送 "Create a new agent: Python backend engineer, skilled in FastAPI and SQLAlchemy" 时，`handleCreateAgent` 函数触发成功，但 LLM 返回的配置无法解析为 JSON，导致创建失败。

**实际错误输出**：
```
data: {"agentId":"orchestrator","type":"status","content":"正在生成 Agent 配置..."}
data: {"agentId":"orchestrator","type":"error","content":"Agent 配置解析失败..."}
```

## 出现原因

**根本原因**：LLM 返回了**两个重复的 JSON 代码块**，正则表达式只提取了第一个，导致剩余内容无法解析。

**实际 LLM 返回内容（1160字符）**：
```
```json
{"name":"Python Backend Engineer","expertise":"FastAPI and SQLAlchemy development",...}
```
```json
{"name":"Python Backend Engineer","expertise":"FastAPI and SQLAlchemy development",...}
```
```

**正则处理后得到**：
```
{"name":"Python Backend Engineer",...}
```
```json
{"name":"Python Backend Engineer",...}
```
```

这不是有效的 JSON 格式，因为第一个代码块被提取后，第二个代码块仍然存在。

**证据**：
1. 正则匹配成功（`isCreateIntent` 为 true）
2. `handleCreateAgent` 被调用（看到 "正在生成 Agent 配置..." 状态）
3. LLM 返回了有效 JSON，但被重复输出两次
4. 当前正则 `/\`\`\`json?\s*([\s\S]*?)\`\`\`/` 使用非贪婪匹配，只提取第一个代码块

**代码位置**：
- 触发判断：`src/app/api/sessions/[id]/chat/route.ts:136`
- 解析失败位置：`src/app/api/sessions/[id]/chat/route.ts:350-354`
- 正则清理逻辑：`src/app/api/sessions/[id]/chat/route.ts:348`
  ```typescript
  const cleaned = configText.replace(/```json?\s*([\s\S]*?)```/, '$1').trim()
  ```
- LLM 调用：`src/lib/orchestrator/index.ts:13-23` 的 `callLLMForAnalysis` 函数

## 解决方案

**方案 A**：使用全局替换（推荐）
- 将正则改为 `/\`\`\`json?\s*([\s\S]*?)\`\`\`/g`（添加 `g` 标志）
- 这样会替换所有代码块，只保留第一个 JSON 内容
- 或者在替换后再次检查是否还有代码块残留

**方案 B**：使用已有的 `parseJSON` 函数
- `src/lib/orchestrator/index.ts:40-53` 已有更健壮的 `parseJSON` 函数
- 该函数支持直接解析 + markdown 代码块提取 + 查找 JSON 对象边界
- 可以直接复用该函数替代当前的正则清理逻辑

**方案 C**：只提取第一个 JSON 对象
- 使用正则 `/\{[\s\S]*\}/` 匹配第一个完整的 JSON 对象
- 不依赖 markdown 代码块格式

## 相关文件

| 文件 | 作用 |
|------|------|
| `src/app/api/sessions/[id]/chat/route.ts:335-387` | `handleCreateAgent` 函数，处理 Agent 创建逻辑 |
| `src/app/api/sessions/[id]/chat/route.ts:348` | 正则清理逻辑（问题所在） |
| `src/lib/orchestrator/index.ts:13-23` | `callLLMForAnalysis` 函数，调用 LLM 获取配置 |
| `src/lib/orchestrator/index.ts:40-53` | `parseJSON` 函数，更健壮的 JSON 解析（未被使用） |

## 解决记录

**解决时间**: 2026-05-22

**采用方案**: 方案 B — 复用 `parseJSON` 函数

**修改内容**:
1. `src/lib/orchestrator/index.ts`: 导出 `parseJSON` 函数
2. `src/app/api/sessions/[id]/chat/route.ts`: 导入 `parseJSON`，替换 `handleCreateAgent` 中的正则清理逻辑

**修改后代码**:
```typescript
import { parseJSON } from '@/lib/orchestrator'

const configText = await callLLMForAnalysis(configPrompt)
let config = parseJSON(configText)  // 直接使用更健壮的解析函数
```

## 参考资料

- 测试命令：
  ```bash
  curl -s -N -X POST "http://localhost:3000/api/sessions/{sessionId}/chat" \
    -H "Content-Type: application/json" \
    -d '{"message":"Create a new agent: Python backend engineer, skilled in FastAPI and SQLAlchemy"}'
  ```
- 预期结果：创建名为 "Python Backend Engineer" 的 Agent