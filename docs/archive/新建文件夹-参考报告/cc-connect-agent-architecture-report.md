# CC-Connect Agent 架构 — 代码级报告

> 生成时间: 2026-06-03 | 参考项目: D:\projects\cc-connect

---

## 1. Agent 接口体系 (`core/interfaces.go`, 577行)

整个插件契约定义在一个文件中，采用 **可选接口模式**（capability detection）— Engine 通过 Go 类型断言 `agent.(SomeInterface)` 在运行时检测 Agent 是否支持某项能力。

### 核心接口（必须实现）

**`Agent`** (lines 276-283):

```go
type Agent interface {
    Name() string
    StartSession(ctx context.Context, sessionID string) (AgentSession, error)
    ListSessions(ctx context.Context) ([]AgentSessionInfo, error)
    Stop() error
}
```

**`AgentSession`** (lines 286-299):

```go
type AgentSession interface {
    Send(prompt string, images []ImageAttachment, files []FileAttachment) error
    RespondPermission(requestID string, result PermissionResult) error
    Events() <-chan Event
    CurrentSessionID() string
    Alive() bool
    Close() error
}
```

通信是双向的：`Send` 写 stdin，`Events()` 返回一个 channel 消费 Agent 输出。

### 可选 Agent 接口（20+个）

| 接口 | 行号 | 方法 | 作用 |
|------|------|------|------|
| `ProviderSwitcher` | 335-340 | SetProviders/SetActiveProvider/GetActiveProvider/ListProviders | 多供应商 API 路由 |
| `ModelSwitcher` | 352-358 | SetModel/GetModel/AvailableModels | 运行时切模型 |
| `ModeSwitcher` | 491-495 | SetMode/GetMode/PermissionModes | 权限模式切换 |
| `WorkDirSwitcher` | 472-477 | SetWorkDir/GetWorkDir | 运行时切工作目录 |
| `MemoryFileProvider` | 345-348 | ProjectMemoryFile/GlobalMemoryFile | 暴露 CLAUDE.md 路径 |
| `ContextCompressor` | 443-445 | CompressCommand | 返回压缩命令（如 "/compact"） |
| `ToolAuthorizer` | 309-312 | AddAllowedTools/GetAllowedTools | 动态工具授权 |
| `UsageReporter` | 377-379 | GetUsage | 配额用量查询 |
| `ContextUsageReporter` | 418-420 | GetContextUsage | 上下文窗口消耗 |
| `HistoryProvider` | 316-318 | GetSessionHistory | 会话历史查询 |
| `ReasoningEffortSwitcher` | 362-366 | SetReasoningEffort/GetReasoningEffort/AvailableReasoningEfforts | 推理强度控制 |
| `SessionDeleter` | 463-465 | DeleteSession | 删除后端 session 文件 |
| `SessionTitleProvider` | 467-469 | GetSessionTitle | session 显示名 |
| `CommandProvider` | 450-452 | CommandDirs | 自定义斜杠命令目录 |
| `SkillProvider` | 458-460 | SkillDirs | 技能定义目录 |
| `AgentOptsProvider` | 485-488 | BaseOpts | 多工作区 Agent 克隆选项 |
| `WorkspaceAgentOptionSnapshotter` | 501-504 | WorkspaceAgentOptions | 导出构造选项用于 per-workspace 克隆 |
| `SystemPromptSupporter` | 154-156 | HasSystemPromptSupport | 标记：Agent 原生注入系统提示 |
| `SessionEnvInjector` | 47-49 | SetSessionEnv | 注入 per-session 环境变量 |
| `PlatformPromptInjector` | 61-63 | SetPlatformPrompt | 平台特定提示片段 |
| `LiveModeSwitcher` | 508-510 | SetLiveMode | 热切换权限模式（不重启） |

### 可选 Platform 接口（30+个）

