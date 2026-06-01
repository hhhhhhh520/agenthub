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
│   └── layout.tsx             # 根 layout（字体 + body）
├── components/
│   ├── ui/                    # shadcn/ui 组件
│   ├── chat-area.tsx          # 聊天区 + SSE 流式
│   ├── session-sidebar.tsx    # 会话侧边栏
│   ├── agent-panel.tsx        # Agent 面板 + 任务看板
│   ├── chat-fab.tsx           # 右下角浮窗聊天卡片
│   ├── code-diff.tsx          # Monaco DiffEditor
│   ├── web-preview.tsx        # iframe 预览
│   └── attachment-input.tsx   # 附件上传（📎按钮 + 拖拽 + 粘贴）
├── lib/
│   ├── adapter/               # 适配器层（Claude Code CLI / LLM / OpenCode）
│   ├── orchestrator/          # 编排器（prompt + 调度 + 执行）
│   ├── services/              # 业务服务层（从 chat route 拆分）
│   │   ├── chat-router.ts     # Orchestrator 决策路由 + validateDecision
│   │   ├── alignment.ts       # 对齐流程（PM确认→架构师拆解→Q&A）
│   │   ├── execution.ts       # 任务执行引擎
│   │   ├── review.ts          # 结果审查 + 纠偏 + delegate/discuss
│   │   ├── agent-factory.ts   # Agent 创建
│   │   ├── context-builder.ts # 历史上下文构建
│   │   └── git-utils.ts       # Git 变更检测
│   ├── hooks/                 # use-sessions, use-chat, use-chat-fab
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
- 详见 `issues/ISSUE-001-agent-creation-parse-failure-已解决` 和 `issues/ISSUE-002-prisma-generated-path-已解决`

### 数据模型（v2）

- **Session**：`projectDir`（项目目录）、`permissionMode`（`default` | `auto`）、`isPinned`/`isArchived`（置顶/归档）
- **RecentDir**：存储最近打开的目录（`path` 唯一、`lastUsed`、`useCount`）
- **Agent**：`platform`/`model`/`baseUrl`/`apiKey` 支持多供应商；`isOrchestrator` 标记 Orchestrator 特殊 Agent；默认 platform 为 `claude-code`
- **Provider**：已保存的服务商配置模板（`name` 唯一、`baseUrl`、`apiKey`、`model`、`category`）。Agent 选中后复制字段，不是 FK
- **Task**：`cliSessionId` 用于 CLI 会话恢复；`correctionCount` 纠偏重试计数（持久化，重启不丢失）
- **SessionMember**：`status`（`idle`|`working`|`done`|`error`）per-session 状态，不写 Agent.status
- **Message**：`isPinned`（Pin 消息作为长期上下文，每会话最多 10 条）
- **Attachment**：用户上传的图片/文件（`messageId` 可空，先上传后关联；`sessionId` 方便孤儿清理；`onDelete: Cascade` 只删 DB 记录，需 `cleanupAttachmentFiles()` 删磁盘文件）
- ⚠️ **`_count` 不可用**：`/api/sessions/[id]` 不返回 `_count`，项目详情页用 `session.messages.length` 而非 `session._count.messages`（2026-05-29 踩坑修复）
- 详见 `prisma/schema.prisma`

### Next.js 16

- 动态路由 `params` 是 `Promise`，必须 `await`
- 签名：`{ params }: { params: Promise<{ id: string }> }`
- 详见 `issues/ISSUE-004-nextjs16-params-promise-已解决`

### Claude Code CLI 集成

- `--system-prompt` 被 CLI 默认系统提示覆盖，需合并到 prompt 中
- Windows 上必须用 `shell: true` + stdin 传递 prompt
- 使用 `--bare` 跳过 hooks/plugins
- **禁止使用 `--dangerously-skip-permissions`** — 会导致 CLI 卡住
- **中文编码**：stdin.write 必须使用 `Buffer.from(text, 'utf-8')`，否则 Windows 下中文变乱码
- **进程清理**：使用 `taskkill /pid <PID> /T /F` 杀掉整个进程树，避免残留
- 详见 `issues/ISSUE-005-cli-system-prompt-ignored-已解决` ~ `ISSUE-008-cli-enoent-windows-已解决`、`issues/ISSUE-011-cli-process-tree-cleanup-已解决`

### 安全红线

