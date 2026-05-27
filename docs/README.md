# AgentHub 文档索引

## 项目概览

| 文件 | 说明 |
|------|------|
| [README.md](../README.md) | 项目说明和使用方法 |
| [CLAUDE.md](../CLAUDE.md) | Claude Code 项目指令 |
| [AGENTS.md](../AGENTS.md) | Agent 配置说明 |
| [PROGRESS.md](../PROGRESS.md) | 项目进度追踪 |
| [课题.txt](课题.txt) | 竞赛课题要求 |

## 设计文档

| 文件 | 说明 |
|------|------|
| [design/initial-design.md](design/initial-design.md) | 初版设计文档（2026-05-19） |
| [design/initial-implementation-plan.md](design/initial-implementation-plan.md) | 初版实现计划（2026-05-19） |
| [design/agenthub-v2-design-decisions.md](design/agenthub-v2-design-decisions.md) | v2 架构设计决策（当前架构） |
| [design/implementation-plan.md](design/implementation-plan.md) | v2 实现计划（8阶段37项） |
| [design/workspace-and-permissions.md](design/workspace-and-permissions.md) | 工作区与权限模式设计 |
| [orchestrator-platform-refactor.md](orchestrator-platform-refactor.md) | Orchestrator 平台统一改造方案（CLI-first，✅已实施） |
| [design/borrowable-patterns.md](design/borrowable-patterns.md) | 从 cc-connect/multica/Anthropic 借鉴的待实施设计模式（7 个，P0-P3） |

## QA 测试报告

| 文件 | 说明 |
|------|------|
| [qa-reports/qa-static-2026-05-23.md](qa-reports/qa-static-2026-05-23.md) | 静态代码审查 + ESLint + 构建验证 |
| [qa-reports/qa-unit-tests-2026-05-23.md](qa-reports/qa-unit-tests-2026-05-23.md) | 单元测试报告（188 测试通过） |
| [qa-reports/qa-browser-2026-05-22.md](qa-reports/qa-browser-2026-05-22.md) | 浏览器测试 89/100 |
| [qa-reports/qa-browser-2026-05-23.md](qa-reports/qa-browser-2026-05-23.md) | 浏览器测试 92/100 |
| [qa-reports/screenshots/](qa-reports/screenshots/) | 浏览器测试截图 |

| [qa-reports/qa-code-review-2026-05-24.md](qa-reports/qa-code-review-2026-05-24.md) | 代码审查报告（4 Agent 并行，11 阻塞性问题） |

## 安全审计

| 文件 | 说明 |
|------|------|
| [design/full-audit-report-2026-05-25.md](design/full-audit-report-2026-05-25.md) | 全量代码审查报告（109 项问题，P0-P3 分级） |

## 参考资料

| 文件 | 说明 |
|------|------|
| [reference/anthropic-scaling-managed-agents.md](reference/anthropic-scaling-managed-agents.md) | Anthropic 托管 Agent 资料 |
| [reference/multi-agent-reference.md](reference/multi-agent-reference.md) | 多 Agent 框架对比参考 |

## 测试

| 文件 | 说明 |
|------|------|
| [TEST_CHECKLIST.md](TEST_CHECKLIST.md) | 功能测试清单 |

## 问题追踪

所有问题记录在 [`../issues/`](../issues/) 目录，按 ISSUE-XXX 编号排序。

---

## 快速导航

- 新手上手：README.md → CLAUDE.md → AGENTS.md
- 理解架构：design/agenthub-v2-design-decisions.md
- 查看进度：PROGRESS.md
- 查看问题：issues/ 目录
- 功能测试：TEST_CHECKLIST.md
- 测试报告：qa-reports/