| 接口 | 行号 | 方法 | 作用 |
|------|------|------|------|
| `TypingIndicator` | 162-164 | StartTyping | 显示输入中气泡 |
| `TypingIndicatorDone` | 170-172 | AddDoneReaction | 完成反应 |
| `ImageSender` | 175-177 | SendImage | 图片投递 |
| `FileSender` | 180-182 | SendFile | 文件投递 |
| `MessageUpdater` | 185-187 | UpdateMessage | 消息原地编辑 |
| `InlineButtonSender` | 217-219 | SendWithButtons | 可点击内联按钮 |
| `CardSender` | 224-227 | SendCard/ReplyCard | 富卡片消息 |
| `CardNavigable` | 237-238 | SetCardNavigationHandler | 卡片原地导航 |
| `CardRefresher` | 246-248 | RefreshCard | 异步卡片刷新 |
| `StreamingCardPlatform` | 558-560 | CreateStreamingCard | 聚合回合卡片 |
| `PreviewStarter` | 92-97 | SendPreviewStart | 发起流式预览消息 |
| `PreviewCleaner` | 102-104 | DeletePreviewMessage | 最终发送后清理预览 |
| `PreviewFinishPreference` | 108-110 | KeepPreviewOnFinish | 保留预览作为最终消息 |
| `PreviewStatusUpdater` | 574-576 | SetPreviewStatus | 更新卡片头部状态 |
| `RichCardSupporter` | 80-82 | BuildRichCard | 原生富卡片构建 |
| `ReplyContextReconstructor` | 24-26 | ReconstructReplyCtx | 从 session key 重建回复上下文 |
| `CronReplyTargetResolver` | 41-43 | ResolveCronReplyTarget | 定时任务回复目标映射 |
| `MessageRecallDetector` | 30-32 | IsMessageRecalled | 检测已删除/撤回消息 |
| `FormattingInstructionProvider` | 54-56 | FormattingInstructions | 平台特定格式化提示 |
| `ProgressStyleProvider` | 192-194 | ProgressStyle | 首选进度渲染风格 |
| `CommandRegistrar` | 530-532 | RegisterCommands | 在平台菜单注册命令 |
| `ChannelNameResolver` | 536-538 | ResolveChannelName | Channel ID 转可读名称 |
| `AsyncRecoverablePlatform` | 266-269 | SetLifecycleHandler | 延迟就绪+恢复循环 |
| `ObserverTarget` | 21-23 | SendObservation | 终端 session 观察转发 |

**设计模式**：Engine 持有单一 `Agent` 值，在每个调用点通过 `if sw, ok := agent.(ModelSwitcher); ok { ... }` 类型断言检测能力。Agent 只需实现自己支持的接口，Engine 对缺失能力优雅降级。

---

## 2. 工厂注册模式 (`core/registry.go`, 63行)

### 自注册工厂

每个 Agent 包在 `init()` 中自动注册到全局 map：

```go
// core/registry.go
var agentFactories = make(map[string]AgentFactory)  // line 14

func RegisterAgent(name string, factory AgentFactory) {  // line 20
    agentFactories[name] = factory
}

func CreateAgent(name string, opts map[string]any) (Agent, error) {  // line 52
    f, ok := agentFactories[name]
    if !ok { return nil, fmt.Errorf("unknown agent: %s", name) }
    return f(opts)
}
```

Agent 包自注册示例：

```go
// agent/claudecode/claudecode.go:23-25
func init() {
    core.RegisterAgent("claudecode", New)
}
```

通过 build tag 控制编译哪些 Agent：

```go
// cmd/cc-connect/plugin_agent_claudecode.go
//go:build !no_claudecode
import _ "github.com/chenhg5/cc-connect/agent/claudecode"
```

**已注册的 12 个 Agent**：claudecode, codex, gemini, opencode, tmux, pi, qoder, devin, iflow, kimi, acp, cursor

### 关键类型

| 类型 | 行号 | 定义 |
|------|------|------|
| `PlatformFactory` | 7 | `func(opts map[string]any) (Platform, error)` |
| `AgentFactory` | 9 | `func(opts map[string]any) (Agent, error)` |
| `platformFactories` | 13 | 全局 `map[string]PlatformFactory` |
| `agentFactories` | 14 | 全局 `map[string]AgentFactory` |

---

## 3. Session 管理 (`core/session.go`, 732行)

### Session 结构体 (lines 18-30)

```go
type Session struct {
    ID, Name, AgentSessionID, AgentType string
    PastAgentSessionIDs []string
    History             []HistoryEntry
    CreatedAt, UpdatedAt time.Time
    mu   sync.Mutex
    busy bool  // line 29
}
```

### TryLock 非阻塞锁 (lines 32-40)

```go
func (s *Session) TryLock() bool {
    s.mu.Lock()
    defer s.mu.Unlock()
    if s.busy { return false }
    s.busy = true
    return true
}
```

用户连续发消息时，第 1 条拿到锁，后续消息进入队列，不会并发执行。

### PastAgentSessionIDs (lines 77-90)

切换 Agent 或 `/new` 时，旧 session ID 存入历史数组而非丢弃：

