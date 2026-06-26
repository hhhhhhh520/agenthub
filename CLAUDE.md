# AgentHub — 多 Agent 协作平台

IM 风格的多 Agent 协作平台，Orchestrator 驱动任务拆解，统一适配器层，SSE 流式输出。

编码准则见全局 `~/.claude/CLAUDE.md`（Think Before Coding / Simplicity First / Surgical Changes / Goal-Driven Execution）。

## 技术栈

Next.js 16 (App Router) · TypeScript · TailwindCSS 4 · shadcn/ui · Prisma 7 + SQLite · Monaco Editor · Claude Code CLI

## 项目结构

```
src/
├── app/
│   ├── (dashboard)/           # 路由组（不影响 URL），带侧栏 layout
│   │   ├── layout.tsx         # SidebarProvider + AppSidebar
│   │   ├── page.tsx           # 首页 /（工作区概览 + 会话列表 + ChatFab）
│   │   ├── agents/            # /agents 智能体管理
│   │   └── projects/          # /projects 项目管理
│   ├── chat/page.tsx          # /chat 聊天界面（SessionSidebar + ChatArea + AgentPanel）
│   ├── api/                   # API 路由
│   ├── error.tsx              # 根错误边界（开发环境显示完整错误，生产环境通用提示）
│   ├── not-found.tsx          # 404 页面
│   └── layout.tsx             # 根 layout（ThemeProvider + Toaster + 字体 + body）
├── components/
│   ├── ui/                    # shadcn/ui 组件（含 sonner Toast）
│   ├── chat-area.tsx          # 聊天区 + SSE 流式
│   ├── session-sidebar.tsx    # 会话侧边栏
│   ├── agent-panel.tsx        # Agent 面板 + 任务看板
│   ├── chat-fab.tsx           # 右下角浮窗聊天卡片
│   ├── code-diff.tsx          # Monaco DiffEditor
│   ├── web-preview.tsx        # iframe 预览
│   └── attachment-input.tsx   # 附件上传（📎按钮 + 拖拽 + 粘贴）
├── lib/
│   ├── adapter/               # 适配器层（Claude Code CLI / LLM / OpenCode）
│   ├── orchestrator/          # 编排器（prompt + 调度 + 执行 + 超时控制）
│   ├── services/              # 业务服务层（从 chat route 拆分）
│   │   ├── chat-router.ts     # Orchestrator 决策路由 + validateDecision
│   │   ├── alignment.ts       # 对齐流程（PM确认→架构师拆解→Q&A）
│   │   ├── execution.ts       # 任务执行引擎
│   │   ├── review.ts          # 结果审查 + 纠偏 + delegate/discuss
│   │   ├── agent-factory.ts   # Agent 创建
│   │   ├── context-builder.ts # 历史上下文构建
│   │   ├── shadow-git.ts       # 影子 git 追踪 workDir 变更(不污染 workDir)
│   │   ├── sensitive-paths.ts  # 敏感路径黑名单(declaredFiles 硬失败判定)
│   │   └── schema-validator.ts # outputSchema 软校验(提取 JSON 块 + 字段名比对)
│   ├── hooks/                 # use-sessions, use-chat, use-chat-fab, use-mounted
│   ├── attachment-cleanup.ts  # 附件文件清理（unlinkSync + 孤儿清理）
│   ├── db.ts                  # Prisma 单例（WAL 模式）
│   └── utils.ts               # cn/maskApiKey/hasLoneSurrogates
└── generated/prisma/          # Prisma 生成（gitignore）
prisma/
├── schema.prisma              # Session/Agent/Task/Message/Attachment 模型
└── migrations/
```

## 关键规则

### Prisma v7（踩坑高发）

- 构造函数必须传 adapter：`new PrismaClient({ adapter })`
- 生成路径：`@/generated/prisma/client`（不是 `@prisma/client`）
- schema generator：`provider = "prisma-client"`（不是 `prisma-client-js`）
- SQLite 需要 `@prisma/adapter-libsql` + `@libsql/client`
- **外键约束**：`db.ts` 和 `mcp-server/index.ts` 都必须设 `PRAGMA foreign_keys=ON`，否则 `onDelete: Cascade` 不生效

### 数据模型（v2）

