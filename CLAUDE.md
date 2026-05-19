# AgentHub — 多 Agent 协作平台

IM 风格的多 Agent 协作平台，Orchestrator 驱动任务拆解，统一适配器层，SSE 流式输出。

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
- Windows 上必须用 `shell: true` + stdin 传递 prompt（避免编码问题）
- 使用 `--bare` 跳过 hooks/plugins
- 详见 `issues/ISSUE-005` ~ `ISSUE-008`

### 适配器层

- `platform: 'claude-code'` → ClaudeCodeAdapter（stdin + bare 模式）
- `platform: 'llm'` → LLMAdapter（需要 ANTHROPIC_API_KEY）
- 当前 Orchestrator 强制使用 claude-code 平台

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
