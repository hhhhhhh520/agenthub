# AgentHub 设计文档

> ⚠️ **已废弃** — 本文档为 V1 初始设计，已被 `agenthub-v2-design-decisions.md` + `alignment-flow-plan.md` + `workspace-and-permissions.md` 替代。
> 主要变更：Orchestrator 从固定3层流水线改为8 action智能编排；Agent 从 Session 私有改为全局共享+SessionMember 中间表；Codex 替换为 OpenCode；Message.role 从 agent/orchestrator 改为 assistant/system；Task 删除 subtasks 层级。
> 保留本文档仅供历史参考，请以 V2 文档为准。

> 创建时间: 2026-05-19 | 状态: ~~设计定稿~~ 已废弃

## 1. 项目概述

**一句话定义**：一个 IM 聊天式的通用多 Agent 协作平台，用户像在飞书里一样跟多个 AI Agent 对话协作，Orchestrator 智能调度任务。

**竞赛课题**：AI 全栈挑战赛 — AgentHub 多 Agent 协作平台

**核心要求**：
- 基于统一适配器层与主流 Agent 平台（Claude Code、Codex）
- IM 聊天式交互，类似飞书/微信
- 单聊、多会话并行、@ 指令群聊协作
- Orchestrator 协调器进行任务拆解
- 代码 Diff、网页预览、一键部署
- 创新点：TRAE 协作、Prompt 工程、架构选型

## 2. 架构总览

```
用户
 ↓
┌─────────────────────────────────────────────────┐
│           前端 (Next.js + TypeScript)             │
│  ┌──────────┬──────────────────┬──────────────┐  │
│  │ 会话列表  │   聊天消息流       │ Agent面板+看板│  │
│  └──────────┴──────────────────┴──────────────┘  │
└────────────────────┬────────────────────────────┘
                     ↓ SSE (流式)
┌─────────────────────────────────────────────────┐
│           后端 (Next.js API Routes)               │
│                                                   │
│  ┌───────────────────────────────────────────┐   │
│  │          Orchestrator 协调器                │   │
│  │  - 场景识别 → 动态角色生成                   │   │
│  │  - 任务拆解 → 分配调度（含平台选择）          │   │
│  │  - 多轮讨论控制 → 结果汇总                   │   │
│  └─────────────────┬─────────────────────────┘   │
│                    ↓                              │
│  ┌───────────────────────────────────────────┐   │
│  │       统一适配器层 (Agent Platform Adapter)  │   │
│  │  connect() → send(task) → stream → close() │   │
│  ├───────────┬───────────┬───────────────────┤   │
│  │LLM Adapter│CC Adapter │ Codex Adapter     │   │
│  │(Claude/GPT│(Claude    │ (可扩展)           │   │
│  │ /Ollama)  │ Code CLI) │                   │   │
│  └─────┬─────┴─────┬─────┴───────────────────┘   │
│        ↓           ↓                              │
│   LLM API    Child Process                        │
│  (Vercel AI  (spawn + stdout                      │
│   SDK)        stream)                              │
└─────────────────────────────────────────────────┘
```

## 3. 核心模块设计

### 3.1 统一适配器层（Agent Platform Adapter）

这是课题要求的核心架构创新点。Adapter 层不是封装 LLM API，而是抽象 **Agent 平台**。

**接口定义：**

```typescript
interface AgentAdapter {
  // 建立连接（LLM: 初始化 client；CLI: spawn 子进程）
  connect(config: AdapterConfig): Promise<void>

  // 发送任务，返回流式输出
  send(task: AgentTask): AsyncIterable<StreamChunk>

  // 关闭连接
  close(): Promise<void>
}

interface AdapterConfig {
  platform: 'llm' | 'claude-code' | 'codex'
  apiKey?: string        // LLM 场景
  workDir?: string       // CLI 场景，Agent 工作目录
  model?: string         // LLM 模型选择
}

interface AgentTask {
  prompt: string
  context?: string       // 共享上下文（项目状态、其他 Agent 输出）
  systemPrompt?: string  // 角色定义
}

interface StreamChunk {
  type: 'text' | 'code' | 'file' | 'status' | 'error'
  content: string
}
```

**三种适配器实现：**

| 适配器 | 适用场景 | 实现方式 |
|--------|---------|---------|
| LLM Adapter | 通用任务（分析、写作、讨论） | Vercel AI SDK，调 Claude/GPT/Ollama API |
| Claude Code Adapter | 代码生成/修改/调试 | `child_process.spawn('claude', [...])`，捕获 stdout 流 |
| Codex Adapter | 代码任务（可扩展） | OpenAI API 或 CLI 包装 |

