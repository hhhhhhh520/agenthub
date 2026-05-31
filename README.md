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
- **混合执行层** — Claude Code CLI / OpenCode CLI 优先，LLM API 兜底
- **SSE 流式** — 实时推送 Agent 输出
- **消息操作** — 回复引用、重新生成、复制代码、操作菜单
- **产物内联** — 代码块、Web 预览、文件卡片、Diff 视图（Accept/Reject）
- **工作区与权限** — 用户指定项目目录，Agent 直接在项目中工作，权限模式（default/auto）
- **变更检测** — 每批任务执行后 Git diff 检测越界修改
- **任务重做** — 失败/阻塞任务可编辑描述后重新执行，自动级联下游任务
- **聊天命令** — `/permission` 切换权限模式，`/` 气泡提示
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
src/lib/adapter/     — 适配器层（LLM / Claude Code CLI / OpenCode CLI）
src/lib/orchestrator/ — 编排器（8 action 智能编排 + 调度 + 执行）
src/mcp-server/      — MCP 协作服务器（Agent 间共享工具）
src/lib/hooks/       — React hooks
tests/               — Vitest 单元测试（204 个测试）
prisma/schema.prisma — 数据模型
docs/                — 设计文档和参考资料
issues/              — 开发问题记录
```

## 文档

- [v2 设计决策](docs/design/agenthub-v2-design-decisions.md) — 当前架构设计
- [Orchestrator 平台改造](docs/orchestrator-platform-refactor-已实施.md) — CLI-first 架构改造方案（已实施）
- [对齐流程实现](docs/design/alignment-flow-plan.md) — Orchestrator 智能编排实现计划
- [Anthropic Managed Agents](docs/reference/anthropic-scaling-managed-agents.md) — 参考架构
- [多 Agent 技术方案](docs/reference/multi-agent-reference.md) — 框架对比
- [ChatFab 私聊计划](docs/plan-chatfab-private-chat.md) — 右下角私聊功能实现方案