- **Session**：`projectDir`（项目目录）、`permissionMode`（`default` | `auto`）、`isPinned`/`isArchived`（置顶/归档）
- **RecentDir**：存储最近打开的目录（`path` 唯一、`lastUsed`、`useCount`）
- **Agent**：`platform`/`model`/`baseUrl`/`apiKey` 支持多供应商；`isOrchestrator` 标记 Orchestrator 特殊 Agent；默认 platform 为 `claude-code`；预设 Agent 的 model 默认为空（使用 CLI 默认模型，页面显示实际模型）
- **Provider**：已保存的服务商配置模板（`name` 唯一、`baseUrl`、`apiKey`、`model`、`category`）。Agent 选中后复制字段，不是 FK
- **Task**:`cliSessionId` 用于 CLI 会话恢复;`correctionCount` 纠偏重试计数;`trace` JSON 数组(start/error/success/correction/blocked);`result` 持久化任务交付物(跨批权威载体);`outputSchema` 架构师声明的简化 schema(JSON 字符串)
- **SessionMember**：`status`（`idle`|`working`|`done`|`error`）per-session 状态，不写 Agent.status；`cliSessionId` 存储 CLI session ID 用于会话恢复
- **Message**：`isPinned`（Pin 消息作为长期上下文，每会话最多 10 条）
- **Attachment**：用户上传的图片/文件（`messageId` 可空，先上传后关联；`sessionId` 方便孤儿清理；`onDelete: Cascade` 只删 DB 记录，需 `cleanupAttachmentFiles()` 删磁盘文件）

### Next.js 16

- 动态路由 `params` 是 `Promise`，必须 `await`
- 签名：`{ params }: { params: Promise<{ id: string }> }`
- **暗色模式**：`next-themes` ThemeProvider 在根 layout，`attribute="class"`，sonner Toaster 用 `useTheme()` 动态跟随主题
- **Toast 通知**：sonner，`import { toast } from 'sonner'`，根 layout 已挂载 `<Toaster position="bottom-right" />`

### Claude Code CLI 集成

- `--system-prompt` 被 CLI 默认系统提示覆盖，需合并到 prompt 中
- Windows 上必须用 `shell: true` + stdin 传递 prompt
- 使用 `--bare` 跳过 hooks/plugins
- **禁止使用 `--dangerously-skip-permissions`** — 会导致 CLI 卡住
- **中文编码**：stdin.write 必须使用 `Buffer.from(text, 'utf-8')`，否则 Windows 下中文变乱码
- **进程清理**：使用 `taskkill /pid <PID> /T /F` 杀掉整个进程树，避免残留

### 安全红线

- **API Key 不经浏览器**：`/api/providers/import` 从服务端多源（database/cc-switch-db/TOML/settings.json）解析真实 apiKey，浏览器只传 provider name
- **API 响应不泄露 apiKey**：所有 GET 用 Prisma select 排除 apiKey；providers 用 maskApiKey() 返回掩码值
- **Mass Assignment 防护**：Agent PUT 白名单不含 status（设计决策#20）；Session PUT 白名单不含 phase/type/phaseStep（设计决策#8/#12），白名单字段：title/projectDir/permissionMode/isPinned/isArchived
- **iframe sandbox**：`allow-scripts`（设计决策#17），不含 `allow-same-origin`
- **WebPreview XSS 防护**：DOMPurify 清理 HTML + CSS `url()` 过滤 + CSP meta tag（`default-src 'none'; img-src data:`）+ `</script` 转义，JS 靠 CSP+sandbox 防御（JS 本身无法 sanitize）
- **成员列表**：agent select 排除 systemPrompt
- **shell:true 命令注入**：ClaudeCodeAdapter/OpenCodeAdapter 使用 `shell: true`，`permissionMode`/`sessionId`/`model` 等来自用户/数据库输入，必须验证后再传入 args
- **accept 路由 baseDir**：`target === 'project'` 时 baseDir 为 `process.cwd()`，客户端可覆盖源码，应改用 `session.projectDir`
- **所有 API 无认证**：16 个端点无任何认证/授权检查，公开部署前必须添加
- **中文乱码检测**：`POST /api/sessions` 检测 `hasLoneSurrogates(title)` 拒绝 GBK 误编 UTF-8 的请求，返回 400
- **附件上传安全**：10MB 文件大小限制 + mimeType 白名单 + UUID 文件名防路径遍历 + 路径遍历防护（resolved path 必须在 uploads/ 内）

