# 设计 vs 实现差距清单

> 创建时间: 2026-05-19 | 状态: 🔴未解决
> 设计文档: `docs/superpowers/specs/2026-05-19-agenthub-design.md`

## 问题描述

当前实现只完成了基础功能，设计文档中的多个核心协作机制未实现，导致用户体验为"任务分发器"而非"协作协调器"。

## 差距清单

### 高优先级（核心体验）

| # | 功能 | 设计文档 | 当前状态 | 影响 |
|---|------|----------|----------|------|
| 1 | **多轮讨论机制** | 3.5 节 `@所有人 讨论方案` | ⚠️ 已集成但效果待验证 | runDiscussion() 已调用，但用户反馈"各干各的" |
| 2 | **@ 指令系统** | 3.5 节 `@Agent名 任务描述` | ✅ 已实现 | 前端解析 + API 分支 + executeSingleAgent |
| 3 | **并发流式归并** | 3.5.2 节 不同 Agent 不同颜色 | ✅ 已实现 | 8色 hash 分配 + Avatar 头像 |

### 中优先级（答辩亮点）

| # | 功能 | 设计文档 | 当前状态 | 影响 |
|---|------|----------|----------|------|
| 4 | **Prompt 展示面板** | Task 11 | ❌ 无 | 答辩亮点缺失，无法展示 Prompt 工程深度 |
| 5 | **任务依赖可视化** | UI 布局 箭头连线 | ⚠️ 只有文字列表 | 看板不直观 |
| 6 | **Agent 角色可视化** | Task 7 动态头像+状态 | ⚠️ 只有名字 | 缺少视觉区分 |

### 低优先级（稳定性）

| # | 功能 | 设计文档 | 当前状态 | 影响 |
|---|------|----------|----------|------|
| 7 | **上下文压缩** | 3.5.1 节 滑动窗口摘要 | ❌ 无 | 长对话会爆 |
| 8 | **工件驱动通信** | 8.4 节 共享工件协作 | ❌ Agent 完全独立 | 协作感弱 |

## 详细说明

### 1. 多轮讨论机制

设计：用户发送 `@所有人 讨论一下这个方案`，Orchestrator 控制多轮互评：
- 第 1 轮：各自发言
- 第 2 轮：Agent B 评论 Agent A 的输出
- 第 3 轮：收束总结
- 最多 3 轮，可提前收束

当前：`runDiscussion()` 已实现并集成到主流程（`chat/route.ts` 第 29 行），`@所有人` 时触发。但用户反馈"各干各的"，可能是以下原因：
- 前端消息没有按 Agent 分组展示（#3 并发流式归并未实现）
- Agent 之间无法看到彼此的实时输出（#8 工件驱动通信未实现）

### 2. @ 指令系统 ✅

设计：
- `@Agent名 任务描述` → 直接指定 Agent 执行
- `@所有人 讨论话题` → 多轮讨论

已实现：
- 前端 `chat-area.tsx` 解析 `@Agent名`，与 Agent 列表白名单验证
- Hook `use-chat.ts` 透传 `targetAgent` 参数
- API `chat/route.ts` 新增 `targetAgent` 分支
- 编排器新增 `executeSingleAgent()` 函数

### 3. 并发流式归并 ✅

设计：不同 Agent 用不同头像/颜色，消息交替出现。

已实现：
- 新建 `src/lib/agent-colors.ts`：8 种颜色 hash 分配（rose/emerald/amber/cyan/pink/lime/violet/teal）
- `chat-area.tsx`：Agent 消息用 `getAgentStyle(agentId)` 获取独立颜色 + Avatar 首字母头像
- 流式消息同样应用 Agent 颜色，不再统一灰色
- Tailwind JIT 兼容：所有类名以完整字符串存储

### 4. Prompt 展示面板

设计：前端增加可展开面板，实时展示 Orchestrator 生成的 prompt：
- 第 1 层：场景识别 prompt + response
- 第 2 层：角色生成 prompt + response
- 第 3 层：任务拆解 prompt + response

当前：完全没有这个组件。

## 解决方案

### 阶段 1：核心协作（1-2 天）

1. 实现 @ 指令解析（前端输入框）
2. 实现多轮讨论调用（orchestrator 主流程）
3. 前端按 agentId 分组展示消息（不同颜色）

### 阶段 2：答辩亮点（1 天）

4. 创建 PromptPanel 组件
5. 集成到 Agent 面板的第三个 tab
6. 任务看板添加依赖连线

### 阶段 3：稳定性（可选）

7. 实现上下文压缩（滑动窗口摘要）
8. 优化工件共享机制

## 相关文件

- 设计文档: `docs/superpowers/specs/2026-05-19-agenthub-design.md`
- 实现计划: `docs/superpowers/plans/2026-05-19-agenthub.md`
- Orchestrator: `src/lib/orchestrator/index.ts`
- Chat API: `src/app/api/sessions/[id]/chat/route.ts`
- Chat 组件: `src/components/chat-area.tsx`