```go
func (s *Session) recordPastAgentSessionID() {
    if s.AgentSessionID == "" { return }
    for _, past := range s.PastAgentSessionIDs {
        if past == s.AgentSessionID { return }  // 去重
    }
    s.PastAgentSessionIDs = append(s.PastAgentSessionIDs, s.AgentSessionID)
}
```

`KnownAgentSessionIDs()` (line 469) 返回当前 + 所有历史 ID，用于过滤 `ListSessions()` 结果。

### SessionManager (lines 230-247)

管理多用户多 session：

| 字段 | 类型 | 作用 |
|------|------|------|
| `sessions` | `map[string]*Session` | 所有 session |
| `activeSession` | `map[string]string` | 用户当前活跃 session |
| `userSessions` | `map[string][]string` | 用户的 session 列表 |
| `sessionNames` | `map[string]string` | agent session ID 到显示名映射 |
| `userMeta` | `map[string]*UserMeta` | sessionKey 到显示信息 |
| `legacyData` | `bool` | 是否从旧格式迁移 |

### 关键方法

| 方法 | 行号 | 作用 |
|------|------|------|
| `GetOrCreateActive(userKey)` | 274 | 返回活跃 session 或创建新的 |
| `NewSession(userKey, name)` | 288 | 创建并激活新 session |
| `NewSideSession(userKey, name)` | 299 | 创建 session 但不切换活跃（用于 cron） |
| `SwitchSession(userKey, target)` | 331 | 按 ID 或名称切换活跃 session |
| `SwitchToAgentSession(userKey, agentSID)` | 350 | 查找或创建映射到 agent session ID 的 session |
| `KnownAgentSessionIDs()` | 469 | 返回所有追踪的 agent session ID 集合 |
| `InvalidateForAgent(agentType)` | 707 | Agent 类型变更时清除过期 session ID |

### 持久化

JSON 序列化 via `sessionSnapshot` (lines 218-228)。使用 `AtomicWriteFile` 崩溃安全写入。`saveLocked()` (line 575) 深拷贝避免并发竞争。

---

## 4. Hook 事件系统 (`core/hooks.go`, 275行)

### 7 种生命周期事件 (lines 20-28)

| 常量 | 值 | 触发时机 |
|------|-----|----------|
| `HookEventMessageReceived` | `"message.received"` | 收到用户消息 |
| `HookEventMessageSent` | `"message.sent"` | 发送回复 |
| `HookEventSessionStarted` | `"session.started"` | 会话开始 |
| `HookEventSessionEnded` | `"session.ended"` | 会话结束 |
| `HookEventCronTriggered` | `"cron.triggered"` | 定时任务触发 |
| `HookEventPermissionRequested` | `"permission.requested"` | 权限请求 |
| `HookEventError` | `"error"` | 错误发生 |

### HookConfig (lines 39-46)

```go
type HookConfig struct {
    Event   string   // 事件类型或 "*"
    Type    string   // "command" 或 "http"
    Command string   // shell 命令
    URL     string   // webhook URL
    Timeout int      // 超时秒数
    Async   bool     // 默认 true
}
```

### HookEvent 载荷 (lines 63-74)

```go
type HookEvent struct {
    Event      string
    Timestamp  time.Time
    Project    string
    SessionKey string
    Platform   string
    UserID     string
    UserName   string
    Content    string
    Error      string
    Extra      map[string]any
}
```

### Emit 分发 (lines 124-148)

支持 `"*"` 通配符匹配。Async hooks 在 goroutine 中执行，sync hooks 阻塞。

### executeCommand (lines 168-191)

Shell hook 通过 `sh -c` 执行，事件字段转为 `CC_HOOK_*` 环境变量：

| 环境变量 | 来源字段 |
|----------|----------|
| `CC_HOOK_EVENT` | Event |
| `CC_HOOK_PROJECT` | Project |
| `CC_HOOK_TIMESTAMP` | Timestamp |
| `CC_HOOK_SESSION_KEY` | SessionKey |
| `CC_HOOK_PLATFORM` | Platform |
| `CC_HOOK_USER_ID` | UserID |
| `CC_HOOK_USER_NAME` | UserName |
| `CC_HOOK_CONTENT` | Content |
| `CC_HOOK_ERROR` | Error |

### executeHTTP (lines 193-234)

POST JSON 到配置的 URL，Headers：
- `Content-Type: application/json`
- `User-Agent: CC-Connect-Hooks/1.0`
- `X-Hook-Event: <event_type>`

---

## 5. Streaming Preview 节流 (`core/streaming.go`, 464行)