### 适配器层

- `platform: 'claude-code'` → ClaudeCodeAdapter（stdin + bare 模式，支持 `--resume` 恢复会话）
  - 120 秒无输出超时（`noOutputTimer`），超时自动 killProcessTree
  - **权限交互**：`--permission-prompt-tool stdio`，CLI 通过 `control_request`/`control_response` 协议与前端交互。`default` 模式下发 `control_request`，前端显示确认横幅；`auto` 模式不发请求
  - **权限路由**：`respondPermissionByRequestId(requestId, result)` 通过 `requestIdToKey` 反向索引 O(1) 查找进程，解决 permission route 无法构造 `effectiveKey`（含 toolsHash）的问题。失败返回 404
  - **并发权限**：`pendingPermissions: Map<string, PendingPermission>` 按 requestId 存储，支持多个 Agent 同时请求权限；`requestIdToKey: Map<string, string>` 反向索引；前端 `pendingPermissions[]` 数组，横幅支持多个同时显示
  - **进程状态**：ProcessEntry 有 `state: 'idle' | 'working'`，send() 时设 working，完成后设 idle，cleanupIdle 只杀 idle 且超时的进程，不会误杀长任务
  - **entry 互斥锁**：同 effectiveKey 并发 send 用 FIFO baton-passing 锁(`entry.busy` + `entry.busyWaiters`)串行化 stdin.write + readRound。`acquireLock` 超时 5min 抛 `EntryBusyTimeoutError`;entry 死亡抛 `EntryDiedWhileWaitingError` 触发 retry 重建。锁在 `finally` 释放,每次 retry iteration 独立 acquire/release
- **错误分类**：`isPermanentError()` 区分永久错误（API_KEY_INVALID 等）和瞬时错误；永久错误不重试，瞬时错误指数退避 1s→2s→4s，最多重试 3 次。stderr 输出累积到 `entry.stderrBuffer`，进程退出时拼入错误消息供 `isPermanentError` 匹配；ndjson 格式的 error 事件若匹配永久错误模式则立即 throw 不等进程退出
- **优雅关闭**：`gracefulShutdown()` 两阶段：SIGTERM → 5s → SIGKILL；注册 SIGTERM/SIGINT/beforeExit
- **Wall-clock 超时**：`orchestrator/timeout.ts` 的 `withTimeout` 包装 async generator，超时抛 `TimeoutError` 并调用 `onTimeout` 清理（`gracefulKillEntry` 两阶段杀进程）。5 个核心函数有超时保护：callLLM/callLLMForAnalysis(2min)、executeSingleAgent/executeTaskBatch(15min)、runDiscussion(3min/轮)。全局 50 分钟 deadline 从 SSE 流开始算。catch 块区分 `TimeoutError` 不走 fallback 防连锁挂起
- `platform: 'opencode'` → OpenCodeAdapter（NDJSON 事件流，通过 ProcessRegistry 管理，format='ndjson'，一次性进程自动清理）
  - **prompt 通过 CLI 参数传递**：只传用户消息，systemPrompt 通过配置文件注入
  - **System Prompt 注入**：写入 `.opencode/agents/agenthub-{agentId}.md`，通过 `--agent` 参数选择
  - **MCP 配置注入**：通过 `XDG_CONFIG_HOME` 环境变量注入独立配置目录，每个 Agent 独立配置避免并发冲突
  - **附件支持**：通过 `--file` 参数传递附件路径（图片和非图片都走 `--file`）
  - **工具限制**：配置文件 `tools` 字段映射（Read→read, Write→write 等），`OPENCODE_PERMISSION` 作为 fallback（无限制时全部放行）
  - **权限模式**：`--dangerously-skip-permissions` 标志（auto 模式）
  - **工作目录**：三重锚定（`--dir` + `cmd.Dir` + `PWD` 环境变量），确保正确发现 `.opencode/` 目录
  - **环境变量**：`ANTHROPIC_API_KEY`/`ANTHROPIC_BASE_URL`（非 OPENAI_*）
  - **模型名格式**：`provider/model`（如 `mimo/mimo-v2.5-pro`），通过 `opencode models` 命令动态发现
  - **错误路径**：opencode error 事件结构为 `event.error?.data?.message`，不是 `event.data?.message`
  - **tool_use 事件结构**：`event.type === 'tool_use'`，`event.part.type === 'tool'`，工具名在 `event.part.tool`，输入在 `event.part.state.input`，输出在 `event.part.state.output`（内嵌在同一事件中，无单独 tool_result）