**Orchestrator 选择适配器的逻辑：**

```
代码生成/修改/调试 → Claude Code Adapter（真实文件操作）
分析/讨论/写作    → LLM Adapter（灵活、快速）
```

### 3.2 Orchestrator 协调器

核心创新点，Prompt 工程的主要体现。

**任务调度流程：**

```
Orchestrator 收到任务
    ↓
第 1 层：场景识别 → 判断任务类型
    ↓
第 2 层：动态生成 Agent 角色
    ↓
第 3 层：任务拆解 + 依赖分析
    ↓
拓扑排序：按依赖关系分批
    ↓
执行：无依赖的任务并行，有依赖的按批次串行
    ↓
汇总结果
```

**任务依赖与串行调度：**
- Task 的 `dependencies` 字段记录前置任务
- Orchestrator 对任务做拓扑排序，无依赖的并行执行，有依赖的等前置完成后启动
- UI 看板上用箭头连线展示依赖关系，已完成任务标绿，阻塞任务标灰

**三层 Prompt 设计：**

**第 1 层 — 场景识别：**
```
System: 你是一个任务分析器。分析用户需求，判断任务类型。
User: {用户消息}
Output: JSON { "type": "code|analysis|writing|design|discussion", "complexity": "simple|complex", "description": "..." }
```

**第 2 层 — 角色生成：**
```
System: 你是一个团队组建专家。根据任务类型，生成合适的 Agent 角色。
Task: {任务描述}
Task Type: {场景类型}
Output: JSON { "agents": [
  { "name": "...", "expertise": "...", "systemPrompt": "...", "platform": "llm|claude-code" }
]}
```

**第 3 层 — 任务拆解与分配：**
```
System: 你是一个项目经理。将任务拆解为子任务并分配给团队成员。
Task: {任务描述}
Available Agents: {角色列表}
Output: JSON { "tasks": [
  { "id": 1, "description": "...", "assignedAgent": "...", "dependencies": [] }
]}
```

**讨论控制 Prompt：**
```
System: 你是讨论主持人。控制多 Agent 讨论的节奏。
Current Round: {当前轮次}/{最大轮次}
Previous Opinions: {前几轮发言}
Current Agent: {当前 Agent}
Instruction: 请给出你的看法，可以同意、反对或补充。控制在 200 字以内。
```

### 3.3 Agent 角色体系（动态生成）

- Orchestrator 根据任务实时生成 Agent 角色
- 每个 Agent 有独立的 system prompt 和指定的 platform
- Agent 通过工件（代码/文本/报告）通信，不直接对话
- 共享状态：所有 Agent 读写同一个项目上下文

**Agent 数据模型：**

```typescript
interface Agent {
  id: string
  name: string              // 角色名称，如 "前端工程师"
  expertise: string         // 专长描述
  systemPrompt: string      // 角色专属 prompt
  platform: 'llm' | 'claude-code' | 'codex'  // 执行平台
  sessionId?: string        // 关联外部 Agent 平台会话
  workDir?: string          // 临时工作目录（CLI 场景）
  status: 'idle' | 'working' | 'done' | 'error'
}
```

### 3.4 Agent 生命周期管理

对于 Claude Code 等需要文件系统的 Agent 平台：

```
任务启动 → 创建临时目录 /tmp/agent-{id}
         → 初始化项目文件（从共享状态同步）
         → 通过 Adapter spawn 子进程
         → 捕获 stdout 流，推送到前端
         → 任务完成 → 收集产物（代码文件）
         → 回写共享状态 → 销毁临时环境
```

### 3.5 @ 指令系统

- `@Agent名 任务描述` → Orchestrator 直接指定 Agent 执行
- `@所有人 讨论话题` → Orchestrator 控制多轮互评讨论
- Orchestrator 控制所有调度，用户感觉是自由交流

**多轮讨论机制：**

```
用户: @所有人 讨论一下这个方案
    ↓
第 1 轮：各自发言
Orchestrator → Agent A: "说说你对这个方案的看法"
Agent A: 返回意见
    ↓
第 2 轮：互评
Orchestrator → Agent B: "Agent A 说用 React，你怎么看？"
Agent B: 返回评论
    ↓
第 3 轮：收束（可选）
Orchestrator → Agent C: "综合前两轮，你的最终意见？"
Agent C: 返回结论
    ↓
Orchestrator 汇总展示
```

控制：最多 3 轮，Orchestrator 可提前收束，用户可随时打断。

### 3.5.1 上下文压缩策略

多 Agent 共享项目上下文，但 LLM 上下文窗口有限。压缩策略：