### StreamPreviewCfg (lines 12-18)

| 参数 | 默认值 | 作用 |
|------|--------|------|
| `Enabled` | true | 全局开关 |
| `DisabledPlatforms` | [] | 禁用预览的平台列表 |
| `IntervalMs` | 1500ms | 最小更新间隔 |
| `MinDeltaChars` | 30 | 最少新增字符数 |
| `MaxChars` | 2000 | 预览最大长度 |

### streamPreview 状态结构 (lines 34-54)

关键字段：
- `fullText` — 累积的完整文本
- `lastSentText` — 上次发送的文本
- `lastSentAt` — 上次发送时间
- `previewMsgID` — 平台消息句柄
- `degraded` — 永久失败标志
- `timer`/`timerStop` — 延迟 flush 定时器

### 节流逻辑 in `appendText()` (lines 143-176)

```
1. delta < MinDeltaChars 且非首次发送 → 延迟 flush
2. elapsed < interval → 延迟到剩余时间
3. 否则立即 flush
```

`flushLocked()` (lines 206-256)：
- 首次：`PreviewStarter.SendPreviewStart`
- 后续：`MessageUpdater.UpdateMessage`
- 失败时标记 `degraded = true`

### 关键方法

| 方法 | 行号 | 作用 |
|------|------|------|
| `canPreview()` | 124 | 检查平台是否支持 MessageUpdater |
| `freeze()` | 262 | 永久停止预览（如权限提示期间） |
| `discard()` | 290 | 删除预览消息并禁用更新 |
| `finish(finalText)` | 317 | 发送最终内容，处理 PreviewCleaner/PreviewFinishPreference |
| `setStatus(status)` | 420 | 更新卡片头部状态（thinking/working/done/error） |

### 附加类型

**ToolStep** (lines 65-74)：进度行，含 Kind(tool/thinking), Name, Summary, Result, Status, ExitCode, Success, Done

**RichCardSupporter** (lines 80-82)：`BuildRichCard(status, title, steps, markdown, streaming, elapsed)`

**MarkdownTableSplitter** (lines 86-88)：`SplitMarkdownByTables(md, maxTables)`

---

## 6. Claude Code Agent 实现 (`agent/claudecode/`)

### claudecode.go (1413行)

#### 自注册 (lines 23-25)

```go
func init() {
    core.RegisterAgent("claudecode", New)
}
```

#### Agent 结构体 (lines 36-64)

字段：`workDir`, `cliBin`(默认 "claude"), `cliExtraArgs`, `configEnv`, `cliArgsFlag`, `model`, `reasoningEffort`, `mode`, `allowedTools`, `disallowedTools`, `maxContextTokens`, `providers`, `activeIdx`, `sessionEnv`, `routerURL`, `routerAPIKey`, `systemPrompt`, `providerProxy`, `proxyLocalURL`, `platformPrompt`, `spawnOpts`

#### New(opts) 工厂 (lines 115-232)

从 opts map 提取配置：`work_dir`, `cli_path`, `model`, `reasoning_effort`, `mode`, `system_prompt`, `allowed_tools`, `disallowed_tools`, `max_context_tokens`, `router_url`, `router_api_key`, `run_as_user`, `run_as_env`, `env`。验证 CLI 二进制存在（除非 `run_as_user` 隔离模式）。

#### 实现的 17 个可选接口

| 接口 | 方法 | 行号 |
|------|------|------|
| `WorkDirSwitcher` | SetWorkDir / GetWorkDir | 275 / 282 |
| `ModelSwitcher` | SetModel / GetModel / AvailableModels | 288 / 295 / 324 |
| `ReasoningEffortSwitcher` | SetReasoningEffort / GetReasoningEffort / AvailableReasoningEfforts | 301 / 308 / 314 |
| `SessionEnvInjector` | SetSessionEnv | 397 |
| `PlatformPromptInjector` | SetPlatformPrompt | 403 |
| `ModeSwitcher` | SetMode / GetMode / PermissionModes | 681 / 689 / 818 |
| `ToolAuthorizer` | AddAllowedTools / GetAllowedTools | 830 / 849 |
| `CommandProvider` | CommandDirs | 868 |
| `SkillProvider` | SkillDirs | 885 |
| `ContextCompressor` | CompressCommand (返回 "/compact") | 898 |
| `MemoryFileProvider` | ProjectMemoryFile / GlobalMemoryFile | 984 / 995 |
| `SystemPromptSupporter` | HasSystemPromptSupport (返回 true) | 1003 |
| `ProviderSwitcher` | SetProviders / SetActiveProvider / GetActiveProvider / ListProviders | 1007 / 1013 / 1032 / 1042 |
| `SessionDeleter` | DeleteSession | 504 |
| `HistoryProvider` | GetSessionHistory | 587 |
| `WorkspaceAgentOptionSnapshotter` | WorkspaceAgentOptions | 744 |
| `LiveModeSwitcher` | SetLiveMode | (session.go 683) |

