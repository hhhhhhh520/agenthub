# Multica 项目 Agent 机制代码级报告

> 分析日期: 2026-06-03 | 项目路径: `D:\projects\multica`

---

## 1. 项目概览

**Multica** (Multiplexed Information and Computing Agent) — 开源 managed agents 平台，Go 后端 + Next.js 前端 monorepo。支持 11 种 agent provider：Claude Code、Codex、GitHub Copilot CLI、OpenClaw、OpenCode、Hermes、Gemini、Pi、Cursor Agent、Kimi、Kiro CLI。

---

## 2. Agent 数据模型

**文件:** `server/pkg/db/queries/agent.sql`

Agent 是 `agent` 表的一行，关键字段：

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | UUID | 主键 |
| `workspace_id` | UUID | 所属工作区 |
| `name` | text | 工作区内唯一 |
| `instructions` | text | 系统提示词 |
| `runtime_id` | FK | 关联计算环境 |
| `status` | text | `"idle"` / `"working"`，**从活跃任务自动推导** |
| `max_concurrent_tasks` | int | 默认 6 |
| `custom_env` | JSONB | 每 agent 环境变量（如 API key） |
| `custom_args` | JSONB | 额外 CLI 参数 |
| `mcp_config` | JSONB | MCP server 配置 |
| `model` | text | 模型覆盖（如 `claude-sonnet-4-20250514`） |
| `visibility` | text | `"public"` / `"private"` |
| `archived_at` | timestamptz | 软删除 |

---

## 3. Agent 创建流程

**文件:** `server/internal/handler/agent.go:382-566` (`CreateAgent`)

```
POST /api/agents
  → 验证 name 必填, description ≤ 255 字符, runtime_id 必填
  → 验证 runtime 存在且用户有权限（private runtime gate）
  → INSERT into agent 表
  → 若 runtime 在线 → ReconcileAgentStatus 设置初始状态
  → Publish EventAgentCreated（实时 UI 更新）
  → PostHog 分析事件
```

**Agent 模板** (`server/internal/agenttmpl/`)：预设如 "coding"、"planning"、"writing"、"assistant"，为新 agent 填充默认 instructions。

---

## 4. Agent 状态管理

Agent 的 `status` **不手动设置**，而是通过 `TaskService.ReconcileAgentStatus`（`service/task.go:1510`）从活跃任务集推导：

```go
// DB 函数 RefreshAgentStatusFromTasks:
// 检查该 agent 是否有 queued/dispatched/running 的任务
// 有 → "working"，无 → "idle"
```

**归档/恢复：** 软删除 agent 时会同时取消其所有活跃任务（`handler/agent.go:753-794`），归档后可恢复。

---

## 5. 三层通信架构

### 5a. HTTP REST（daemon ↔ server）

**文件:** `server/internal/daemon/client.go`

| 端点 | 用途 |
|------|------|
| `POST /api/daemon/runtimes/{id}/tasks/claim` | 认领下一个任务 |
| `POST /api/daemon/tasks/{id}/start` | 标记任务运行中 |
| `POST /api/daemon/tasks/{id}/progress` | 报告进度 |
| `POST /api/daemon/tasks/{id}/messages` | 流式传输 agent 消息（工具调用、文本、思考） |
| `POST /api/daemon/tasks/{id}/complete` | 报告完成 |
| `POST /api/daemon/tasks/{id}/fail` | 报告失败 |
| `POST /api/daemon/heartbeat` | 保活 + 接收待处理动作 |
| `POST /api/daemon/register` | 注册 runtime |
| `POST /api/daemon/recover-orphans/{runtimeId}` | 启动时恢复孤儿任务 |

### 5b. WebSocket（server → browser）

**文件:** `server/internal/realtime/hub.go`

浏览器通过 WebSocket 接收实时事件。事件通过进程内 `events.Bus` 发布，扇出到已连接客户端。Redis relay 支持多节点部署。

**事件类型** (`server/pkg/protocol/events.go`):
- `agent:status`, `agent:created`, `agent:archived`, `agent:restored`
- `task:queued`, `task:dispatch`, `task:progress`, `task:completed`, `task:failed`, `task:message`, `task:cancelled`

### 5c. WebSocket（server ↔ daemon）

**文件:** `server/internal/daemonws/hub.go`

Daemon 保持持久 WebSocket 连接，用于：
- 心跳（WS 连接时替代 HTTP 心跳）
- 任务唤醒通知（server 推送 `daemon:task_available`，daemon 无需等待轮询间隔）
- 待处理动作下发（CLI 更新、模型列表请求、skill 导入）

### 5d. 进程内事件总线

**文件:** `server/internal/events/bus.go`

同步 pub/sub。`Bus.Publish` 时所有注册 handler 按序同步执行。handler panic 会被 recover，不影响其他 handler。

---

## 6. 任务生命周期（核心）

**文件:** `server/internal/service/task.go`

状态机：

```
(empty) → queued → dispatched → running → completed
                                running → failed
                                running → cancelled
                dispatched → failed (超时 300s)
```

### 6a. 任务入队

6 个入口（均在 `service/task.go`）：

