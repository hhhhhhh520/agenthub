# AgentHub Agent 规则

## 代码修改前

1. 读 `CLAUDE.md` 了解项目结构和关键规则
2. 读 `issues/` 目录了解已知踩坑
3. Prisma 操作前确认 v7 API（不是 v5/v6）

## 禁止行为

- 不要修改 `prisma/schema.prisma` 不了解关系
- 不要删除 `issues/` 目录的问题文档
- 不要在 `src/generated/` 下手动生成代码

## 依赖说明

- `@prisma/adapter-libsql` — Prisma v7 SQLite 适配器（必须）
- `@monaco-editor/react` — 代码 Diff 编辑器（客户端动态加载）
- `shadcn/ui` 组件在 `src/components/ui/`，通过 `components.json` 配置

## 环境变量

当前无需额外环境变量。Claude Code CLI 复用已有认证。
如需使用 LLM Adapter（`platform: 'llm'`），需设置 `ANTHROPIC_API_KEY`。