- **压缩时机**：每轮 Agent 执行完成后
- **压缩方法**：Orchestrator 摘要上一轮结果 + 仅保留当前子任务相关上下文
- **滑动窗口**：保留最近 2 轮完整消息，更早的消息用 Orchestrator 生成的摘要替代
- **共享状态**：项目文件/代码等工件不压缩，始终完整保留

### 3.5.2 并发多 Agent 流式归并

当多个 Agent 同时执行时，后端持有多个流，通过同一个 SSE 连接推送：

- 每条 SSE 事件增加 `agentId` 字段，标识来源 Agent
- 前端按 `agentId` 分组展示：不同 Agent 用不同头像/颜色，消息交替出现
- 避免原始 token 混杂，保持"多人聊天"的可读性

```typescript
interface SSEEvent {
  agentId: string       // 来源 Agent
  type: 'text' | 'code' | 'status' | 'done'
  content: string
  timestamp: number
}
```

### 3.6 代码 Diff 视图

- Agent 生成代码后，使用 Monaco Editor（VS Code 同款）展示 diff
- 支持逐行接受/拒绝修改
- Claude Code Adapter 场景下，直接对比工作目录中的文件变更

### 3.7 网页预览

- 生成的 HTML/CSS/JS 使用 iframe + srcdoc 渲染
- 安全策略：CSP 限制，不使用跨域 src
- 实时预览，不需要部署就能看效果

### 3.8 一键部署

- 生成的代码推送到 Vercel/Cloudflare
- 返回可访问的 URL
- 简化实现：打包为静态文件 → 调用 Vercel API 部署

## 4. UI 布局

```
┌──────────┬──────────────────────────┬──────────────┐
│          │                          │              │
│  会话列表  │       聊天消息区           │  Agent 面板   │
│          │                          │              │
│ - 会话1   │  用户: 帮我做一个TODO应用    │ 🧑‍💻 角色列表  │
│ - 会话2   │                          │  Planner ✅  │
│ - 会话3   │  🤖 Orchestrator:        │  Coder 🔄    │
│          │  任务已拆解为5个子任务       │  Debugger ⏳  │
│          │                          │  Reviewer ⏳  │
│          │  🤖 Planner: 这是开发计划   │              │
│          │  1. 设计数据结构            │ ─────────── │
│          │  2. 实现添加功能            │ 📋 任务看板   │
│          │  ...                     │  □ 数据结构   │
│          │                          │  ✅ 添加功能   │
│          │  🤖 Coder: 代码如下...     │  □ 列表功能   │
│          │                          │              │
│──────────│──────────────────────────│──────────────│
│          │  [输入消息...] [@Agent ▼]  │              │
└──────────┴──────────────────────────┴──────────────┘
```

- **左侧**：会话列表，类似飞书/微信
- **中间**：聊天消息流，区分用户/Agent/Orchestrator 样式，支持流式输出
- **右侧**：Agent 角色面板（实时状态）+ 任务看板（进度可视化）

## 5. 数据模型

```typescript
// 会话
interface Session {
  id: string
  title: string
  createdAt: Date
  agents: Agent[]
  tasks: Task[]
  messages: Message[]
}

// Agent 角色
interface Agent {
  id: string
  name: string
  expertise: string
  systemPrompt: string
  platform: 'llm' | 'claude-code' | 'codex'
  sessionId?: string
  workDir?: string
  status: 'idle' | 'working' | 'done' | 'error'
}

// 任务
interface Task {
  id: string
  description: string
  status: 'pending' | 'in_progress' | 'completed' | 'failed'
  assignedAgentId: string
  dependencies: string[]    // 依赖的任务 ID
  subtasks: Subtask[]
}

// 子任务
interface Subtask {
  id: string
  description: string
  status: 'pending' | 'in_progress' | 'completed'
}

// 消息
interface Message {
  id: string
  role: 'user' | 'agent' | 'orchestrator'
  content: string
  agentId?: string
  taskId?: string
  createdAt: Date
}
```

## 6. 技术栈

| 层 | 技术 | 理由 |
|---|---|---|
| 前端 | Next.js + TypeScript + TailwindCSS + shadcn/ui | 生态成熟，AI 生成质量高 |
| 后端 | Next.js API Routes | 前后端一体，部署简单 |
| AI 层 | Vercel AI SDK（LLM）+ Node.js Child Process（Agent 平台） | 流式输出 + 子进程管理 |
| 实时通信 | SSE (Server-Sent Events) | 轻量，适合流式场景，事件带 agentId 支持多 Agent 并发 |
| 代码编辑 | Monaco Editor | VS Code 同款，diff 开箱即用 |
| 数据库 | SQLite (Prisma) | 轻量，20 天够用 |
| 部署 | Vercel | 一键部署 |

