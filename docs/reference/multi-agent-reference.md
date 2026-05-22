# 多 Agent 协作技术方案参考

> 来源：multica-ai/multica、chenhg5/cc-connect、Anthropic Managed Agents
> 记录时间：2026-05-19

---

## 核心问题

AgentHub 当前每次任务都启动新的 Claude CLI 进程，导致：
- 多 Agent 并行时资源占用大
- Windows 上有中文编码问题（GBK vs UTF-8）
- 进程管理复杂

---

## 方案零：Anthropic Managed Agents 架构（官方方案）

### 概述

2026年4月8日发布，Anthropic 的官方托管 Agent 方案。Agent 运行在云端容器中，无需本地进程。

### 核心概念

```
┌─────────────────────────────────────────────────┐
│            Managed Agents API                   │
│                                                 │
│  Agent (配置)  ─→  Session (运行实例)  ─→  Events │
│       ↑                ↑                       │
│  Environment      (云容器沙箱)                   │
└─────────────────────────────────────────────────┘
                     │
                     ▼
              Claude (sonnet-4-6 / opus-4-6)
```

| 概念 | 说明 | 复用？ |
|------|------|--------|
| **Agent** | 模型 + 系统提示 + 工具 + MCP 服务器 | 是，定义一次复用 |
| **Environment** | 云容器模板（包、网络、文件系统） | 是，创建一次复用 |
| **Session** | 运行中的 agent 实例，追加式事件日志 | 每个任务/对话一个 |
| **Events** | 应用和 agent 之间的消息 | 追加，不修改 |
| **Vault** | 安全凭证存储，注入到会话中 | 是 |
| **Files** | 上传的文件，可挂载到会话 | 是 |

### Agent 配置详解

```python
agent = client.beta.agents.create(
    name="代码审查员",
    
    # 模型：用哪个 AI
    model="claude-sonnet-4-6",
    
    # 提示：AI 的角色和行为规则
    system="""你是一个专业的代码审查员。
    - 检查代码的安全漏洞
    - 检查代码的性能问题
    - 给出改进建议""",
    
    # 工具：AI 能用什么工具
    tools=[
        {"type": "read_file"},      # 能读文件
        {"type": "write_file"},     # 能写文件
        {"type": "run_terminal"},   # 能执行命令
    ],
)
```

### API 端点

```bash
POST /v1/agents              # 创建 agent
POST /v1/environments        # 创建环境
POST /v1/sessions            # 启动会话
POST /v1/sessions/:id/events # 发送用户事件
GET  /v1/sessions/:id/stream # SSE 流式响应
```

### Python SDK 示例

```python
from anthropic import Anthropic
client = Anthropic()

# 1. 定义 agent
agent = client.beta.agents.create(
    name="Coding Assistant",
    model="claude-sonnet-4-6",
    system="You are a helpful coding assistant.",
    tools=[{"type": "agent_toolset_20260401"}],
)

# 2. 创建环境
environment = client.beta.environments.create(
    name="quickstart-env",
    config={"type": "cloud", "networking": {"type": "unrestricted"}},
)

# 3. 启动会话
session = client.beta.sessions.create(
    agent=agent.id,
    environment_id=environment.id,
)

# 4. 发送消息并流式接收响应
with client.beta.sessions.events.stream(session.id) as stream:
    client.beta.sessions.events.send(
        session.id,
        events=[{
            "type": "user.message",
            "content": [{"type": "text", "text": "Write hello world"}],
        }],
    )
    for event in stream:
        if event.type == "agent.message":
            print(event.content[0].text)
```

### Messages API vs Managed Agents

| | Messages API | Managed Agents |
|---|---|---|
| 适合场景 | 自定义循环，精细控制 | 长时间运行任务，异步工作 |
| 状态管理 | 你处理 | Anthropic 处理 |
| 沙箱 | 你提供 | 托管容器 |
| 容错 | 你重建 | 无状态，自动恢复 |

### 官方 Cookbooks

地址：`github.com/anthropics/anthropic-cookbook/tree/main/managed_agents`

