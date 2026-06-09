# AgentHub 文档索引

## 设计文档

- [v2 设计决策](design/agenthub-v2-design-decisions.md) — 22 项架构决策，当前有效的设计权威文档
- [工作区与权限](design/workspace-and-permissions.md) — 项目目录、权限模式、变更检测
- [实施计划](design/implementation-plan.md) — 8 阶段任务拆分
- [对齐流程](design/alignment-flow-plan.md) — Orchestrator 智能编排对齐流程
- [cc-connect Agent 参考](design/cc-connect-agent-reference.md) — cc-connect 架构借鉴

已归档设计文档见 `docs/archive/`（v1 设计、审计报告、已实施重构方案等 7 个文件）。

## 参考资料

- [Anthropic Managed Agents](reference/anthropic-scaling-managed-agents.md) — Anthropic 官方文章摘要
- [多 Agent 技术方案](reference/multi-agent-reference.md) — AutoGen/CrewAI/LangGraph 对比
- [cc-connect 可借鉴模式](reference/cc-connect-multica-borrowable-patterns.md) — Session TryLock 等模式分析

## QA 报告

报告存放在 `.gstack/qa-reports/` 目录：

- [2026-06-07 重测验证](../docs/qa-reports/screenshots/2026-06-07-retest/) — API Error修复验证+对齐流程重测，4截图，修复status chunk拼接问题
- [2026-06-07 全面QA](../docs/qa-reports/screenshots/2026-06-07-headless/) — Playwright无头浏览器全面测试，20+截图覆盖全部功能，发现4个问题（API Error显示/completed拼接/硬编码模型/API Key掩码），修复3个
- [2026-06-07 功能测试](../docs/qa-reports/screenshots/2026-06-07-functional/) — 15项功能测试：创建群聊✅ 消息发送✅ 搜索✅ 归档✅ 置顶✅ 私聊✅ 消息操作✅ 创建Agent✅ 删除✅ 编辑✅ /permission✅ @提及✅ Tasks✅ 权限确认✅
- [2026-06-08 综合E2E测试](../docs/qa-reports/2026-06-08-comprehensive-e2e.md) — 45项测试，40通过(88.9%)，发现2个Bug：API密钥未掩码🔴 GBK编码乱码🟡
- [2026-06-04 QA](../.gstack/qa-reports/qa-report-localhost-3099-2026-06-04.md) — 117 项检查，评分 87

归档报告见 `docs/qa-reports/archive/`（2026-05-22 ~ 2026-05-24 早期报告）。

## 代码审查

- [全面代码审查报告](CODE_REVIEW_REPORT.md) — 2026-06-06，安全/架构/性能/代码质量/API 四维度审查
- [核心逻辑审查修复](../PROGRESS.md) — 2026-06-07，19个bug验证，10个修复，655测试全通过

## 问题追踪

- 🟡 [未实现功能清单](../issues/ISSUE-DESIGN-未实现功能清单.md) — 仅剩 1 项待办（ISSUE-FAIL-002 降级能力检查）

已解决问题见 `issues/archive/`（24 个文件，含 E2E Bug、Orchestrator 纠偏、待办讨论等）。

## 项目根目录文档

- [README.md](../README.md) — 项目说明和快速开始
- [PROGRESS.md](../PROGRESS.md) — 项目进度
- [CLAUDE.md](../CLAUDE.md) — AI 协作规则和项目速查
- [AGENTS.md](../AGENTS.md) — Agent 角色定义
