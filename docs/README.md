# AgentHub 文档索引

## 设计文档

- [v2 设计决策](design/agenthub-v2-design-decisions.md) — 22 项架构决策，当前有效的设计权威文档
- [工作区与权限](design/workspace-and-permissions.md) — 项目目录、权限模式、变更检测
- [实施计划](design/implementation-plan.md) — 8 阶段任务拆分
- [对齐流程](design/alignment-flow-plan.md) — Orchestrator 智能编排对齐流程
- [可借鉴模式](design/borrowable-patterns.md) — Session TryLock 等待实施模式

### 已归档

- [初始设计](design/initial-design-已弃用.md) — 已弃用，v1 设计
- [初始实现计划](design/initial-implementation-plan-已弃用.md) — 已弃用，v1 计划
- [全量审计报告](design/full-audit-report-2026-05-25-已归档.md) — 已归档，109项问题已修复
- [Orchestrator重构方案](orchestrator-platform-refactor-已实施.md) — 已实施

## 参考资料

- [Anthropic Managed Agents](reference/anthropic-scaling-managed-agents.md) — Anthropic 官方文章摘要
- [多Agent技术方案](reference/multi-agent-reference.md) — AutoGen/CrewAI/LangGraph 对比

## QA 报告

报告存放在 `.gstack/qa-reports/` 目录：

- [2026-05-28 QA](../.gstack/qa-reports/) — 7 项修复，评分 38→95
- [2026-05-29 QA](../.gstack/qa-reports/qa-report-localhost-3001-2026-05-29.md) — 8 项发现（2 严重），评分 52

## 问题追踪

- 🟡 [删除会话按钮](../issues/ISSUE-019-delete-session-button.md) — 点击无响应
- 🟢 [群聊向导Step1](../issues/ISSUE-018-group-chat-wizard-step1-已解决.md) — 已解决，后续修复顺带解决
- 🔴 [Orchestrator纠偏缺失](../issues/ISSUE-ORC-orchestrator纠偏缺失.md) — 核心协作机制未实现
- 🔴 [未实现功能清单](../issues/ISSUE-DESIGN-未实现功能清单.md) — 22项决策中多项不完整

已解决问题见 `issues/` 目录（文件名含 `-已解决`）。

## 项目根目录文档

- [README.md](../README.md) — 项目说明和快速开始
- [PROGRESS.md](../PROGRESS.md) — 项目进度和待办
- [CLAUDE.md](../CLAUDE.md) — AI 协作规则和项目速查
- [AGENTS.md](../AGENTS.md) — Agent 角色定义
