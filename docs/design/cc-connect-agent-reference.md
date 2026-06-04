# cc-connect Agent 架构参考

> 记录时间: 2026-06-03 | 参考项目: D:\ai全栈挑战赛\cc-connect

本文档记录 cc-connect 在 Agent 架构方面值得 agenthub 借鉴的技术手段，包含具体实现位置和现有差距分析。

---

## 1. 可选接口模式

### 技术手段

cc-connect 定义了一个核心接口 `Agent` + `AgentSession`，其余 20+ 个能力全部是可选接口。Agent 只需实现核心接口即可运行，其他能力按需实现。Engine 在运行时通过 Go 类型断言（`interface.(Type)`）检测 Agent 是否实现了某个可选接口，有就调用，没有就跳过。

可选接口包括：
- `ProviderSwitcher` — 运行时切换供应商
- `ModelSwitcher` — 运行时切模型
- `ModeSwitcher` — 运行时切权限模式
- `WorkDirSwitcher` — 运行时切工作目录
- `MemoryFileProvider` — 暴露指令文件路径（CLAUDE.md 等）
- `ContextCompressor` — 上下文压缩命令
- `ToolAuthorizer` — 动态工具授权
- `UsageReporter` — 配额用量查询
- `HistoryProvider` — 会话历史查询
- `ReasoningEffortSwitcher` — 推理强度切换

### 参考位置

| 文件 | 行号 | 内容 |
|------|------|------|
| `core/interfaces.go` | 276-283 | `Agent` 核心接口定义 |
| `core/interfaces.go` | 286-299 | `AgentSession` 核心接口定义 |
| `core/interfaces.go` | 335-340 | `ProviderSwitcher` 可选接口 |
| `core/interfaces.go` | 345-348 | `MemoryFileProvider` 可选接口 |
| `core/interfaces.go` | 352-358 | `ModelSwitcher` 可选接口 |
| `core/interfaces.go` | 443-445 | `ContextCompressor` 可选接口 |
| `core/interfaces.go` | 474-477 | `WorkDirSwitcher` 可选接口 |
| `core/interfaces.go` | 491-495 | `ModeSwitcher` 可选接口 |

### 现有差距

agenthub 的 `AgentAdapter` 接口只有 3 个方法：

```typescript
// src/lib/adapter/types.ts:41-45
export interface AgentAdapter {
  connect(config: AdapterConfig): Promise<void>
  send(task: AgentTask): AsyncIterable<StreamChunk>
  close(): Promise<void>
}
```

没有切模型、切供应商、压缩上下文等可选能力的接口定义。如果未来需要"Agent 运行时切模型"这类功能，需要在 `AgentAdapter` 上扩展，或者参考 cc-connect 的可选接口模式拆分。

---

## 2. 工厂注册模式

### 技术手段

每个 Agent 包在 Go 的 `init()` 函数中自动注册到全局 registry：

```go
// agent/claudecode/claudecode.go:23-24
func init() {
    core.RegisterAgent("claudecode", New)
}
```

registry 是一个简单的 map：

```go
// core/registry.go:13
agentFactories = make(map[string]AgentFactory)
```

main 入口只需 `_ "agent/claudecode"` 空导入，Agent 就自动注册。新增 Agent 不改核心代码。

### 参考位置

| 文件 | 行号 | 内容 |
|------|------|------|
| `core/registry.go` | 8-9 | `AgentFactory` 类型定义 |
| `core/registry.go` | 13 | `agentFactories` 全局 map |
| `core/registry.go` | 20-22 | `RegisterAgent()` 注册函数 |
| `core/registry.go` | 52-62 | `CreateAgent()` 工厂函数 |
| `agent/claudecode/claudecode.go` | 23-24 | claudecode 自注册示例 |

### 现有差距

agenthub 的适配器是硬编码的 if-else：

```typescript
// src/lib/adapter/index.ts:9-15
if (platform === 'llm') return new LLMAdapter()
if (platform === 'claude-code') return new ClaudeCodeAdapter()
if (platform === 'opencode') return new OpenCodeAdapter()
return new LLMAdapter()
```

每新增一个适配器都要改这个文件。如果要做成注册模式，每个适配器导出时自己注册，`index.ts` 只做查询。

---

## 3. Session TryLock（非阻塞锁）

### 技术手段

Session 内部维护一个 `busy` 标志位，通过 `TryLock()` 非阻塞获取锁。用户连续发消息时，第 1 条拿到锁开始处理，后续消息进入队列等待，不会并发执行导致状态混乱。

```go
// core/session.go:29-40
busy bool       `json:"-"`

func (s *Session) TryLock() bool {
    s.mu.Lock()
    defer s.mu.Unlock()
    if s.busy {
        return false
    }
    s.busy = true
    return true
}
```

### 参考位置

