# AgentHub

IM 风格的多 Agent 协作平台。用户通过聊天与多个 AI Agent 协作，Orchestrator 智能调度任务。

## 功能

- **三栏 IM 布局** — 会话列表 | 聊天区 | Agent 面板
- **拉群流程** — 描述任务 → LLM 推荐 Agent → 用户增减 → 确认建群
- **三种会话** — Orchestrator 主会话 | 群聊（多 Agent 协作） | 私聊（1v1）
- **Orchestrator** — 系统级协调器，负责选人 + 拆任务 + 监督 + 纠偏
- **对齐流程** — PM 确认需求 → 架构师确认技术方案+任务拆解 → 其他 Agent 提问
- **Agent 预设池** — 6 个预设 Agent（架构师/前后端/测试/PM/设计师），全局复用
- **多供应商** — 每个 Agent 可独立配置 model/baseUrl/apiKey，支持 CC-Switch 导入
- **混合执行层** — LLM API（Vercel AI SDK）+ Claude Code CLI + OpenCode CLI
- **SSE 流式** — 实时推送 Agent 输出
- **消息操作** — 回复引用、重新生成、复制代码、操作菜单
- **产物内联** — 代码块、Web 预览、文件卡片、Diff 视图（Accept/Reject）
- **工作区隔离** — 每个任务独立目录，文件声明 + 重叠检测 + 合并审计
- **Code Diff** — Monaco Editor 代码对比
- **Web Preview** — iframe 预览生成的网页

## 技术栈

- Next.js 16 (App Router)
- TypeScript
- TailwindCSS 4 + shadcn/ui
- Prisma 7 + SQLite
- Monaco Editor
- Vercel AI SDK + Claude Code CLI + OpenCode CLI

## 快速开始

```bash
npm install
npm run dev
```

打开 http://localhost:3000，创建会话，开始对话。

## 项目结构

```
src/app/api/         — REST API + SSE
src/components/      — UI 组件
src/lib/adapter/     — 适配器层（LLM / Claude Code CLI）
src/lib/orchestrator/ — 编排器（prompt + 调度 + 执行）
src/lib/hooks/       — React hooks
prisma/schema.prisma — 数据模型
docs/                — 设计文档和参考资料
issues/              — 开发问题记录
```

## 文档

- [v2 设计决策](docs/agenthub-v2-design-decisions.md) — 当前架构设计
- [Anthropic Managed Agents](docs/anthropic-scaling-managed-agents.md) — 参考架构
- [多 Agent 技术方案](docs/multi-agent-reference.md) — 框架对比