| 入口 | 行号 | 触发场景 |
|------|------|----------|
| `EnqueueTaskForIssue` | 376 | issue 分配给 agent |
| `EnqueueTaskForMention` | 443 | 评论中 @提及 agent |
| `EnqueueTaskForSquadLeader` | 453 | squad leader 委派 |
| `EnqueueChatTask` | 594 | 聊天消息 |
| `EnqueueQuickCreateTask` | 536 | 自然语言快速创建 |
| `MaybeRetryFailedTask` | 1253 | 基础设施故障自动重试 |

每个入队路径：
1. 验证 agent 未归档且有 runtime
2. 创建 `queued` 行
3. 广播 `task:queued` 事件
4. 通过 WebSocket 唤醒 daemon + 使空缓存失效

### 6b. 任务认领

**Server 端:** `TaskService.ClaimTask`（line 735）和 `ClaimTaskForRuntime`（line 807）

原子操作：检查 `max_concurrent_tasks`，然后 `ClaimAgentTask`（SQL UPDATE 原子地将 queued → dispatched）。`EmptyClaimCache`（Redis）在稳态空情况下避免 Postgres 扫描。

**Daemon 端:** `Daemon.runRuntimePoller`（line 1821）

每个 runtime 有独立的 poller goroutine：
1. 从并发信号量获取执行槽
2. `tryEnterClaim()`（尊重自动更新屏障）
3. HTTP POST 认领任务
4. 成功则在新 goroutine 中启动 `handleTask`

### 6c. 任务执行

**`Daemon.handleTask`**（line 1975）：
1. `StartTask`（queued → running）
2. 报告进度
3. 启动取消监视器（每 5s 轮询 server）
4. 调用 `runTask`

**`Daemon.runTask`**（line 2171）：
1. 验证 workspace_id
2. 注册任务级 repo
3. 通过 `execenv.Prepare` 或 `execenv.Reuse` 准备隔离执行环境
4. 注入 runtime 配置（skills、instructions、agent 上下文文件）
5. `BuildPrompt` 构建提示词（`daemon/prompt.go`）
6. `agent.New(provider, config)` 创建 agent 后端（line 2366）
7. `executeAndDrain`：
   - `backend.Execute(ctx, prompt, opts)` 启动 CLI 进程
   - goroutine 排空消息通道（text、tool_use、tool_result、thinking、error、status）
   - 每 500ms 批量上报消息
   - 获取到 session ID/work dir 后立即 pin
   - 空闲看门狗：30min 无活动强制停止
   - 等待 `session.Result` 上的最终 `Result`

### 6d. 任务完成

**`Daemon.reportTaskResult`**（line 2103）：
- `completed` → `CompleteTask`（写结果、在 issue 上创建 agent 评论、广播事件）
- `blocked`/`timeout`/`idle_watchdog` → `FailTask` + 对应 `failure_reason`
- `cancelled` → 丢弃（已由取消监视器处理）

**`TaskService.CompleteTask`**（line 935）：
- 事务内：标记完成 + 更新 chat session resume 指针
- issue 任务：确保至少一条 agent 评论
- 快速创建任务：关联新 issue + 发送 inbox 通知
- 聊天任务：保存助手回复、广播 `chat:done`
- 推导 agent 状态

### 6e. 失败与自动重试

**`TaskService.FailTask`**（line 1113）：
- 标记失败 + 错误信息 + failure_reason
- 调用 `MaybeRetryFailedTask`
- 创建系统评论 / 失败聊天消息
- 推导 agent 状态、广播 `task:failed`

**自动重试**（`MaybeRetryFailedTask`，line 1253）：仅限基础设施故障（`runtime_offline`、`runtime_recovery`、`timeout`）。创建子任务继承父任务的 session_id 和 work_dir。跳过 autopilot 任务。强制 `attempt < max_attempts`。

---

## 7. Daemon 状态管理

**文件:** `server/internal/daemon/daemon.go:81`（`Daemon` struct）

| 字段 | 类型 | 说明 |
|------|------|------|
| `workspaces` | map | 每 workspace 的 runtime、repo 白名单、设置 |
| `runtimeIndex` | map | runtime ID → Runtime，用于 provider 查找 |
| `agentVersions` | map | provider → 检测到的 CLI 版本 |
| `wsHBLastAck` | map | runtime ID → 最后 WebSocket 心跳时间戳 |
| `activeTasks` | atomic | 当前运行任务数 |
| `activeEnvRoots` | map | 引用计数的环境根目录（防止 GC） |
| `claimMu` / `pauseClaims` | mutex/bool | 自动更新屏障 |
| `runtimeGoneInflight` | map | runtime 恢复防惊群 |

---

## 8. 错误处理与恢复

### 8a. 孤儿任务恢复

**文件:** `server/internal/handler/task_lifecycle.go:17`（`RecoverOrphanedTasks`）

Daemon 启动时对每个 runtime 调用 `RecoverOrphans`：原子地将 server 仍认为属于该 runtime 的 dispatched/running 任务标记为失败，触发自动重试。

### 8b. Runtime Gone 恢复