- Orchestrator 是特殊 Agent 记录（`isOrchestrator: true`），使用 CLI 适配器
- 每个 Agent 可独立选择执行平台，各自配置 model/baseUrl/apiKey
- **Orchestrator 配置统一**：`getOrchestratorAgent()` 从 Agent 表读取；若 Agent 凭证为空，自动从 AppConfig/CC-Switch 读取当前 Provider 作为 fallback；`callLLM`/`callLLMForAnalysis` 使用 Orchestrator Agent 的 platform/model/baseUrl/apiKey
- **禁止硬编码模型 fallback**：`config/orchestrator/route.ts`、`app-config.ts` 中 model 为空时返回空字符串，不 fallback 到 `'claude-sonnet-4-20250514'`；CLI 会使用环境变量 `ANTHROPIC_MODEL` 作为默认值
- **CLI 自动检测**：`detectCLIPlatform()` 按优先级检测 claude-code → opencode，结果持久化到 Orchestrator Agent 记录
- **chunk 累加过滤**：所有 adapter chunk 累加（callLLM/callLLMForAnalysis/executeSingleAgent/executeTaskBatch/runDiscussion）必须过滤 `type === 'text'`，不累加 status chunk；**error chunk 不拼入 result**（callLLM 中 throw、executeSingleAgent 中仅通过 onChunk 发送给前端）；claude-code-adapter 的 result 事件只发 status，增量文本已通过 assistant 事件输出
- **SSE 错误处理**：`use-chat.ts` fetch 后必须检查 `res.ok`，4xx/5xx 时解析错误信息显示给用户，不静默失败
- **MCP 协作**：两个适配器都支持 MCP Server，给 Agent 提供共享工具（`read_artifact`、`list_files`、`list_tasks`、`post_message`、`read_messages`）
  - **ClaudeCodeAdapter**：通过 `--mcp-config` 参数传递，MCP 配置写入临时文件避免 shell 转义问题
  - **OpenCodeAdapter**：通过 `XDG_CONFIG_HOME` 环境变量注入独立配置目录，每个 Agent 独立配置避免并发冲突。配置格式从 Claude Code MCP 格式自动转换为 OpenCode MCP 格式（`type: 'local'`, `command: [cmd, ...args]`, `environment: {}`）
  - **路径安全**：`isPathSafe()` 用 `realpathSync` 解析后比较 `REAL_WORK_DIR + sep`，防 symlink 和前缀目录绕过；文件不存在时 fallback 到 `resolve + startsWith(WORK_DIR + sep)`
- **LLM fallback 已移除**：CLI 不可用时直接报错，不静默降级到 LLM API
- **附件支持**：两个适配器都支持文件附件
  - **ClaudeCodeAdapter**：图片读取转 base64，通过 stream-json 的 `type: 'image'` content block 传给 CLI（需视觉模型）。非图片附件在 prompt 中加路径引用，CLI 的 Read 工具自行读取
  - **OpenCodeAdapter**：通过 `--file` 参数传递附件路径（图片和非图片都走 `--file`），需视觉模型（如 `opencode/mimo-v2.5-free`）才能识别图片内容

### 多供应商配置

