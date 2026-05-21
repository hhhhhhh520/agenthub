# AgentHub

IM 风格的多 Agent 协作平台。用户通过聊天与多个 AI Agent 协作，Orchestrator 智能调度任务。

## 功能

- **三栏 IM 布局** — 会话列表 | 聊天区 | Agent 面板
- **三种会话** — Orchestrator 主会话 | 群聊（多 Agent 协作） | 私聊（1v1）
- **Orchestrator** — 系统级协调器，负责选人 + 拆任务 + 监督 + 纠偏
- **Agent 预设池** — 全局预定义 Agent，可配置模型和执行平台，跨会话复用
- **混合执行层** — LLM API（分析/讨论）+ Claude Code CLI（代码任务）
- **统一适配器** — 支持 Claude Code CLI、Codex、LLM API 多平台
- **对齐流程** — PM 确认需求 → 架构师确认技术方案+任务拆解 → 其他 Agent 提问
- **工件驱动** — Agent 通过结构化工件（API 契约、代码、测试报告）协作
- **SSE 流式** — 实时推送 Agent 输出
- **上下文管理** — 完整聊天历史 + Agent 级 pin 消息（跨会话）
- **失败处理** — 错误分类重试 + 降级 + 熔断 + 用户操作面板
- **Code Diff** — Monaco Editor 代码对比
- **Web Preview** — iframe 预览生成的网页

## 技术栈

- Next.js 16 (App Router)
- TypeScript
- TailwindCSS 4 + shadcn/ui
- Prisma 7 + SQLite
- Monaco Editor
- Claude Code CLI + Vercel AI SDK

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
