# AgentHub 项目进度
> 创建时间: 2026-05-21 | 最后更新: 2026-05-21

## 项目概述
**项目地址**: D:\ai全栈挑战赛\agenthub | **技术选型**: Next.js 16 + TypeScript + Prisma 7 + SQLite + shadcn/ui | **目标**: IM 风格多 Agent 协作平台

## 当前进度
### ✅ 已完成
| 阶段 | 内容 | 文件 | 完成日期 |
|------|------|------|----------|
| 设计决策 | 22 项 v2 设计决策全部确认 | docs/agenthub-v2-design-decisions.md | 2026-05-21 |
| 数据模型 | Prisma schema 对齐 v2 设计 | prisma/schema.prisma | 2026-05-21 |
| 数据库迁移 | 重置并迁移数据库 | prisma/migrations/20260521093512_v2_schema | 2026-05-21 |
| 实现计划 | 8 阶段 37 项任务拆分 | docs/implementation-plan.md | 2026-05-21 |
| 阶段1 | 基础层 API（12项子任务） | members/agents/messages routes + parser + 前端适配 | 2026-05-21 |

### ⏳ 进行中
| 任务 | 状态 | 预计完成 |
|------|------|----------|
| 无 | - | - |

### 📋 待办
| 优先级 | 任务 | 说明 |
|--------|------|------|
| P0 | 实现计划拆分 | 将 22 个设计决策拆成可执行的开发任务 |
| P1 | SessionMember CRUD | 会话成员管理 API |
| P1 | 全局 Agent 池管理 | Agent 创建/编辑/删除 API |
| P1 | 用户自建 Agent | 对话式创建 + 表单创建 |
| P1 | 消息操作 | 回复引用、重新生成、复制代码 |
| P1 | 产物内联 | 代码块、网页预览、文件附件、Diff 视图 |
| P1 | Orchestrator 对齐流程 | 选人 + 拆任务 + 阶段控制 |
| P1 | 会话恢复 | sessionID 持久化 + --resume 恢复 |
| P1 | 接入 OpenCode | 第二个 CLI 平台 |
| P2 | 一键部署 | 聊天中部署指令 |
| P2 | 多端支持 | 桌面端 + 移动端 |

## 修改历史
### 2026-05-21 数据模型 v2 对齐
**修改文件**: prisma/schema.prisma, src/app/api/sessions/route.ts, src/app/api/sessions/[id]/route.ts, src/app/api/sessions/[id]/agents/route.ts, src/app/api/sessions/[id]/chat/route.ts, src/components/chat-area.tsx, src/lib/hooks/use-chat.ts
**修改内容**:
- Session 新增 `type` 字段
- Agent 改为全局共享，新增 model/tools/isPreset/accentColor/capabilities
- 新建 SessionMember 中间表
- Message.content → Message.rawContent，新增 replyToId
- Task 新增 declaredFiles/workspacePath，删除 subtasks
- 所有 API 路由和前端组件同步更新
**修改原因**: 对齐 v2 设计决策文档中的数据模型设计

## 重要决策记录
| 决策 | 选择 | 原因 | 日期 |
|------|------|------|------|
| 执行层 | 混合模式（LLM API + CLI） | 全 CLI 模式进程开销大 | 2026-05-20 |
| Agent 池 | 全局共享 + SessionMember | 跨会话复用 | 2026-05-21 |
| 消息格式 | 存 rawContent，读取时解析 | 避免解析器变更导致数据 stale | 2026-05-21 |
| 接入平台 | Claude Code + OpenCode | 课题要求至少 2 个平台 | 2026-05-21 |
