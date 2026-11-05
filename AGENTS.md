# AgentHub Agent 规则

## 代码修改前

1. 读 `CLAUDE.md` 了解项目结构和关键规则
2. 读 `issues/` 目录了解已知踩坑
3. 改聊天/任务面板/会话列表/智能体状态/等待态/引导前读 `docs/TODO-ux.md`（U1–U13 已完成；U14/U15 为 P2 遗留）
4. Prisma 操作前确认 v7 API（不是 v5/v6）；schema 变更用 `npx prisma db push`（勿跑 migrate dev，会要求 reset 丢数据）

## UX 身份与权限红线

- Agent 身份、OpenCode 权限、CLI session 失效的统一入口与红线见 `CLAUDE.md`「UX 身份与权限不变量」。
- 不要绕过 `buildAgentSystemPrompt` / `resolveSessionPermissionMode` / `invalidateAgentCliSessions` 另写一套。
- 系统提示文案变更必须在 `src/lib/system-events.ts` 做历史展示改写/标记；禁止修改 `Message.rawContent`。

## CI 门禁（GitHub Actions）

改动的 .ts/.tsx 必须过 eslint 0-error（tests/ 的 no-explicit-any 已放宽）；phase 写入架构守卫会拦截绕过 state-machine 的写法。test job 跑 windows-latest（测试是 Windows 平台假设）。详见 `CLAUDE.md`「CI 门禁」节与 `.github/workflows/ci.yml`。

## OpenCode CLI 兼容性（2026-11）

- 本机 opencode v2.2.5 已移除 `run --dir`：工作目录只靠 `spawn.cwd` + `PWD`，不要再加 `--dir`。
- 动态 agent 文件必须带 `--standalone`：后台服务会缓存 agent 列表，否则报 `Agent not found`。
- 决策/结构化调用要 `rawSystemPrompt`，不要套身份 + behavior 包装；工作目录用 `tmpdir()/agenthub-analysis`，避免加载项目 `AGENTS.md` 带偏 JSON 输出。

## 禁止行为

- 不要修改 `prisma/schema.prisma` 不了解关系
- 不要删除 `issues/` 目录的问题文档
- 不要在 `src/generated/` 下手动生成代码

## 依赖说明

- `@prisma/adapter-libsql` — Prisma v7 SQLite 适配器（必须）
- `@monaco-editor/react` — 代码 Diff 编辑器（客户端动态加载）
- `shadcn/ui` 组件在 `src/components/ui/`，通过 `components.json` 配置

## 环境变量

CLI 模式（默认）复用已有认证，无需额外配置。

Agent 通过 CC-Switch 导入或 Agent 级别配置（`agent.baseUrl`/`agent.apiKey`）。
CLI 可用性由 `detectCLIPlatform()` 自动检测，结果持久化到 Orchestrator Agent 记录。
