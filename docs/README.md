# AgentHub 文档索引

## 设计文档

- [v2 设计决策](design/agenthub-v2-design-decisions.md) — 22 项架构决策，当前有效的设计权威文档
- [工作区与权限](design/workspace-and-permissions.md) — 项目目录、权限模式、变更检测
- [实施计划](design/implementation-plan.md) — 8 阶段任务拆分
- [对齐流程](design/alignment-flow-plan.md) — Orchestrator 智能编排对齐流程
- [cc-connect Agent 参考](design/cc-connect-agent-reference.md) — cc-connect 架构借鉴

## 参考资料

- [Anthropic Managed Agents](reference/anthropic-scaling-managed-agents.md) — Anthropic 官方文章摘要
- [多 Agent 技术方案](reference/multi-agent-reference.md) — AutoGen/CrewAI/LangGraph 对比
- [cc-connect 可借鉴模式](reference/cc-connect-multica-borrowable-patterns.md) — Session TryLock 等模式分析

## 审查报告

- [全面代码审查报告](reports/CODE_REVIEW_REPORT.md) — 2026-06-06，安全/架构/性能/代码质量/API 四维度审查
- [测试清单](reports/TEST_CHECKLIST.md) — 测试用例清单

## QA 报告

报告存放在 `qa-reports/` 目录：

- [2026-06-09 Playwright QA](../.gstack/qa-reports/qa-interactive-test-report-2026-06-09.md) — 无头浏览器测试：Provider导入✅、同平台多Agent协作✅、跨平台协作✅、消息发送✅，健康评分90/100
- [2026-06-08 综合E2E测试](qa-reports/2026-06-08-comprehensive-e2e.md) — 45项测试，40通过(88.9%)，发现2个Bug：API密钥未掩码🔴 GBK编码乱码🟡
- [2026-06-07 全面QA](qa-reports/screenshots/2026-06-07-headless/) — Playwright无头浏览器全面测试，20+截图覆盖全部功能
- [2026-06-07 功能测试](qa-reports/screenshots/2026-06-07-functional/) — 15项功能测试全部通过
- [2026-06-07 重测验证](qa-reports/screenshots/2026-06-07-retest/) — API Error修复验证+对齐流程重测

归档报告见 `qa-reports/archive/`（2026-05-22 ~ 2026-05-24 早期报告）。

## 已归档文档

存放在 `archive/` 目录，按生命周期分类：

- `archive/已实施/` — 已完成的计划和重构方案
- `archive/已弃用/` — 已废弃的设计和计划
- `archive/参考报告/` — 外部分析报告和参考资料

## 项目根目录文档

- [README.md](../README.md) — 项目说明和快速开始
- [PROGRESS.md](../PROGRESS.md) — 项目进度
- [CLAUDE.md](../CLAUDE.md) — AI 协作规则和项目速查
- [AGENTS.md](../AGENTS.md) — Agent 角色定义