#### StartSession (lines 410-445)

在锁下快照所有可变状态，然后调用 `newClaudeSession()`。

---

### session.go (791行)

#### claudeSession 结构体 (lines 30-52)

字段：`cmd`, `stdin`, `stdinMu`, `events`(channel, capacity 64), `sessionID`(atomic), `permissionMode`(atomic), `autoApprove`/`acceptEditsOnly`/`dontAsk`(atomic bools), `workDir`, `ctx`/`cancel`, `done`, `alive`(atomic), `gracefulStopTimeout`(120s)

#### 进程启动 newClaudeSession (lines 54-220)

构建 CLI 参数：
```
--output-format stream-json
--input-format stream-json
--permission-prompt-tool stdio
--replay-user-messages
--verbose
--permission-mode <mode>
--resume <sessionID>
--allowedTools <tools>
--disallowedTools <tools>
--system-prompt <prompt>
--append-system-prompt <cc-connect prompt + platform formatting>
--effort <level>
--max-context-tokens <n>
--model <model>
```

进程在独立进程组中启动（via `prepareCmdForKill(cmd)`），`Close()` 可终止整个后代树。

#### 读取循环 readLoop (lines 222-312)

goroutine 逐行扫描 stdout JSON，按 `type` 字段分发：

| type | 处理 |
|------|------|
| `"system"` | 提取 session_id，发出 EventText + SessionID |
| `"assistant"` | 遍历 content 数组：tool_use → EventToolUse, thinking → EventThinking, text → EventText |
| `"user"` | 记录 tool 错误 |
| `"result"` | 提取 result/session_id/usage，发出 EventResult (Done: true) |
| `"control_request"` | 权限请求处理：autoApprove → 自动批准, dontAsk → 自动拒绝, acceptEditsOnly → 编辑工具自动批准, 否则 → EventPermissionRequest |
| `"control_cancel_request"` | 记录取消 |

#### Send (lines 530-598)

- **纯文本**：写 JSON `{"type":"user","message":{"role":"user","content":"..."}}` 到 stdin
- **图片**：保存到 `.cc-connect/attachments/`，base64 编码为多模态 content 数组
- **文件**：通过 `core.SaveFilesToDisk()` 保存到磁盘，在文本提示中引用路径

#### RespondPermission (lines 614-651)

写 `{"type":"control_response","response":{"subtype":"success","request_id":"...","response":{"behavior":"allow|deny",...}}}` 到 stdin。

#### 三阶段关闭 Close (lines 705-747)

| 阶段 | 动作 | 超时 |
|------|------|------|
| Phase 1 | 关 stdin（信号 EOF），Claude Code 优雅退出，执行 Stop hooks | 120s |
| Phase 2 | SIGTERM 整个进程组 | 5s |
| Phase 3 | SIGKILL 整个进程组 | 立即 |

#### LiveModeSwitcher (lines 683-690)

`SetLiveMode` 原子更新权限模式标志，无需重启。auto/plan 模式返回 false（不可热切换）。

---

## 7. 消息/事件类型 (`core/message.go`, 248行)

### EventType 常量 (lines 187-195)

| 常量 | 值 | 含义 |
|------|-----|------|
| `EventText` | `"text"` | 中间或最终文本 |
| `EventToolUse` | `"tool_use"` | 工具调用 |
| `EventToolResult` | `"tool_result"` | 工具结果 |
| `EventResult` | `"result"` | 最终聚合结果 |
| `EventError` | `"error"` | 错误 |
| `EventPermissionRequest` | `"permission_request"` | 权限请求（via stdio） |
| `EventThinking` | `"thinking"` | 思考/处理状态 |

### Event 结构体 (lines 212-231)

```go
type Event struct {
    Type          EventType
    Content       string
    ToolName      string
    ToolInput     map[string]any
    ToolInputRaw  json.RawMessage
    ToolResult    string
    ToolStatus    string
    ToolExitCode  *int
    ToolSuccess   *bool
    SessionID     string
    RequestID     string
    Questions     []UserQuestion
    Done          bool
    Error         string
    InputTokens   int
    OutputTokens  int
    Metadata      map[string]any
    Synthetic     bool
}
```

