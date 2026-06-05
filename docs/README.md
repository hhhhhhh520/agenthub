# AgentHub 文档索引

## 设计文档

- [v2 设计决策](design/agenthub-v2-design-decisions.md) — 22 项架构决策，当前有效的设计权威文档
- [工作区与权限](design/workspace-and-permissions.md) — 项目目录、权限模式、变更检测
- [实施计划](design/implementation-plan.md) — 8 阶段任务拆分
- [对齐流程](design/alignment-flow-plan.md) — Orchestrator 智能编排对齐流程
- [cc-connect Agent 参考](design/cc-connect-agent-reference.md) — cc-connect 架构借鉴

### 已归档设计文档

- [适配器生命周期重构](design/adapter-lifecycle-refactor.md) — 已实施（2026-06-02）
- [CLI 进程恢复重试](design/cli-process-retry-plan.md) — 已实施（2026-05-30）
- [可借鉴模式](design/borrowable-patterns.md) — 代码验证后仅剩 2 个真实 bug（2026-06-03）
- [全量审计报告](design/full-audit-report-2026-05-25-已归档.md) — 109 项问题已修复
- [Skill 功能计划](design/skill-feature-plan.md) — 已评估不实施（2026-06-01）
- [初始设计](design/initial-design-已弃用.md) — v1 设计，已弃用
- [初始实现计划](design/initial-implementation-plan-已弃用.md) — v1 计划，已弃用

## 参考资料

- [Anthropic Managed Agents](reference/anthropic-scaling-managed-agents.md) — Anthropic 官方文章摘要
- [多 Agent 技术方案](reference/multi-agent-reference.md) — AutoGen/CrewAI/LangGraph 对比
- [cc-connect 可借鉴模式](reference/cc-connect-multica-borrowable-patterns.md) — Session TryLock 等模式分析

## QA 报告

报告存放在 `.gstack/qa-reports/` 目录：

- [2026-06-04 QA](../.gstack/qa-reports/qa-report-localhost-3099-2026-06-04.md) — 117 项检查，评分 87
- [2026-06-02 QA](../.gstack/qa-reports/qa-report-2026-06-02.md) — 最新 QA
- [2026-05-30 QA](../.gstack/qa-reports/qa-report-localhost-2026-05-30.md) — 评分 70
- [2026-05-28 QA](../.gstack/qa-reports/qa-report-localhost-2026-05-28.md) — 7 项修复，评分 38→95

归档报告见 `docs/qa-reports/`（2026-05-22 ~ 2026-05-24 早期报告）。

## 问题追踪

- 🟢 [Orchestrator 纠偏缺失](../issues/ISSUE-ORC-orchestrator纠偏缺失.md) — 全部解决（2026-06-04 验证）
- 🟢 [未实现功能清单](../issues/ISSUE-DESIGN-未实现功能清单.md) — 仅剩 1 项待办（ISSUE-FAIL-002 降级能力检查）
- 📋 [待办讨论结果](../issues/ISSUE-待办讨论结果-2026-06-04.md) — 5 项全部完成（2026-06-05）
- 🟢 [E2E 测试 Bug](../issues/ISSUE-E2E-端到端测试发现的bug.md) — BUG-001/002/003/004/005 已修复

已解决问题见 `issues/` 目录（已归档至 `issues/archive/`）。

## 项目根目录文档

- [README.md](../README.md) — 项目说明和快速开始
- [PROGRESS.md](../PROGRESS.md) — 项目进度
- [CLAUDE.md](../CLAUDE.md) — AI 协作规则和项目速查
- [AGENTS.md](../AGENTS.md) — Agent 角色定义