**`Daemon.handleRuntimeGone`**（line 238）：心跳、poller、WS handler 共用的单一恢复入口。防惊群（per-runtimeID inflight set）、合并（per-workspace 下次尝试时间戳）、掉队检测。重新注册 runtime + 恢复孤儿。

### 8c. Session Resume 失败

**`Daemon.runTask`**（line 2466）：session resume 失败且 SessionID 为空时，用全新 session 重试，合并两次的 token 用量。

### 8d. 中毒输出检测

**`classifyPoisonedOutput`**（daemon.go:2534）：检测 agent 完成但输出了 fallback 标记（迭代限制、元消息）。走 `blocked` 路径，特定 `failure_reason` 使该 session 被排除出未来 resume 查找。

### 8e. 空闲看门狗

**`Daemon.runIdleWatchdog`**（line 2933）：`AgentIdleWatchdog`（默认 30min）无消息 + 无进行中工具调用 + 消息队列为空 → 强制停止。防止卡死进程。

### 8f. Server 端任务清扫

`runtime_sweeper.go`：dispatched 超过 300s 的任务标记失败；running 超过 2.5h 的任务也被清扫。

---

## 9. 多 Agent 协调模式

### 9a. Squads

**文件:** `server/internal/handler/squad.go`

Squad 将 agent（和人类）分组到一个 leader agent 下。工作分配给 squad 时：
1. leader agent 接收任务
2. leader 的 instructions 注入 "Squad Operating Protocol"
3. leader 通过创建子 issue 或评论委派给成员

DB 表：`squad`、`squad_member`（`member_type` = `"agent"` / `"member"`，`role` = `"leader"` / `"worker"`）。

`is_leader_task` 标志（migration 090）区分 leader 执行的任务和 worker 执行的任务，用于自旋锁防护。

### 9b. Squad Leader 简报

**`handler/squad_briefing.go`**：squad leader 认领任务时，daemon 将 squad 指令和成员名册注入 agent 上下文。

### 9c. @提及路由

**`service/task.go:443`**（`EnqueueTaskForMention`）：评论 @提及 agent 时，为该 agent（而非 issue 的 assignee）创建任务。多个 agent 可通过 mention 并行处理同一 issue。

### 9d. 自旋锁防护

**`CancelTasksByTriggerComment`**（line 675）：防止无限循环。agent 发布的评论如果会触发新任务，系统检查该评论是否是 agent 在处理同一 issue 时自己发布的。`is_leader_task` 标志确保 squad leader 仍可触发 worker 任务。

### 9e. 并发控制

- 每 agent `max_concurrent_tasks`（默认 6）
- 每 daemon `MaxConcurrentTasks`（默认 20，`MULTICA_DAEMON_MAX_CONCURRENT_TASKS` 环境变量配置）
- Daemon 的 `pollLoop` 中基于槽的信号量防止超额
- `ClaimTask` 中 agent 级容量检查

---

## 10. 前端状态架构

| 层 | 技术 | 职责 |
|----|------|------|
| Server state | TanStack Query | agents、tasks、issues、inbox |
| Client state | Zustand | 视图过滤、草稿、弹窗 |
| 实时更新 | WS → React Query 失效 | WS 事件触发缓存失效，不直接写 store |

**Agent 相关 store**（`packages/core/agents/`）：
- `queries.ts`：React Query hooks（CRUD）
- `stores/view-store.ts`：agent 列表视图状态
- `derive-presence.ts`：从任务快照推导 agent presence（idle/working/error）
- `use-agent-presence.ts`：组合 agent 状态 + 实时任务数据

---

## 11. 关键文件索引

| 文件 | 职责 |
|------|------|
| `server/pkg/agent/agent.go` | Agent 后端接口 + 工厂（11 种 provider） |
| `server/internal/daemon/daemon.go` | 核心 daemon：轮询、执行、心跳、恢复 |
| `server/internal/daemon/config.go` | Daemon 配置（环境变量、CLI 标志、默认值） |
| `server/internal/daemon/client.go` | Daemon→Server HTTP 客户端 |
| `server/internal/daemon/types.go` | Task、Runtime、AgentData、TaskResult 类型 |
| `server/internal/daemon/prompt.go` | 不同任务类型的提示词构建 |
| `server/internal/daemon/execenv/` | 执行环境准备（worktree、git、skills） |
| `server/internal/service/task.go` | TaskService：入队、认领、完成、失败、重试、取消 |
| `server/internal/handler/agent.go` | Agent REST API handler |
| `server/internal/handler/task_lifecycle.go` | 孤儿恢复、session pinning、issue 重跑 |
| `server/internal/handler/squad.go` | Squad CRUD |
| `server/internal/events/bus.go` | 进程内事件总线 |
| `server/internal/realtime/hub.go` | 浏览器 WebSocket hub |
| `server/internal/daemonws/hub.go` | Daemon WebSocket hub |
| `server/pkg/protocol/events.go` | 事件类型常量 |
| `server/pkg/protocol/messages.go` | WebSocket 消息载荷 |
| `server/pkg/db/queries/agent.sql` | Agent + task SQL 查询 |
| `packages/core/agents/` | 前端 agent 类型、查询、store、presence |