- Agent 表有 `model`/`baseUrl`/`apiKey` 字段，支持不同 Agent 使用不同供应商
- **Provider 表**：已保存的服务商配置模板，创建 Agent 时选中后复制到 Agent 自身字段（不是 FK，运行时不引用）
- **ClaudeCodeAdapter provider 注入**：`spawnProcess` 将 Agent 的 `apiKey` → `ANTHROPIC_API_KEY`，`baseUrl` → `ANTHROPIC_BASE_URL`，`model` → `--model` CLI 参数。**无 baseUrl 时不覆盖系统 ANTHROPIC_BASE_URL**（保留用户 CLI 配置）。model 为空时不传 `--model`（CLI 用默认模型）。per-agent per-session 独立进程，天然并发隔离
- **OpenCodeAdapter**：通过环境变量传递 `ANTHROPIC_API_KEY`/`ANTHROPIC_BASE_URL`
- **4 个 Provider 数据源**（GET `/api/providers` 合并返回，按 baseUrl 去重，高优先级覆盖低优先级）：
  1. `database` — Provider 表（apiKey 完整返回）
  2. `cc-switch-db` — CC-Switch SQLite DB `~/.cc-switch/cc-switch.db`（apiKey 完整返回，支持 Claude 和 OpenCode 类型）
  3. `cc-connect` — `~/.cc-connect/config.toml`（apiKey mask）
  4. `settings.json` — `~/.claude/settings.json`（apiKey mask）
- **PUT 不覆盖空值**：`apiKey`/`baseUrl` 用 `&&` 判断，空字符串不覆盖已有值

### Orchestrator 智能编排模式

Orchestrator 自主决定流程，支持 8 种 action：
- `self` — Orchestrator 自己回答（闲聊、简单问题）
- `delegate` — 委派给指定 Agent（`target` 字段指定）
- `discuss` — 多 Agent 讨论（`targets` 数组指定参与者）
- `align_confirm` — PM 复述需求，等用户确认理解
- `align_decompose` — 架构师拆任务 + 持久化 Task 记录，等用户确认方案
- `align_qa` — Agent 对方案提问澄清，等用户回答
- `execute` — 对齐完成，开始执行任务
- `done` — 任务完成

编排原则：用户提开发任务 → align_confirm → align_decompose → align_qa 或 execute → execute。简单任务可跳步。Orchestrator 看对话历史自主判断下一步。

安全校验：`validateDecision()` 拦截严重矛盾（alignment 中返回 done、execution 中回退 align_*、Q&A 循环超限）。**delegate 前置检查**：如果数据库中存在 pending 任务，自动切换为 `execute`，确保任务状态正确更新（防止 delegate 直接执行但不更新 Task 状态）。**Task 兜底**：`transitionToExecution` 检查 Task 为空时自动调 `handleArchitectPlan` 补拆任务（即使没有架构师 Agent，LLM fallback 也能拆解）。**align_decompose 无架构师可用**：prompt 中告知 Orchestrator，不要因为缺少架构师而跳过 `align_decompose`。

决策函数：`src/lib/orchestrator/index.ts` → `getOrchestratorDecision()`

**自动纠偏**：`delegateToAgent` 路径下，`reviewResult` 发现质量问题时自动重新执行 Agent（最多 3 次）。重试时注入纠偏信息到 prompt，重试失败返回 `quality: 'poor'`。实现：`src/lib/services/review.ts` → `reviewResult()` 的 `retryContext` 参数。

### 消息解析器

- `src/lib/message-parser.ts` → `parseMessage()` 函数
- `/api/messages` 返回时自动解析 `rawContent`，前端可直接使用 `message.parsed.text`、`message.parsed.codeBlocks`、`message.parsed.artifacts`

### 讨论摘要注入

- **存储标记**：`runMultiAgentDiscussion` 和 `@所有人` 讨论结果存储时加 `[DISCUSSION_SUMMARY][STATUS:success/failed]` 前缀
- **摘要提取**：`buildDiscussionSummary(sessionId)` 从 DB 读取最新讨论消息，过滤失败讨论，按句子边界截断 500 字
- **Agent 注入**：`executeTaskBatch` 提取讨论摘要，条件注入 Agent prompt 作为 `[项目背景]` 前缀，超长按比例缩减
- **前缀剥离**：`buildContextFromHistory` 去掉 `[DISCUSSION_SUMMARY]` 前缀，避免污染 Orchestrator 决策上下文

### CLI 会话恢复

- **统一机制**：Claude Code 用 `--resume`，OpenCode 用 `--session`，两个平台都通过 CLI 原生 session 恢复管理历史
- **不拼接 context**：上下文由 CLI 自己管理，AgentHub 只传当前消息，不手动拼接历史消息
- **SessionMember.cliSessionId**：存储每个 Agent 的 CLI session ID，对齐阶段（讨论轮次）写入
- **Task.cliSessionId**：存储任务执行时的 CLI session ID，执行完成后写入
- **Fallback 机制**：执行阶段首次启动任务时 `Task.cliSessionId` 为空，fallback 读 `SessionMember.cliSessionId`（对齐阶段的 session），确保 agent 能 resume 讨论历史。执行完成后同步回 `SessionMember`
- 执行后提取 `session_id` 并保存到对应表
- 类型定义：`StreamChunk.type` 包含 `'session'` 类型