| Notebook | 教学内容 |
|----------|---------|
| `CMA_iterate_fix_failing_tests.ipynb` | Do → observe → fix 循环，入门教程 |
| `CMA_orchestrate_issue_to_pr.ipynb` | Issue → fix → PR → CI → review → merge |
| `CMA_explore_unfamiliar_codebase.ipynb` | 探索不熟悉的代码库 |
| `CMA_gate_human_in_the_loop.ipynb` | 人类在环审批 |
| `CMA_prompt_versioning_and_rollback.ipynb` | 提示词版本管理和回滚 |
| `CMA_operate_in_production.ipynb` | 生产环境：MCP、Vaults、webhook |
| `CMA_remember_user_preferences.ipynb` | 记忆存储：跨会话记忆 |
| **`CMA_coordinate_specialist_team.ipynb`** | **多 Agent 协调：coordinator + 3 个专家** |
| `CMA_verify_with_outcome_grader.ipynb` | 评分和修订循环 |

### 对 AgentHub 最有价值的：多 Agent 协调模式

来自 `CMA_coordinate_specialist_team.ipynb`：

> A coordinator runs three specialists (web-search researcher, file-reading librarian, rules-based pricer) with scoped toolsets to assemble a sales proposal.

**核心设计**：
```
┌─────────────────────────────────────┐
│         Coordinator（协调者）        │
│    负责任务分解和结果汇总            │
└──────────────┬──────────────────────┘
               │
       ┌───────┼───────┐
       ▼       ▼       ▼
   ┌───────┐ ┌───────┐ ┌───────┐
   │研究员  │ │图书馆员│ │定价员  │
   │搜索网页│ │读文件  │ │算价格  │
   └───────┘ └───────┘ └───────┘
```

**关键特性**：
- `multiagent` 配置字段
- `thread_created` / `thread_message_received` 事件类型
- 每个角色有独立的工具权限（scoped toolsets）

**对 AgentHub 的启发**：
- Orchestrator = Coordinator
- 每个 Agent 有独立的工具权限
- 任务通过线程（thread）传递

---

## 方案一：配置文件驱动（来自 cc-connect）

### 核心机制

通过 `[projects.agent.options.env]` 为每个 Agent 注入独立环境变量：

```toml
[[projects]]
name = "my-backend"

[projects.agent]
type = "claudecode"

[projects.agent.options]
work_dir = "/path/to/backend"
mode = "default"

[projects.agent.options.env]
ANTHROPIC_AUTH_TOKEN = "sk-ant-xxx"
ANTHROPIC_BASE_URL = "https://api.anthropic.com"
ANTHROPIC_MODEL = "claude-sonnet-4-20250514"
```

### 对 AgentHub 的价值

- 不同 Agent 可以用不同 API key、不同模型、不同 API 端点
- 无需修改全局 `~/.claude/settings.json`
- 配置文件统一管理，易于维护

### 实现建议

```typescript
interface AgentConfig {
  name: string
  platform: 'claude-code' | 'codex' | 'cursor'
  workDir: string
  mode: 'default' | 'auto' | 'yolo'
  env: {
    ANTHROPIC_AUTH_TOKEN?: string
    ANTHROPIC_BASE_URL?: string
    ANTHROPIC_MODEL?: string
  }
}
```

---

## 方案二：串行执行（最简单）

### 当前问题

```typescript
// 当前：并行（多个进程）
await Promise.all(tasks.map(async (task) => { ... }))
```

### 改进方案

```typescript
// 改成：可配置的串行/并行
if (config.sequential) {
  for (const task of tasks) { ... }  // 一个进程依次执行
} else {
  await Promise.all(tasks.map(async (task) => { ... }))  // 并行
}
```

### 优缺点

| 模式 | 优点 | 缺点 |
|------|------|------|
| 并行 | 快 | 资源占用大，进程管理复杂 |
| 串行 | 资源少，简单 | 慢（任务依次执行）|

---

## 方案三：长期会话模式（来自 cc-connect）

### 核心机制

- 每个 Agent 维护一个长期运行的 Claude 会话
- 使用 `--input-format stream-json` + `--permission-prompt-tool stdio` 实现双向通信
- 支持会话恢复（`--resume sessionID`）

### 对 AgentHub 的价值

- 避免频繁创建/销毁进程
- 支持会话上下文保持
- 更好的资源管理

### 实现难度

高。需要重构 Claude CLI 的调用方式。

---

## 优先级建议

| 优先级 | 方案 | 原因 |
|--------|------|------|
| P0 | 串行执行选项 | 最简单，立即可实现 |
| P1 | 配置文件驱动 | 解决多 API key 需求 |
| P2 | 长期会话模式 | 架构改进，需要较大重构 |