### Message 结构体 (lines 163-182)

统一入站消息：`SessionKey`, `Platform`, `MessageID`, `Recalled`, `ChannelID`, `UserID`, `UserName`, `ChatName`, `Content`, `Images`, `Files`, `Audio`, `Location`, `ExtraContent`, `ChannelKey`, `ReplyCtx`, `FromVoice`, `ModeOverride`

### 支持类型

| 类型 | 行号 | 字段 |
|------|------|------|
| `ImageAttachment` | 68-72 | MimeType, Data, FileName |
| `FileAttachment` | 75-79 | MimeType, Data, FileName |
| `AudioAttachment` | 145-150 | MimeType, Data, Format, Duration |
| `LocationAttachment` | 153-160 | Latitude, Longitude, accuracy |
| `HistoryEntry` | 234-238 | Role, Content, Timestamp |
| `AgentSessionInfo` | 241-247 | ID, Summary, MessageCount, ModifiedAt, GitBranch |
| `UserQuestion` | 198-203 | 结构化问题 |
| `UserQuestionOption` | 206-209 | 问题选项 |
| `PermissionResult` | 302-306 | Behavior(allow/deny), UpdatedInput, Message |

---

## 8. Config 与 Provider 管理 (`config/config.go`, 1243+行)

### Config 结构体 (lines 85-120)

顶层 TOML 配置：`DataDir`, `Providers`(全局), `Projects`, `Commands`, `Aliases`, `BannedWords`, `Log`, `Language`, `Speech`, `TTS`, `Display`, `StreamPreview`, `InstantReply`, `RateLimit`, `OutgoingRateLimit`, `Relay`, `Cron`, `Queue`, `Webhook`, `Bridge`, `Management`, `Hooks`, `IdleTimeoutMins`, `WorkspaceIdleTimeoutMins`

### ProjectConfig (lines 331-403)

每项目配置：`Name`, `Mode`("" 或 "multi-workspace"), `BaseDir`, `Agent`(type + options + providers), `Platforms`, `Heartbeat`, `AutoCompress`, `RunAsUser`, `RunAsEnv`, `Display` 覆盖, `Observe`, `References`, `FilterExternalSessions`

### AgentConfig (lines 405-410)

```go
type AgentConfig struct {
    Type        string
    Options     map[string]any
    ProviderRefs []string
    Providers   []ProviderConfig
}
```

### ProviderConfig (lines 419-432)

```go
type ProviderConfig struct {
    Name           string
    APIKey         string
    BaseURL        string
    Model          string
    Models         []string
    Thinking       bool
    Env            map[string]string
    AgentTypes     []string
    Endpoints      map[string]string      // per-agent-type base URL
    AgentModels    map[string]string      // per-agent-type model
    AgentModelLists map[string][]string   // per-agent-type model list
    Codex          *CodexProviderConfig
}
```

### 环境变量占位符 (lines 500-625)

```go
var envPlaceholderPattern = regexp.MustCompile(`\$\{([A-Za-z_][A-Za-z0-9_]*)\}`)  // line 500

func resolveEnvInConfig(cfg *Config) {  // line 502
    resolveEnvValue(reflect.ValueOf(cfg))
}
```

通过反射递归遍历整个 Config 结构体，将 `${VAR_NAME}` 替换为 `os.LookupEnv` 值。支持 secrets 管理。

### ResolveProviderRefs (lines 1143-1180)

将全局 `[[providers]]` 合并到项目级 `Agent.Providers`，按 `ProviderRefs` 名称匹配。内联项目级优先。

### ResolveForAgent (lines 1184-1195)

应用 per-agent-type 覆盖：`Endpoints`, `AgentModels`, `AgentModelLists`。

### Load (lines 466-498)

读 TOML → 解析环境变量占位符 → 设置 DataDir/AttachmentSend 默认值 → 调用 ResolveProviderRefs() → 验证。

---

## 9. Engine 核心 (`core/engine.go`, 13000+行)

### Engine 结构体 (lines 166-276)

关键字段：
- `name` (项目名), `agent` (Agent), `platforms` ([]Platform)
- `sessions` (*SessionManager), `ctx`/`cancel`
- `i18n`, `speech`, `tts`, `display`, `streamPreview`, `instantReply`, `references`
- `hooks` (*HookManager), `cronScheduler`, `heartbeatScheduler`
- `commands` (*CommandRegistry), `skills` (*SkillRegistry), `aliases`
- `rateLimiter`, `outgoingRL`
- `interactiveStates` (map[string]*interactiveState) — per-session 运行状态
- `multiWorkspace`, `baseDir`, `workspaceBindings`, `workspacePool`

