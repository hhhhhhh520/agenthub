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

### 适配器层

- `platform: 'claude-code'` → ClaudeCodeAdapter（stdin + bare 模式）
- `platform: 'llm'` → LLMAdapter（需要 ANTHROPIC_API_KEY）
- `platform: 'codex'` → 待实现
- v2 设计：混合执行层，Orchestrator 用 LLM API，代码 Agent 用 CLI
- 每个 Agent 可独立选择执行平台

### 设计文档（必读）

- **v2 设计决策**：`docs/agenthub-v2-design-decisions.md` — 当前架构设计（混合执行层、Agent 预设池、群聊协作、工件驱动等）
- 参考资料：`docs/anthropic-scaling-managed-agents.md`、`docs/multi-agent-reference.md`
- v1 设计差距：`issues/ISSUE-012`（已被 v2 设计取代）
- 新增功能前必须对照 v2 设计决策文档

## API 路由

| 方法 | 路径 | 功能 |
|------|------|------|
| GET | `/api/sessions` | 会话列表 |
| POST | `/api/sessions` | 创建会话 |
| GET | `/api/sessions/[id]` | 会话详情 |
| DELETE | `/api/sessions/[id]` | 删除会话 |
| GET | `/api/sessions/[id]/messages` | 消息列表 |
| GET | `/api/sessions/[id]/agents` | Agent 列表 |
| GET | `/api/sessions/[id]/tasks` | Task 列表 |
| POST | `/api/sessions/[id]/chat` | SSE 流式聊天 |
| POST | `/api/deploy` | 模拟部署 |

## 运行

```bash
npm run dev     # 开发
npm run build   # 构建
```

无需额外 API key，复用 Claude Code CLI 已有认证。
