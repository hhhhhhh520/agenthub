# AgentHub — 多 Agent 协作平台

IM 风格的多 Agent 协作平台，Orchestrator 驱动任务拆解，统一适配器层，SSE 流式输出。

## Karpathy 编码准则

### 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

### 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

### 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

### 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:
```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

## 技术栈

Next.js 16 (App Router) · TypeScript · TailwindCSS 4 · shadcn/ui · Prisma 7 + SQLite · Monaco Editor · Claude Code CLI

## 项目结构

```
src/
├── app/
│   ├── api/sessions/          # Session CRUD + Chat SSE
│   ├── page.tsx               # 三栏布局主页
│   └── layout.tsx
├── components/
│   ├── ui/                    # shadcn/ui 组件
│   ├── chat-area.tsx          # 聊天区 + SSE 流式
│   ├── session-sidebar.tsx    # 会话侧边栏
│   ├── agent-panel.tsx        # Agent 面板 + 任务看板
│   ├── code-diff.tsx          # Monaco DiffEditor
│   └── web-preview.tsx        # iframe 预览
├── lib/
│   ├── adapter/               # 适配器层（LLM / Claude Code CLI）
│   ├── orchestrator/          # 编排器（prompt + 调度 + 执行）
│   ├── hooks/                 # use-sessions, use-chat
│   ├── db.ts                  # Prisma 单例
│   └── utils.ts               # shadcn 工具
└── generated/prisma/          # Prisma 生成（gitignore）
prisma/
├── schema.prisma              # Session/Agent/Task/Message 模型
└── migrations/
```

## 关键规则

### Prisma v7（踩坑高发）

- 构造函数必须传 adapter：`new PrismaClient({ adapter })`
- 生成路径：`@/generated/prisma/client`（不是 `@prisma/client`）
- schema generator：`provider = "prisma-client"`（不是 `prisma-client-js`）
- SQLite 需要 `@prisma/adapter-libsql` + `@libsql/client`
- 详见 `issues/ISSUE-001` 和 `issues/ISSUE-002`

### 数据模型（v2）

- **Session**：`projectDir`（项目目录）、`permissionMode`（`default` | `auto`）
- **RecentDir**：存储最近打开的目录（`path` 唯一、`lastUsed`、`useCount`）
- **Agent**：`platform`/`model`/`baseUrl`/`apiKey` 支持多供应商；`isOrchestrator` 标记 Orchestrator 特殊 Agent；默认 platform 为 `claude-code`
- **Task**：`cliSessionId` 用于 CLI 会话恢复
- 详见 `prisma/schema.prisma`

### Next.js 16

- 动态路由 `params` 是 `Promise`，必须 `await`
- 签名：`{ params }: { params: Promise<{ id: string }> }`
- 详见 `issues/ISSUE-004`

### Claude Code CLI 集成

- `--system-prompt` 被 CLI 默认系统提示覆盖，需合并到 prompt 中
- Windows 上必须用 `shell: true` + stdin 传递 prompt
- 使用 `--bare` 跳过 hooks/plugins
- **禁止使用 `--dangerously-skip-permissions`** — 会导致 CLI 卡住
- **中文编码**：stdin.write 必须使用 `Buffer.from(text, 'utf-8')`，否则 Windows 下中文变乱码
- **进程清理**：使用 `taskkill /pid <PID> /T /F` 杀掉整个进程树，避免残留
- 详见 `issues/ISSUE-005` ~ `ISSUE-008`、`issues/ISSUE-011`

#### Common Pitfalls (English)

| Issue | Lesson |
|-------|--------|
| Windows Chinese encoding | When spawning child processes with `shell: true`, stdin.write must use `Buffer.from(text, 'utf-8')` instead of string, otherwise Chinese characters become garbled (乱码). |
| Claude Code CLI process cleanup | Use `taskkill /pid <PID> /T /F` to kill entire process tree on Windows, not just `process.kill()` which leaves child processes hanging. |

### 安全红线

- **API Key 不经浏览器**：`/api/providers/import` 从服务端 config.toml 读取真实 apiKey，浏览器只传 provider name
- **API 响应不泄露 apiKey**：所有 GET 用 Prisma select 排除 apiKey；providers 用 maskApiKey() 返回掩码值
- **Mass Assignment 防护**：Agent PUT 白名单不含 status（设计决策#20）；Session PUT 白名单不含 phase/type/phaseStep（设计决策#8/#12）
- **iframe sandbox**：`allow-scripts`（设计决策#17），不含 `allow-same-origin`
- **成员列表**：agent select 排除 systemPrompt
- **shell:true 命令注入**：ClaudeCodeAdapter/OpenCodeAdapter 使用 `shell: true`，`permissionMode`/`sessionId`/`model` 等来自用户/数据库输入，必须验证后再传入 args
- **accept 路由 baseDir**：`target === 'project'` 时 baseDir 为 `process.cwd()`，客户端可覆盖源码，应改用 `session.projectDir`
- **所有 API 无认证**：16 个端点无任何认证/授权检查，公开部署前必须添加
- **中文乱码检测**：`POST /api/sessions` 检测 `hasLoneSurrogates(title)` 拒绝 GBK 误编 UTF-8 的请求，返回 400

### 适配器层

- `platform: 'claude-code'` → ClaudeCodeAdapter（stdin + bare 模式，支持 `--resume` 恢复会话）
  - 120 秒无输出超时（`noOutputTimer`），超时自动 killProcessTree
  - 3 分钟总超时（已有）
- `platform: 'llm'` → LLMAdapter（需要 ANTHROPIC_API_KEY 或 OpenAI API Key）
  - 支持 abortSignal 取消请求
- `platform: 'opencode'` → OpenCodeAdapter（JSON 事件流）
- Orchestrator 是特殊 Agent 记录（`isOrchestrator: true`），使用 CLI 适配器，回退到 LLM API
- 每个 Agent 可独立选择执行平台，各自配置 model/baseUrl/apiKey
- **Orchestrator 配置统一**：`getOrchestratorAgent()` 从 Agent 表读取；`callLLM`/`callLLMForAnalysis` 使用 Orchestrator Agent 的 platform/model/baseUrl/apiKey
- **CLI 自动检测**：`detectCLIPlatform()` 按优先级检测 claude-code → opencode，结果持久化到 Orchestrator Agent 记录
- **chunk 累加过滤**：所有 adapter chunk 累加（callLLM/callLLMForAnalysis/executeSingleAgent/executeTaskBatch/runDiscussion）必须过滤 `type === 'text' || type === 'error'`，不累加 status chunk；claude-code-adapter 的 result 事件只发 status，增量文本已通过 assistant 事件输出

### 多供应商配置

- Agent 表有 `model`/`baseUrl`/`apiKey` 字段，支持不同 Agent 使用不同供应商
- **LLM 供应商判断逻辑**：有 `baseUrl` → 默认用 OpenAI SDK（兼容 DeepSeek、Moonshot 等）；无 `baseUrl` + model 匹配 `gpt-/o1-/o3-` → OpenAI；其他 → Anthropic
- OpenCodeAdapter 通过环境变量传递 API key 和 base URL
- `/api/providers` 读取 `~/.cc-connect/config.toml` 和 `~/.claude/settings.json`（apiKey 返回掩码值）
- `/api/providers/import` 接收 provider name，后端从 config.toml 读取真实 apiKey（浏览器不传 apiKey）

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

安全校验：`validateDecision()` 拦截严重矛盾（alignment 中返回 done、execution 中回退 align_*、Q&A 循环超限）。

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
- 创建会话时自动为每个 Agent 创建独立子目录（英文标识，如 `frontend/`、`backend/`）
- 最近打开的目录存储在 `RecentDir` 表，API：`/api/recent-dirs`
- 聊天命令 `/permission auto` 或 `/permission default` 切换权限模式
- 输入 `/` 显示可用命令气泡提示
- ClaudeCodeAdapter 支持 `--permission-mode` 参数
- 详见 `docs/design/workspace-and-permissions.md`

### 工作区隔离

- 执行任务时创建 `workspaces/{sessionId}/task-{taskId}/` 隔离目录
- `src/lib/workspace.ts`：createTaskWorkspace / takeSnapshot / auditTaskWorkspace
- 审计：检测 Agent 是否修改了非声明文件（declaredFiles）
- 跳过：node_modules, .next, .git, workspaces

### Chat API Session Lock

- 同一个 session 的 chat 请求必须串行处理（per-session lock）
- 原因：并发请求会读到过时的 phaseStep，导致同一 handler 被触发两次
- 实现：`sessionLocks` Map + Promise chain，请求排队，stream 结束后 release
- **超时保护**：等待前一个请求超过 60 秒则跳过等待继续执行
- **abort 监听**：客户端断开时自动 release 锁
- **SSE 全局超时**：5 分钟无响应则强制关闭流
- **禁止移除 session lock** — 会导致对齐流程并发 bug

### 会话类型

- `type: 'orchestrator'` — Orchestrator 主会话，走对齐流程
- `type: 'group'` — 群聊，多 Agent 协作，通过拉群 Dialog 创建（可选 Agent）
- `type: 'private'` — 私聊，直接与单个 Agent 对话，跳过 Orchestrator

### 设计文档（必读）

- **v2 设计决策**：`docs/design/agenthub-v2-design-decisions.md` — 当前架构设计（混合执行层、Agent 预设池、群聊协作、工件驱动等）
- **工作区与权限**：`docs/design/workspace-and-permissions.md` — 项目目录、权限模式、Agent 子目录
- **实现计划**：`docs/design/implementation-plan.md` — 8 阶段任务拆分
- 参考资料：`docs/reference/anthropic-scaling-managed-agents.md`、`docs/reference/multi-agent-reference.md`
- 新增功能前必须对照 v2 设计决策文档

### 已知功能差距（开发前必看）

详见 `issues/ISSUE-DESIGN-未实现功能清单.md`，核心缺失：
- 纠偏范围 — 所有 Agent（CLI + LLM），LLM Agent 做语义核对，CLI Agent 做文件审计+语义核对
- 失败处理 — 无错误重试、熔断、用户操作面板（已有超时兜底）
- pin 消息 — Agent 级长期上下文未实现

## API 路由

| 方法 | 路径 | 功能 |
|------|------|------|
| GET | `/api/sessions` | 会话列表 |
| POST | `/api/sessions` | 创建会话（自动添加预设 Agent） |
| GET | `/api/sessions/[id]` | 会话详情 |
| PUT | `/api/sessions/[id]` | 更新会话 |
| DELETE | `/api/sessions/[id]` | 删除会话 |
| GET | `/api/sessions/[id]/messages` | 消息列表 |
| POST | `/api/sessions/[id]/messages` | 创建消息 |
| GET | `/api/sessions/[id]/agents` | 会话 Agent 列表（仅 Agent 对象） |
| GET | `/api/sessions/[id]/members` | 会话成员列表（含 role/joinedAt） |
| POST | `/api/sessions/[id]/members` | 添加成员到会话 |
| DELETE | `/api/sessions/[id]/members` | 移除会话成员 |
| GET | `/api/sessions/[id]/tasks` | Task 列表 |
| GET | `/api/sessions/[id]/files/[filename]` | 读取工作区文件 |
| POST | `/api/sessions/[id]/chat` | SSE 流式聊天（per-session lock） |
| POST | `/api/sessions/recommend-agents` | 推荐 Agent（LLM 分析任务） |
| GET | `/api/agents` | 全局 Agent 列表 |
| POST | `/api/agents` | 创建 Agent |
| PUT | `/api/agents/[id]` | 更新 Agent |
| DELETE | `/api/agents/[id]` | 删除 Agent |
| GET | `/api/providers` | CC-Switch 服务商列表 |
| POST | `/api/providers/import` | 导入服务商配置（传 provider name，后端从 config.toml 读 apiKey） |
| POST | `/api/sessions/[id]/files/accept` | 接受 Diff 变更写入文件 |
| POST | `/api/config/detect-platform` | 检测 CLI 可用性 |
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