- **API Key 不经浏览器**：`/api/providers/import` 从服务端 config.toml 读取真实 apiKey，浏览器只传 provider name
- **API 响应不泄露 apiKey**：所有 GET 用 Prisma select 排除 apiKey；providers 用 maskApiKey() 返回掩码值
- **Mass Assignment 防护**：Agent PUT 白名单不含 status（设计决策#20）；Session PUT 白名单不含 phase/type/phaseStep（设计决策#8/#12），白名单字段：title/projectDir/permissionMode/isPinned/isArchived
- **iframe sandbox**：`allow-scripts`（设计决策#17），不含 `allow-same-origin`
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
  - ProcessRegistry key：`${sessionId}:${agentId}:${workDir}`，permission API 必须用相同格式
  - **并发权限**：`pendingPermissions: Map<string, PendingPermission>` 按 requestId 存储，支持多个 Agent 同时请求权限；前端 `pendingPermissions[]` 数组，横幅支持多个同时显示
  - **进程状态**：ProcessEntry 有 `state: 'idle' | 'working'`，send() 时设 working，完成后设 idle，cleanupIdle 只杀 idle 且超时的进程，不会误杀长任务
- **错误分类**：`isPermanentError()` 区分永久错误（API_KEY_INVALID 等）和瞬时错误；永久错误不重试，瞬时错误指数退避 1s→2s→4s，最多重试 3 次
- **优雅关闭**：`gracefulShutdown()` 两阶段：SIGTERM → 5s → SIGKILL；注册 SIGTERM/SIGINT/beforeExit
- `platform: 'llm'` → LLMAdapter（需要 ANTHROPIC_API_KEY 或 OpenAI API Key）
  - 支持 abortSignal 取消请求
- `platform: 'opencode'` → OpenCodeAdapter（NDJSON 事件流，通过 ProcessRegistry 管理，format='ndjson'，一次性进程自动清理）
- Orchestrator 是特殊 Agent 记录（`isOrchestrator: true`），使用 CLI 适配器
- 每个 Agent 可独立选择执行平台，各自配置 model/baseUrl/apiKey
- **Orchestrator 配置统一**：`getOrchestratorAgent()` 从 Agent 表读取；`callLLM`/`callLLMForAnalysis` 使用 Orchestrator Agent 的 platform/model/baseUrl/apiKey
- **CLI 自动检测**：`detectCLIPlatform()` 按优先级检测 claude-code → opencode，结果持久化到 Orchestrator Agent 记录
- **chunk 累加过滤**：所有 adapter chunk 累加（callLLM/callLLMForAnalysis/executeSingleAgent/executeTaskBatch/runDiscussion）必须过滤 `type === 'text' || type === 'error'`，不累加 status chunk；claude-code-adapter 的 result 事件只发 status，增量文本已通过 assistant 事件输出
- **SSE 错误处理**：`use-chat.ts` fetch 后必须检查 `res.ok`，4xx/5xx 时解析错误信息显示给用户，不静默失败
- **MCP 协作**：ClaudeCodeAdapter 支持 `--mcp-config` 参数，MCP 配置写入临时文件避免 shell 转义问题。MCP Server 给 Agent 提供共享工具（`read_artifact`、`list_files`、`list_tasks`、`post_message`、`read_messages`）
  - **路径安全**：`isPathSafe()` 用 `realpathSync` 解析后比较 `REAL_WORK_DIR + sep`，防 symlink 和前缀目录绕过；文件不存在时 fallback 到 `resolve + startsWith(WORK_DIR + sep)`
- **LLM fallback 已移除**：CLI 不可用时直接报错，不静默降级到 LLM API
- **图片附件支持**：ClaudeCodeAdapter 读取图片文件转 base64，通过 stream-json 的 `type: 'image'` content block 传给 CLI（需视觉模型如 mimo-v2.5）。非图片附件在 prompt 中加路径引用，CLI 的 Read 工具自行读取

### 多供应商配置

- Agent 表有 `model`/`baseUrl`/`apiKey` 字段，支持不同 Agent 使用不同供应商
- **Provider 表**：已保存的服务商配置模板，创建 Agent 时选中后复制到 Agent 自身字段（不是 FK，运行时不引用）
- **ClaudeCodeAdapter provider 注入**：`spawnProcess` 将 Agent 的 `apiKey` → `ANTHROPIC_API_KEY`，`baseUrl` → `ANTHROPIC_BASE_URL`，`model` → `--model` CLI 参数。空值不注入（不覆盖系统环境变量）。per-agent per-session 独立进程，天然并发隔离
- **OpenCodeAdapter**：通过环境变量传递 `ANTHROPIC_API_KEY`/`OPENAI_API_KEY`/`ANTHROPIC_BASE_URL`/`OPENAI_BASE_URL`
- **4 个 Provider 数据源**（GET `/api/providers` 合并返回，按 baseUrl 去重，高优先级覆盖低优先级）：
  1. `database` — Provider 表（apiKey 完整返回）
  2. `cc-switch-db` — CC-Switch SQLite DB `~/.cc-switch/cc-switch.db`（apiKey 完整返回）
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