### 事件类型

- **StreamChunk.type**：`'text' | 'thinking' | 'tool_use' | 'tool_result' | 'status' | 'error' | 'session' | 'permission_request' | 'permission_cancel'`
- **Claude Code 事件**：`assistant` 消息中的 `text`/`thinking`/`tool_use` block，`user` 消息中的 `tool_result` block
- **OpenCode 事件**：`type: 'tool_use'` 事件包含 `part.tool`（工具名）、`part.state.input`（输入）、`part.state.output`（输出，内嵌在同一事件中）
- **前端展示**：`thinking` → 灰色斜体，`tool_use` → 代码块（⚙️），`tool_result` → 代码块（✅）

### 工作区与权限模式

- 用户创建群聊时可指定项目目录（如 `E:\projects\todo-app\`）
- Session 表存储 `projectDir` 和 `permissionMode`（`default` | `auto`）
- Agent 直接在 `projectDir` 中工作，不创建独立子目录
- 最近打开的目录存储在 `RecentDir` 表，API：`/api/recent-dirs`
- 聊天命令 `/permission auto` 或 `/permission default` 切换权限模式
- ClaudeCodeAdapter 支持 `--permission-mode` + `--permission-prompt-tool stdio` 参数
- **default 模式权限流程**：CLI `control_request` → SSE `permission_request` → 前端横幅 → POST `/api/sessions/{id}/permission` → CLI `control_response`
- **禁止修改 ProcessRegistry key 格式** — chat route 和 permission route 必须用相同的 `${sessionId}:${agentId}:${workDir}`
- **ProcessRegistry 内部禁止直接调 `killEntry(key)`** — 内部已持有 entry 的路径必须用私有 `killEntryIfCurrent(key, expectedEntry)`,它会校验 `registry.get(key) === expectedEntry`。公开 `killEntry(key)` 仅作外部兼容入口。违反会让旧进程的 exit handler 误删同 key 新 entry(僵尸进程泄漏)
- **杀进程必须走 adapter 套路,不准自拼 key/config** — orchestrator 调 `gracefulKillEntry` 时必须用 `adapter.getRegistryKey()` + `adapter.getSpawnConfig()` 拿权威值,**不准**自己 `buildRegistryKey` 或自拼 partial config。原因:`toEffectiveKey` 含 `configHash`(apiKey/baseUrl/model/permissionMode/mcpConfig 等指纹),partial config 算出来的 effectiveKey 跟 spawn 时不一致,`registry.get` 返回 undefined,函数静默 no-op,超时杀进程失效。adapter 接口契约见 `src/lib/adapter/types.ts`,两个 adapter 在 `send()` 真正 spawn 后才缓存 `lastSpawnConfig`(send 前调 `getSpawnConfig()` 返回 null)
- **同 effectiveKey 并发 send 必须经 `acquireLock`/`releaseLock`** — ProcessRegistry 的 entry 互斥锁用 FIFO baton-passing(`entry.busy` + `entry.busyWaiters`),保护 stdin.write + readRound 临界区。绕过会让两路 send 的 stdin/stdout 交错 → Claude CLI 收到乱码 JSON。release 必须在 `finally`,同步 throw 路径也要释放。retry iteration 独立 acquire/release,不跨 retry
- **`toEffectiveKey` 的指纹字段不能漏** — 改 apiKey/model/baseUrl/mcpConfig/permissionMode/command/args/format/disallowedTools 必须触发新进程(进 `buildConfigHash`),否则旧 entry 用老配置继续跑(review #13:配置改了 10 分钟不生效)。`env`/`sessionId`/`workDir`/`allowedTools` 不进 config hash(env 开放容器可能含动态值,进指纹会破坏进程复用)
- **executeTaskBatch 的 agents 数组必须包含 `id` 字段** — 缺少 `id` 会导致所有 Agent 的 registry key 变成 `sessionId:default:workDir`,共享同一个 CLI 进程,并行执行时输出完全相同
- 详见 `docs/design/workspace-and-permissions.md`

### 断点续跑

- GET `/api/sessions/[id]` 自动重置超过 5 分钟未更新的 `in_progress` 任务为 `pending`，返回 `recoveredTaskCount`
- 避免与活跃 Agent 竞态：只重置 `updatedAt < now - 5min` 的任务
- 前端收到 `recoveredTaskCount > 0` 时弹恢复 Dialog，用户可选"继续执行"或"跳过"
- 实现：`src/app/api/sessions/[id]/route.ts` GET handler

### Diff Accept 文件修改检测

- POST `/api/sessions/[id]/files/accept` 写入前用 md5 对比当前文件内容与待写入内容
- 不一致返回 `409 { error: 'file_modified' }`，前端弹确认框，确认后带 `force: true` 重试跳过检查
- 新文件（文件不存在）跳过检查，直接写入

### 文件变更检测(影子 git)

- 每批任务跑完通过**影子 git**(`<workDir>/.agenthub/shadow-git/<sessionId>/`)对比 `declaredFiles` 和实际改动
- **workDir 本身不被 git init**,通过 `git --git-dir=... --work-tree=<workDir>` 调用,用户感知不到 git 存在
- **`.agenthub/.gitignore` 自排除** — `ensureShadowInit` 时写入 `*\n`,防止用户 projectRoot 是 git 仓库时把影子目录误提交。每次 init 都幂等校验,内容不同则覆盖(防外部脏写)
- **session 删除时清理影子目录** — `DELETE /api/sessions/[id]` 调 `cleanupShadowGit(projectDir, sessionId)`,失败 console.warn 不阻塞 session 删除
- 越界判定分级(契约 §1.2 b):敏感路径(`.env` / `package.json` / `prisma/schema.prisma` 等,详见 `src/lib/services/sensitive-paths.ts`)→ 任务硬失败 + 下游 blocked;普通越界 → 自动清理越界文件(保留其他批次声明的文件) + 任务仍 completed;`declaredFiles` 为空 → 跳过校验
- outputSchema 软校验(契约 §1.2 a):从 `task.result` 末尾提取 JSON 块比对字段名,缺字段只发警告不阻断
- **prompt 注入防御** — `<dependency>` / `<authoritative_input>` 标签内嵌的所有外部内容(upstream result / task.description / declaredFiles / dep name / outputSchema)必须先过 `escapeContractTags()`(`src/lib/orchestrator/prompts.ts`),否则字面 `</dependency>` 可闭合包装注入伪指令。regex 容忍标签内空白(`</dependency \n >` 也挡)。**JSON.stringify 不转义 `<>`,attr 值同样需要 escape**
- **cliSessionId 跨表更新必须用 `prisma.$transaction`** — `task.cliSessionId` 与 `SessionMember.cliSessionId` 两表写入必须原子,中间崩溃半残会让 fallback 拿脏 sessionId 污染下次执行。成功 / 纠偏 / 敏感失败三条路径都包事务。**正常完成路径**:CLI 没返回 sessionId 时用 `...(cliSessionId ? { cliSessionId } : {})` 跳过更新(保留旧值),不用 `|| null` 覆盖
- **redo 路径走主链路** — `POST /api/sessions/[id]/tasks/[taskId]/redo` 只负责"重置 task 状态 + 解锁下游 + 调 `handleExecution`",**不直接调 `executeSingleAgent`**。否则 contract v1 全部保护(result 持久化 / dependency 注入 / authoritative_input 包装 / 敏感校验 / outputSchema 校验 / cliSessionId invalidate)在 redo 路径都失效。重置时清 task + sessionMember 的 cliSessionId,同样包事务
- 实现:`src/lib/services/shadow-git.ts` / `sensitive-paths.ts` / `schema-validator.ts` / `orchestrator/prompts.ts`(escapeContractTags)
- 设计源文档:`docs/discussions/agenthub-contract-v1.md`

### Agent 边界防护

- **P0 Prompt 注入**：`executeTaskBatch` 构建 prompt 时自动追加 `[任务边界] 只能修改: [declaredFiles]`，Agent 执行前即知文件约束
- **P1 纠偏加强**：重试时从 `trace` 中提取最近 `correction` 事件的 `message`，注入 `[上次问题] ...` 到 prompt，避免重复越界
- **隐性行为准则**：`AGENT_BEHAVIOR_RULES` 自动注入所有 Agent 的 System Prompt，XML 结构化，包含三个维度：
  - **交互规范**：不假设项目、不主动读代码、简洁介绍、先问后做、不编造
  - **协作规范**：任务完成必须汇报、里程碑进度汇报、阻塞立即上报、依赖明确说明、代码修改后测试
  - **安全边界**：不越界、不破坏、修改前确认可回滚
  - **汇报模板**：任务完成时必须包含（完成内容、产出位置、验证方式、遗留问题、影响范围）
- **流程**:检测越界 → 敏感路径硬失败(下游 blocked)/ 普通越界自动清理(保留其他批次文件) → LLM 监督审查(越界已清空不触发纠偏) → 任务 completed

### Chat API Session Lock

- 同一个 session 的 chat 请求必须串行处理（per-session lock）
- 原因：并发请求会读到过时的 phaseStep，导致同一 handler 被触发两次
- 实现：`src/lib/session-lock.ts` → `acquireSessionLock()`，chat route 和 redo API 共用
- **超时保护**：等待前一个请求超过 60 秒则跳过等待继续执行
- **abort 监听**：客户端断开时自动 release 锁
- **SSE 全局超时**：60 分钟无响应则强制关闭流；`streamClosed` 标志位防止超时后往已关闭的 controller 写入（避免锁泄漏）
- **禁止移除 session lock** — 会导致对齐流程并发 bug
- **新增 session 相关路由必须加锁** — 任何操作任务/消息的 POST 路由都必须 `acquireSessionLock(sessionId)`，否则与 chat route 并发会竞态

### 会话类型

- `type: 'orchestrator'` — Orchestrator 主会话，走对齐流程
- `type: 'group'` — 群聊，多 Agent 协作，通过拉群 Dialog 创建（可选 Agent）
- `type: 'private'` — 私聊，直接与单个 Agent 对话，跳过 Orchestrator

### 设计文档(必读)

- **Agent 协作 contract v1**:`docs/discussions/agenthub-contract-v1.md` — 数据流契约、可信度契约、连续性契约(决定 task.result / outputSchema / 影子 git / declaredFiles 校验等的设计)
- **v2 设计决策**:`docs/design/agenthub-v2-design-decisions.md` — 早期架构决策(混合执行层、Agent 预设池、群聊协作、工件驱动等)
- **工作区与权限**:`docs/design/workspace-and-permissions.md`
- **实现计划**:`docs/design/implementation-plan.md` — 8 阶段任务拆分
- 参考资料:`docs/reference/anthropic-scaling-managed-agents.md`、`docs/reference/multi-agent-reference.md`
- **新增功能前必须先看 contract v1**(它定义了 Agent 协作的"应然"),再看 v2 设计决策(早期架构)

### 已知功能差距

详见 `issues/ISSUE-DESIGN-未实现功能清单.md`

## API 路由（核心）

| 方法 | 路径 | 功能 |
|------|------|------|
| GET/POST/PUT/DELETE | `/api/sessions` | 会话 CRUD |
| POST | `/api/sessions/[id]/chat` | SSE 流式聊天（per-session lock） |
| POST | `/api/sessions/[id]/permission` | 权限交互回应 |
| GET/POST/PUT/DELETE | `/api/agents` | Agent CRUD |
| GET/POST | `/api/providers` | 服务商列表/导入 |
| GET/POST/PUT/DELETE | `/api/providers/db` | Provider 表 CRUD |
| GET/POST | `/api/config` | 通用配置 |
| GET/POST | `/api/config/orchestrator` | Orchestrator 配置 |
| POST | `/api/config/test-connection` | 连接测试 |
| POST | `/api/sessions/[id]/files/accept` | 接受 Diff 变更 |
| GET | `/api/opencode/models` | OpenCode 可用模型列表 |

完整路由详见 `src/app/api/` 目录结构。

## 运行

```bash
npm run dev     # 开发
npm run build   # 构建
```

Claude Code CLI 复用已有认证。LLM API 模式需配置 `ANTHROPIC_API_KEY`（通过 Agent 或 CC-Switch 导入）。