| 文件 | 行号 | 内容 |
|------|------|------|
| `core/session.go` | 29 | `busy` 字段定义 |
| `core/session.go` | 32-40 | `TryLock()` 实现 |
| `core/session.go` | 43-48 | `Busy()` 查询方法 |
| `core/session.go` | 50-65 | `Unlock()` / `UnlockWithoutUpdate()` |

### 现有差距

agenthub 没有进程内锁机制。Session 状态通过数据库字段标记（`SessionMember.status`），两个请求同时到达同一 Session 时，可能同时读到 `idle` 状态并同时开始处理，产生竞态条件。当前 `chat/route.ts` 是 Next.js API Route，每个请求独立执行，没有跨请求的互斥。

---

## 4. PastAgentSessionIDs（Session ID 历史追踪）

### 技术手段

Session 记录当前和所有历史的 Agent Session ID。切换 Agent 或执行 `/new` 时，旧 ID 存入 `PastAgentSessionIDs` 数组而非丢弃。这样系统能识别哪些 session 是自己创建的（包括已切走的），不会把用户手动 CLI 创建的 session 混进来。

```go
// core/session.go:22-23
AgentSessionID      string
PastAgentSessionIDs []string
```

切换时自动记录：

```go
// core/session.go:80-89
func (s *Session) recordPastAgentSessionID() {
    if s.AgentSessionID == "" || s.AgentSessionID == ContinueSession {
        return
    }
    for _, past := range s.PastAgentSessionIDs {
        if past == s.AgentSessionID {
            return  // 去重
        }
    }
    s.PastAgentSessionIDs = append(s.PastAgentSessionIDs, s.AgentSessionID)
}
```

### 参考位置

| 文件 | 行号 | 内容 |
|------|------|------|
| `core/session.go` | 22-23 | `AgentSessionID` + `PastAgentSessionIDs` 字段 |
| `core/session.go` | 77-89 | `recordPastAgentSessionID()` 实现 |
| `core/session.go` | 92-105 | `SetAgentInfo()` 切换时自动记录 |
| `core/session.go` | 139-152 | `SetAgentSessionID()` 切换时自动记录 |
| `core/session.go` | 469-487 | `KnownAgentSessionIDs()` 汇总当前+历史 ID |

### 现有差距

agenthub 的 Session 只存一个 `sessionId`：

```typescript
// prisma/schema.prisma — Session 模型
sessionId   String?   // 只有一个
```

Agent 切换后旧 sessionId 被覆盖，无法追溯历史。如果需要做"列出此 Session 关联过的所有 Agent 会话"这类功能，需要加历史追踪。

---

## 5. Hook 事件系统

### 技术手段

cc-connect 定义了 7 种生命周期事件，通过 `HookManager` 分发给配置的 hook handler。支持 shell 命令和 HTTP webhook 两种执行方式，支持同步/异步执行。

事件类型：
- `message.received` — 收到用户消息
- `message.sent` — 发送回复
- `session.started` — 会话开始
- `session.ended` — 会话结束
- `cron.triggered` — 定时任务触发
- `permission.requested` — 权限请求
- `error` — 错误发生

### 参考位置

| 文件 | 行号 | 内容 |
|------|------|------|
| `core/hooks.go` | 18-27 | `HookEventType` 7 种事件常量 |
| `core/hooks.go` | 39-46 | `HookConfig` 配置结构 |
| `core/hooks.go` | 64-74 | `HookEvent` 事件载荷 |
| `core/hooks.go` | 77-82 | `HookManager` 管理器 |
| `core/hooks.go` | 124-148 | `Emit()` 事件分发 |
| `core/hooks.go` | 168-191 | `executeCommand()` shell hook 执行 |
| `core/hooks.go` | 193-234 | `executeHTTP()` HTTP webhook 执行 |
| `core/hooks.go` | 237-262 | `eventToEnv()` 事件转环境变量 |

### 现有差距

agenthub 没有任何事件系统。Agent 执行过程中的状态变化（开始、结束、出错、权限请求）没有对外通知机制。如果要做"Agent 出错自动告警"或"执行完成触发后续流程"，需要从零搭建。

---

## 6. Streaming Preview 节流

### 技术手段

Agent 输出流不是每个 chunk 都推给前端，而是通过三个参数控制推送频率：

- `IntervalMs`（默认 1500ms）— 最小更新间隔
- `MinDeltaChars`（默认 30）— 最少新增字符数才触发更新
- `MaxChars`（默认 2000）— 预览最大长度

两个条件同时满足才推送：距上次更新 ≥ 1500ms **且** 新增字符 ≥ 30。

### 参考位置

