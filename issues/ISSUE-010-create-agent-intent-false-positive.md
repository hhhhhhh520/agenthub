# 创建 Agent 意图启发式误判（文件操作被路由到建 Agent）

> 创建时间: 2026-08-05 | 状态: 🟢已解决
> 发现方式: qwen3.8-max-preview 模型切换后的端到端协作冒烟

## 问题描述

发送消息 "在当前目录创建一个 hello.txt，内容写入 Hello AgentHub" 时，系统没有创建 hello.txt，而是创建了一个名为 "HelloAgentHub" 的新 Agent，然后直接结束（done）。文件从未被创建。

## 出现原因

`src/app/api/sessions/[id]/chat/route.ts` 的创建 Agent 意图启发式过于宽松：

```js
// 修复前
const isCreateIntent =
  /创建|新建|添加|帮我建|create.*agent|建一?个/i.test(message) &&
  /agent|智能体|助手/i.test(message)
```

两个条件被独立子串匹配同时命中：
1. `/创建|.../` 命中 "创建一个"
2. `/agent/i` 命中 "**AgentHub**" 里的 "agent" 子串（产品名的一部分，不是独立关键词）

→ 误判为"创建 Agent"意图，走 `handleCreateAgent`，LLM 把内容里的 "Hello AgentHub" 当成了新 Agent 的名字。该启发式自初始 commit（7411345 阶段2 Agent管理）就存在，但此前 E2E 测试用的消息（"在当前目录创建 hello.txt"）不含 "agent" 字样，从未触发，属潜伏 bug。

## 解决方案

提取为可测试函数 `isCreateAgentIntent()`（`src/lib/services/chat-router.ts`），收紧 agent 关键词匹配：

```js
export function isCreateAgentIntent(message: string): boolean {
  if (!message) return false
  const hasCreateVerb = /创建|新建|添加|帮我建|建一?个/i.test(message)
  // "agent" 用词边界排除 AgentHub/helloAgent 等；中文 \b 无效故字面匹配
  const hasAgentKeyword = /\bagent\b/i.test(message) || /智能体|助手/.test(message)
  return hasCreateVerb && hasAgentKeyword
}
```

关键点：
- `agent` 用 `\b` 词边界，"AgentHub"（Agent 后跟 H）不命中
- 中文"智能体/助手"不能包在 `\b` 里（JS `\b` 是 ASCII 词边界，对中文无效），直接字面匹配

## 相关文件

- `src/lib/services/chat-router.ts` — 新增 `isCreateAgentIntent()`
- `src/app/api/sessions/[id]/chat/route.ts` — 路由改用该函数
- `tests/chat-router.test.ts` — 3 个针对性用例（真阳性 + 本次误判回归守卫 + 边界）

## 验证

- 修复后重发同一消息：Orchestrator 正确选择 self action，创建 hello.txt（内容 "Hello AgentHub"）✅
- `tests/chat-router.test.ts` 22 项全绿
- 复杂任务（Python 统计工具）端到端通过：委派后端工程师 + 自主排查 Windows python3 占位符问题 + 边界测试 + 结构化汇报

## 教训

路由启发式用裸子串匹配关键词，会被"关键词作为更长单词一部分"（AgentHub）或"文件名含关键词"（helloAgent.txt）误命中。意图检测关键词必须加词边界，且中文/ASCII 要分开处理。这类启发式必须有真阳性+假阳性的针对性测试守护。