### NewEngine (lines 412-449)

创建 Engine → 初始化默认值 → `sessions.InvalidateForAgent(ag.Name())` → 通过类型断言检测 `CommandProvider`/`SkillProvider`

### Start (lines 1522-1564)

遍历平台 → `p.Start(e.handleMessage)` → 对 `AsyncRecoverablePlatform` 设置生命周期处理器 → 启动终端 observer

### handleMessage (lines 1906+)

主消息路由流程：

```
1. 处理消息撤回
2. 触发 HookEventMessageReceived
3. 语音转写
4. 别名解析
5. 限流 + 敏感词检查
6. 多工作区解析（解析工作区 → 创建 per-workspace agent）
7. 斜杠命令处理
8. Agent 处理
```

### 50+ 处类型断言

```go
// getOrCreateInteractiveStateWith (line 2839+)
if inj, ok := agent.(SessionEnvInjector); ok {
    inj.SetSessionEnv(envVars)
}
if ppi, ok := agent.(PlatformPromptInjector); ok {
    ppi.SetPlatformPrompt(prompt)
}
```

### interactiveState (lines 305-337)

per-session 运行状态：`agentSession`, `platform`, `replyCtx`, `pendingMessages`(队列等待中), `approveAll`, `pending`(权限请求), `deleteMode`, `modelSwitch`, `pendingProviderAdd`, `unsolicitedCancel`/`unsolicitedDone`(后台事件读取器), `eventsNeedResync`

### 多工作区 getOrCreateWorkspaceAgent (lines 2708-2793)

懒创建 per-workspace Agent 实例：
1. 从 `WorkspaceAgentOptionSnapshotter` 获取基础选项
2. 设置 `work_dir` 为工作区路径
3. 从父 Agent 复制 model, mode, run_as_user, run_as_env
4. 通过注册表 `CreateAgent(e.agent.Name(), opts)` 创建
5. 从父 `ProviderSwitcher` 接线 providers
6. 创建 per-workspace `SessionManager`（哈希文件名）

---

## 10. 其他 Agent 相关文件

| 文件 | 行数 | 作用 |
|------|------|------|
| `core/provider.go` | 36 | GetProviderModels/GetProviderModel/SetProviderModel 辅助函数 |
| `core/provider_presets.go` | 100+ | ProviderPreset，远程预设获取（GitHub 缓存 6h，Gitee 兜底） |
| `core/providerproxy.go` | - | 本地反向代理，为需要 thinking 参数重写的第三方 provider 服务 |
| `core/observer.go` | 265 | sessionObserver 监听 Claude Code JSONL 日志，转发给 ObserverTarget |
| `core/command.go` | 100+ | CommandRegistry，支持 prompt 模板和 shell exec 命令，扫描 .md 文件 |
| `core/card.go` | 100+ | Card 结构体，富卡片（CardMarkdown, CardDivider, CardActions, CardNote 等） |
| `core/heartbeat.go` | - | HeartbeatScheduler 定时心跳消息 |
| `core/cron.go` | - | CronScheduler 定时任务执行 |
| `core/relay.go` | - | RelayManager bot 间通信 |
| `core/workspace_binding.go` | - | WorkspaceBindingManager channel 到工作区映射 |
| `core/workspace_state.go` | - | ProjectStateStore 持久化工作区目录覆盖 |

---

## 11. 完整 Agent 生命周期