| 文件 | 行号 | 内容 |
|------|------|------|
| `core/streaming.go` | 12-18 | `StreamPreviewCfg` 配置结构 |
| `core/streaming.go` | 22-29 | `DefaultStreamPreviewCfg()` 默认值 |
| `core/streaming.go` | 34-53 | `streamPreview` 状态管理结构 |
| `core/streaming.go` | 154 | `MaxChars` 截断逻辑 |
| `core/streaming.go` | 161 | `IntervalMs` 间隔检查 |
| `core/streaming.go` | 163 | `MinDeltaChars` 字符数检查 |

### 现有差距

agenthub 的 SSE 流式输出没有节流机制。`chat/route.ts` 中每个从 CLI 适配器收到的 chunk 都立即通过 SSE 推送给前端。高频场景下（Agent 快速输出大量文本），前端可能收到大量微小更新，导致渲染压力。

---

## 7. 两阶段优雅关闭

### 技术手段

关闭 Agent 进程分三个阶段：

1. **Phase 1**：关闭 stdin → 等待进程自然退出（触发 Stop hooks），超时 120 秒
2. **Phase 2**：发送 SIGTERM 到整个进程组
3. **Phase 3**：再超时后发送 SIGKILL 强制终止

```go
// agent/claudecode/session.go:46-51
gracefulStopTimeout time.Duration  // 默认 120s
```

### 参考位置

| 文件 | 行号 | 内容 |
|------|------|------|
| `agent/claudecode/session.go` | 46-51 | `gracefulStopTimeout` 字段定义 |
| `agent/claudecode/session.go` | 211 | 默认 120s 超时设置 |
| `agent/claudecode/session.go` | 705-739 | `Close()` 三阶段实现：stdin close → SIGTERM → SIGKILL |

### 现有差距

agenthub 的 `ProcessRegistry.gracefulShutdown()` 只有两阶段：

```typescript
// src/lib/adapter/process-registry.ts:689-733
// Phase 1: SIGTERM
// Phase 2: 5s 后 SIGKILL
```

缺少 stdin close 阶段。直接发 SIGTERM 意味着 Agent 进程没有机会执行清理逻辑（如保存状态、完成当前写入）。如果 CLI 工具支持通过 stdin close 触发优雅退出，加上这个阶段可以减少数据丢失风险。

---

## 8. 环境变量占位符

### 技术手段

config.toml 中支持 `${ENV_VAR}` 占位符，运行时自动替换为系统环境变量的值。敏感信息（API Key 等）不写明文，配置文件可安全存入版本控制。

```go
// config/config.go:500
var envPlaceholderPattern = regexp.MustCompile(`\$\{([A-Za-z_][A-Za-z0-9_]*)\}`)

// config/config.go:609-624
func resolveEnvPlaceholders(s string) string {
    return envPlaceholderPattern.ReplaceAllStringFunc(s, func(match string) string {
        parts := envPlaceholderPattern.FindStringSubmatch(match)
        val, ok := os.LookupEnv(parts[1])
        if !ok {
            slog.Warn("config: env var placeholder references unset variable", ...)
        }
        return val
    })
}
```

配置加载时对整个 Config 结构递归解析所有字符串字段：

```go
// config/config.go:502-504
func resolveEnvInConfig(cfg *Config) {
    resolveEnvValue(reflect.ValueOf(cfg))
}
```

### 参考位置

| 文件 | 行号 | 内容 |
|------|------|------|
| `config/config.go` | 500 | `envPlaceholderPattern` 正则 |
| `config/config.go` | 502-504 | `resolveEnvInConfig()` 入口 |
| `config/config.go` | 506-607 | `resolveEnvValue()` 递归反射解析 |
| `config/config.go` | 609-624 | `resolveEnvPlaceholders()` 单值替换 |

### 现有差距

agenthub 的 apiKey 明文存入 SQLite 数据库（`Agent.apiKey`、`Provider.apiKey` 字段）。数据库文件 `dev.db` 如果被误提交或泄露，所有 API Key 都暴露。当前没有环境变量占位符机制。

---

## 总结：优先级建议

| 优先级 | 技术 | 改动量 | 理由 |
|--------|------|--------|------|
| P0 | Session TryLock | 小 | 多用户并发场景下的基本安全保障 |
| P0 | Streaming 节流 | 小 | 高频输出时前端体验直接影响可用性 |
| P1 | 可选接口模式 | 中 | 当前只有 2 个适配器，接口改动成本低；越晚改成本越高 |
| P1 | 工厂注册模式 | 小 | 解耦适配器和路由代码 |
| P2 | Hook 事件系统 | 中 | 可观测性基础，调试和运维需要 |
| P2 | 两阶段关闭 | 小 | 在现有 gracefulShutdown 基础上加 stdin close |
| P3 | PastAgentSessionIDs | 小 | 当前场景不强需要，未来多 Agent 切换时有用 |
| P3 | 环境变量占位符 | 小 | 安全加固，非功能需求 |