## 7. Prompt 工程创新点

### 7.1 场景自适应
Orchestrator 不是用固定流程处理所有任务，而是先识别场景类型，再动态组建团队。

### 7.2 角色动态生成
每个 Agent 的 system prompt 根据任务动态生成，不是硬编码模板。

### 7.3 平台智能选择
Orchestrator 根据任务性质选择执行平台：代码任务用 Claude Code CLI，通用任务用 LLM API。

### 7.4 讨论节奏控制
Orchestrator 作为讨论主持人，控制轮次、传递上下文、判断何时收束。

### 7.5 Prompt 展示面板（答辩亮点）
前端增加一个可展开的面板，实时展示 Orchestrator 生成的 prompt，让评委看到 Prompt 工程的深度。

## 8. 架构创新点

### 8.1 Agent 平台抽象层
不是封装 LLM API，而是抽象 Agent 平台接口，支持 Claude Code CLI、Codex、LLM 等多种后端。

### 8.2 混合执行模式
同一系统内既有无状态 LLM 调用（快速、灵活），又有有状态 Agent 进程（真实文件操作）。

### 8.3 Orchestrator 中心化调度
Agent 间不直接通信，所有协作通过 Orchestrator 中转，可控、可调试、可预测。

### 8.4 工件驱动通信
Agent 之间通过共享工件（代码/报告/分析结果）间接通信，而非直接对话。

## 9. 开发节奏

| 周 | 目标 | 验证点 |
|---|---|---|
| 第 1 周 | 聊天 UI + 流式输出 + LLM Adapter + 单 Agent 对话 + **验证 Claude Code CLI 流式协议** | 能跟一个 AI 流畅对话；CLI 流式方案确定 |
| 第 2 周 | Orchestrator + 动态角色 + Adapter 接口 + @ 指令 + 多 Agent 协作 + 任务依赖调度 | 能拆任务、多 Agent 按依赖关系执行 |
| 第 3 周 | Claude Code Adapter 集成 + Diff + 预览 + 部署 + 讨论 + 打磨 | 全流程跑通，准备答辩 |

## 10. TRAE 协作体现

使用 TRAE IDE 进行全程开发：
- 代码生成与 Review 在 TRAE 中完成
- Prompt 迭代过程记录在 TRAE 会话中
- 架构决策记录形成可追溯的协作记忆
- 答辩时展示 AI 辅助开发的效率

## 11. 风险与应对

| 风险 | 影响 | 应对策略 |
|---|---|---|
| Claude Code CLI 流式协议未知 | 高 | **第 1 周即验证** CLI 是否支持 `stdout` 流式输出；若为交互式模式则改用 session API；若不可行则退回 LLM 代码能力兜底 |
| 子进程泄漏（僵尸进程） | 高 | 工作目录限定 `/tmp/agenthub-{sessionId}`；请求结束时 `kill` 进程树 + `rimraf` 临时目录；设置进程超时自动终止（5 分钟） |
| SSE 连接断开 | 高 | 实现 last-event-id 重连 |
| 多 Agent 上下文爆炸 | 高 | 滑动窗口摘要压缩（保留最近 2 轮 + 摘要替代更早消息） |
| 并发 Agent 流式消息混乱 | 中 | SSE 事件带 `agentId`，前端按 Agent 分组展示 |
| 动态角色生成质量不稳定 | 中 | 提供 fallback 预定义角色 |
| iframe 安全问题 | 中 | 使用 srcdoc + CSP |
| Orchestrator 死循环 | 中 | 最大轮次限制 + 相同输出检测 |
| 任务依赖死锁 | 低 | 拓扑排序时检测环依赖并报错 |

## 12. 参考文献

- [AgentMesh: Cooperative Multi-Agent for Software Development](https://arxiv.org/abs/2507.19902) — 4 Agent 协作架构参考
- [HALO: Hierarchical Autonomous Logic-Oriented Orchestration](https://arxiv.org/abs/2505.13516) — 分层 Orchestrator 设计
- [Anemoi: Semi-Centralized Agent-to-Agent Communication](https://arxiv.org/abs/2508.17068) — 半中心化通信模式
- [Layered Chain-of-Thought Prompting for Multi-Agent](https://arxiv.org/abs/2501.18645) — 分层 Prompt 策略
- [Dify](https://github.com/langgenius/dify) — 聊天 UI + 模型适配层参考
- [AutoGen](https://github.com/microsoft/autogen) — 多 Agent 对话框架参考
- [MetaGPT](https://github.com/geekan/MetaGPT) — 角色化 Agent + SOP 参考