安全校验：`validateDecision()` 拦截严重矛盾（alignment 中返回 done、execution 中回退 align_*、Q&A 循环超限）。**execute 前置检查**：如果数据库中无 Task 记录，强制重定向到 `align_decompose`（架构师拆解），防止跳步。

决策函数：`src/lib/orchestrator/index.ts` → `getOrchestratorDecision()`

### 消息解析器

- `src/lib/message-parser.ts` → `parseMessage()` 函数
- `/api/messages` 返回时自动解析 `rawContent`，前端可直接使用 `message.parsed.text`、`message.parsed.codeBlocks`、`message.parsed.artifacts`

### CLI 会话恢复

- ClaudeCodeAdapter 支持 `--resume sessionId` 参数恢复上下文
- 执行后提取 `session_id` 并保存到 Task 表 `cliSessionId` 字段
- 类型定义：`StreamChunk.type` 新增 `'session'` 类型

### 工作区与权限模式

- 用户创建群聊时可指定项目目录（如 `E:\projects\todo-app\`）
- Session 表存储 `projectDir` 和 `permissionMode`（`default` | `auto`）
- Agent 直接在 `projectDir` 中工作，不创建独立子目录
- 最近打开的目录存储在 `RecentDir` 表，API：`/api/recent-dirs`
- 聊天命令 `/permission auto` 或 `/permission default` 切换权限模式
- ClaudeCodeAdapter 支持 `--permission-mode` + `--permission-prompt-tool stdio` 参数
- **default 模式权限流程**：CLI `control_request` → SSE `permission_request` → 前端横幅 → POST `/api/sessions/{id}/permission` → CLI `control_response`
- **禁止修改 ProcessRegistry key 格式** — chat route 和 permission route 必须用相同的 `${sessionId}:${agentId}:${workDir}`
- 详见 `docs/design/workspace-and-permissions.md`

### 文件变更检测

- 每批任务执行后自动 `git diff --name-only HEAD` 检测实际改动文件
- 对比 `declaredFiles`（Agent 声明的文件）和实际改动，越界修改发送告警
- 未初始化 Git 的项目 fallback 到无检测
- 实现：`src/lib/services/git-utils.ts` 中的 `getGitSnapshot` / `getChangedFiles`

### Chat API Session Lock

- 同一个 session 的 chat 请求必须串行处理（per-session lock）
- 原因：并发请求会读到过时的 phaseStep，导致同一 handler 被触发两次
- 实现：`src/lib/session-lock.ts` → `acquireSessionLock()`，chat route 和 redo API 共用
- **超时保护**：等待前一个请求超过 60 秒则跳过等待继续执行
- **abort 监听**：客户端断开时自动 release 锁
- **SSE 全局超时**：5 分钟无响应则强制关闭流
- **禁止移除 session lock** — 会导致对齐流程并发 bug
- **新增 session 相关路由必须加锁** — 任何操作任务/消息的 POST 路由都必须 `acquireSessionLock(sessionId)`，否则与 chat route 并发会竞态

### 会话类型

- `type: 'orchestrator'` — Orchestrator 主会话，走对齐流程
- `type: 'group'` — 群聊，多 Agent 协作，通过拉群 Dialog 创建（可选 Agent）
- `type: 'private'` — 私聊，直接与单个 Agent 对话，跳过 Orchestrator

### 设计文档（必读）

- **v2 设计决策**：`docs/design/agenthub-v2-design-decisions.md` — 当前架构设计（混合执行层、Agent 预设池、群聊协作、工件驱动等）
- **适配器生命周期重构**：`docs/design/adapter-lifecycle-refactor.md` — SessionManager + OneShotRunner 重构方案，补齐 OpenCode 重试/超时/清理能力
- **Skill 功能**：`docs/design/skill-feature-plan.md` — Skill 表 + AgentSkill 关联 + `~/.claude/skills/` 写入 + CLI 原生发现
- **工作区与权限**：`docs/design/workspace-and-permissions.md` — 项目目录、权限模式、变更检测
- **实现计划**：`docs/design/implementation-plan.md` — 8 阶段任务拆分
- 参考资料：`docs/reference/anthropic-scaling-managed-agents.md`、`docs/reference/multi-agent-reference.md`
- 新增功能前必须对照 v2 设计决策文档

### 已知功能差距

详见 `issues/ISSUE-DESIGN-未实现功能清单.md`

## API 路由

| 方法 | 路径 | 功能 |
|------|------|------|
| GET | `/api/sessions` | 会话列表（默认过滤归档，`?archived=true` 查看归档） |
| POST | `/api/sessions` | 创建会话（自动添加预设 Agent） |
| GET | `/api/sessions/[id]` | 会话详情 |
| PUT | `/api/sessions/[id]` | 更新会话 |
| DELETE | `/api/sessions/[id]` | 删除会话 |
| GET | `/api/sessions/[id]/messages` | 消息列表 |
| POST | `/api/sessions/[id]/messages` | 创建消息 |
| PATCH | `/api/sessions/[id]/messages/[messageId]` | Pin/取消 Pin 消息（isPinned boolean，每会话最多 10 条） |
| GET | `/api/sessions/[id]/agents` | 会话 Agent 列表（仅 Agent 对象） |
| GET | `/api/sessions/[id]/members` | 会话成员列表（含 role/joinedAt） |
| POST | `/api/sessions/[id]/members` | 添加成员到会话 |
| DELETE | `/api/sessions/[id]/members` | 移除会话成员 |
| GET | `/api/sessions/[id]/tasks` | Task 列表 |
| POST | `/api/sessions/[id]/tasks/[taskId]/redo` | 重做失败/阻塞任务（编辑描述+重新执行+级联下游） |
| GET | `/api/sessions/[id]/files/[filename]` | 读取工作区文件 |
| POST | `/api/sessions/[id]/chat` | SSE 流式聊天（per-session lock） |
| POST | `/api/sessions/[id]/permission` | 权限交互回应（允许/拒绝 CLI 工具调用） |
| POST | `/api/sessions/recommend-agents` | 推荐 Agent（LLM 分析任务） |
| GET | `/api/agents` | 全局 Agent 列表 |
| POST | `/api/agents` | 创建 Agent |
| PUT | `/api/agents/[id]` | 更新 Agent |
| DELETE | `/api/agents/[id]` | 删除 Agent |
| GET | `/api/providers` | 服务商列表（合并 4 源：database + cc-switch-db + cc-connect TOML + settings.json） |
| POST | `/api/providers/import` | 导入服务商配置（传 provider name，后端从 config.toml 读 apiKey） |
| GET | `/api/providers/db` | Provider 表列表（含完整 apiKey） |
| POST | `/api/providers/db` | 创建 Provider |
| GET | `/api/providers/db/[id]` | 单个 Provider |
| PUT | `/api/providers/db/[id]` | 更新 Provider（空 apiKey 不覆盖） |
| DELETE | `/api/providers/db/[id]` | 删除 Provider |
| POST | `/api/sessions/[id]/files/accept` | 接受 Diff 变更写入文件 |
| POST | `/api/sessions/[id]/attachments` | 上传附件（FormData，10MB 限制，mimeType 白名单） |
| GET | `/api/attachments/[id]` | 读取附件文件（路径遍历防护，图片 inline 其他 attachment） |
| GET | `/api/config` | 通用配置读取（key 查询） |
| POST | `/api/config` | 通用配置写入（key-value） |
| GET | `/api/config/orchestrator` | Orchestrator 配置（apiKey/model/baseUrl） |
| POST | `/api/config/orchestrator` | 更新 Orchestrator 配置 |
| POST | `/api/config/test-connection` | 连接测试（CLI 检测 + LLM 测试） |
| POST | `/api/config/import-provider` | 从 CC-Switch 导入服务商配置 |
| POST | `/api/config/detect-platform` | CLI 平台检测（claude-code/opencode） |
| POST | `/api/deploy` | 模拟部署 |
| GET | `/api/recent-dirs` | 最近打开的目录列表 |
| POST | `/api/recent-dirs` | 添加最近目录 |
| DELETE | `/api/recent-dirs` | 删除最近目录 |

## 运行

```bash
npm run dev     # 开发
npm run build   # 构建
```

Claude Code CLI 复用已有认证。LLM API 模式需配置 `ANTHROPIC_API_KEY`（通过 Agent 或 CC-Switch 导入）。
