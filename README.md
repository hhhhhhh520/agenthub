# AgentHub

IM 风格的多 Agent 协作平台。通过 Orchestrator 自动拆解任务、组建团队、分配执行，支持 SSE 流式输出和实时任务看板。

## 功能

- **三栏 IM 布局** — 会话列表 | 聊天区 | Agent 面板
- **Orchestrator** — 自动分析任务类型、生成 Agent 角色、拆解子任务
- **统一适配器** — 支持 Claude Code CLI 和 LLM API 两种后端
- **SSE 流式** — 实时推送 Agent 输出
- **任务看板** — 拓扑排序调度，支持依赖关系和并行执行
- **Code Diff** — Monaco Editor 代码对比
- **Web Preview** — iframe 预览生成的网页

## 技术栈

- Next.js 16 (App Router)
- TypeScript
- TailwindCSS 4 + shadcn/ui
- Prisma 7 + SQLite
- Monaco Editor
- Claude Code CLI

## 快速开始

```bash
npm install
npm run dev
```

打开 http://localhost:3000，创建会话，开始对话。

无需额外 API key，复用 Claude Code CLI 已有认证。

## 项目结构

```
src/app/api/         — REST API + SSE
src/components/      — UI 组件
src/lib/adapter/     — 适配器层（LLM / Claude Code CLI）
src/lib/orchestrator/ — 编排器（prompt + 调度 + 执行）
src/lib/hooks/       — React hooks
prisma/schema.prisma — 数据模型
```

## 已知问题

见 `issues/` 目录，包含 10 个开发过程中遇到的问题和解决方案。