```
┌─────────────────────────────────────────────────────────────────┐
│ 1. 配置加载                                                      │
│    config.Load(path) → 读 TOML → 解析 ${ENV_VAR}               │
│    → ResolveProviderRefs() 合并全局 provider                     │
├─────────────────────────────────────────────────────────────────┤
│ 2. Agent 创建                                                    │
│    core.CreateAgent("claudecode", opts)                         │
│    → 查找注册表 → 调用 New(opts) → 返回 Agent + 17个可选接口     │
├─────────────────────────────────────────────────────────────────┤
│ 3. Engine 构造                                                   │
│    core.NewEngine(name, agent, platforms, storePath, lang)      │
│    → 初始化 SessionManager → 检测 CommandProvider/SkillProvider  │
│    → InvalidateForAgent() 清除过期 session ID                    │
├─────────────────────────────────────────────────────────────────┤
│ 4. 平台启动                                                      │
│    engine.Start() → 遍历 platforms → p.Start(handleMessage)     │
│    → AsyncRecoverablePlatform 设置生命周期处理器                  │
│    → 启动 terminal observer                                      │
├─────────────────────────────────────────────────────────────────┤
│ 5. 消息到达                                                      │
│    platform → handleMessage(p, msg)                             │
│    → HookEventMessageReceived → 语音转写 → 别名解析              │
│    → 限流 → 多工作区解析 → 斜杠命令 → Agent 处理                 │
├─────────────────────────────────────────────────────────────────┤
│ 6. Session 创建/恢复                                              │
│    getOrCreateInteractiveStateWith                              │
│    → 检查现有 session 是否匹配 → 不匹配则销毁重建                 │
│    → SessionEnvInjector.SetSessionEnv()                         │
│    → PlatformPromptInjector.SetPlatformPrompt()                 │
│    → agent.StartSession(ctx, sessionID) → 启动 CLI 进程         │
├─────────────────────────────────────────────────────────────────┤
│ 7. 消息处理                                                      │
│    session.Send(prompt, images, files) → 写 JSON 到 stdin       │
│    → 事件循环: EventText → streaming preview                     │
│              EventToolUse → 进度展示                             │
│              EventThinking → 思考指示器                          │
│              EventPermissionRequest → 转发给用户 → RespondPerm   │
│              EventResult → 最终响应 → 解锁 session               │
├─────────────────────────────────────────────────────────────────┤
│ 8. Streaming Preview                                             │
│    streamPreview.appendText() → 节流（1500ms + 30字符）          │
│    → 首次: SendPreviewStart → 后续: UpdateMessage                │
│    → finish(): 发送最终内容                                      │
├─────────────────────────────────────────────────────────────────┤
│ 9. 空闲/重置                                                     │
│    EventResult 后检查 resetOnIdle → 超时则下次消息新建 session    │
│    → 自动压缩：token 估计超阈值触发                               │
├─────────────────────────────────────────────────────────────────┤
│ 10. 关闭                                                         │
│    engine.Stop() → 设置 stopping 标志 → 取消 context             │
│    → 停止 observer → 遍历 platforms p.Stop()                    │
│    → 关闭所有 session: stdin close → SIGTERM(120s) → SIGKILL    │
│    → agent.Stop()                                               │
└─────────────────────────────────────────────────────────────────┘
```

---

## 12. 设计模式总结

| 模式 | 核心机制 | agenthub 现状 | 差距 |
|------|----------|--------------|------|
| 自注册工厂 | init() + RegisterAgent() + build tag | 硬编码 if-else | 每新增适配器改路由代码 |
| 可选接口 | 50+ 类型断言 | 无（3 方法 AgentAdapter） | 无切模型/切供应商等能力接口 |
| Session 管理 | TryLock + PastIDs + JSON 持久化 | 数据库 status 字段无互斥 | 并发竞态条件风险 |
| 事件驱动 | <-chan Event, buffered channel | 无事件系统 | 无结构化执行日志 |
| Hook 系统 | 7 种事件 + shell/HTTP + 环境变量注入 | 无 | 无可观测性 |
| Streaming 节流 | IntervalMs + MinDeltaChars + MaxChars | 无节流 | 高频输出前端渲染压力 |
| 三阶段关闭 | stdin close → SIGTERM(120s) → SIGKILL | 两阶段 SIGTERM → 5s → SIGKILL | 无 stdin close 阶段 |
| 环境变量占位符 | ${VAR} 反射递归替换 | apiKey 明文存储 | 安全风险 |
| 多工作区池 | 懒创建 + 闲置回收 + 选项快照 | 无 | 单工作区 |

---

## 13. 优先级建议

| 优先级 | 技术 | 改动量 | 理由 |
|--------|------|--------|------|
| P0 | Session TryLock | 小 | 多用户并发场景基本安全保障 |
| P0 | Streaming 节流 | 小 | 高频输出前端体验直接影响可用性 |
| P1 | 可选接口模式 | 中 | 当前只有 2 个适配器，接口改动成本低 |
| P1 | 工厂注册模式 | 小 | 解耦适配器和路由代码 |
| P2 | Hook 事件系统 | 中 | 可观测性基础 |
| P2 | 两阶段关闭 | 小 | 加 stdin close 阶段 |
| P3 | PastAgentSessionIDs | 小 | 多 Agent 切换时有用 |
| P3 | 环境变量占位符 | 小 | 安全加固 |
