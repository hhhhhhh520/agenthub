# 决策点 trace 记 applied:true 而 transitionPhase CAS 拒写（拒绝型 trace/DB 分歧）

> 创建时间: 2026-09-21 | 状态: 🟢已解决（2026-09-25，修法 A 变体落地——拒绝回执统一收口在 transitionPhase 内部）

## 问题描述

chat-router.ts 的决策点在派发 handler 前先 `appendDecisionTrace`（applied:true 条目），随后五个
transitioning case（done/align_confirm/align_decompose/align_qa/execute）的 handler 内部调用
`transitionPhase`——但 **handler 忽略 transitionPhase 的返回值**。§3.2 给 transitionPhase 加了快照
CAS 后，并发冲突 + 新态非法时 transitionPhase 会 fail-closed 拒写（DB 不动），而决策点 trace 已
记录 applied:true → trace 与 DB 永久分歧（"拒绝型"；§3.2 消灭的是"覆盖型"）。

## 出现原因

- P3/P4 设计决策点先落库再派发（Temporal 精神），当时 transitionPhase 只在"DB 异常"时失败且
  不击穿；决策点条目与 handler 实际写入之间没有回执链路。
- §3.2 CAS 使"拒写"成为并发下的正常路径（不再仅是异常），分歧暴露面变大。
- 自愈存在：phase 留旧值、下次决策重校验；但 checkConformance 看不见拒绝（trace 全绿）。

## 解决方案（已落地，commit 见 git log ISSUE-025）

**修法 A 变体**：不在五个 handler 里逐个补记，而是**统一收口在 transitionPhase 内部**——两个
"提议未落地"失败路径（合法性翻转 / CAS 快照冲突超限）各补记一条拒绝回执条目：

- `actualTransition: { from, to: from, action, applied: false, escalated: false, casRejected: true }`
- `recordTrace:false` 只抑制成功路径双记，**不抑制拒绝回执**（回执是与预记条目不同的事件）
- **分类纪律（审查钉死）**：拒绝回执绝不能伪装 escalated=true——合法转移被拒会被
  checkConformance 标 escalate_but_legal（代码漂移 bug）污染 ON 口径 oracle。casRejected
  独立成桶：`casRejectCount` 计数，不进 violations、不计 conforming。
- 变体优于工单原稿的理由：transitionPhase 是全部 7 个调用点（五 handler + redo 路由 + 代码驱动）
  的唯一写入口，单点收口覆盖面完整且无需改 handler 签名。
- **审查拍板（conforming 超计边界）**：拒绝场景下预记条目仍计 conforming（超计）——系存量、
  有界、方向保守（不制造虚假健康）；**不做配对抵消**（按 from/action/to 匹配在"同一转移稍后
  成功"时会吃错条目，脆弱性 > 有界超计）。语义注释已写入 ConformanceResult.conforming。

验证：变异 2 组精确红（删两处回执补记→恰 2 红；删 checkConformance 分类分支→恰 2 红）；
测试 5 用例（两失败路径回执 + recordTrace:false 不抑制 + 成功路径零变化 + 分类独立桶）；
根套件 1241 passed / 3 skipped；双独立审查 Agent 闭环。

## 后续残留（存量、非本修复引入，已评估）

1. handler 中止于 transitionPhase 之前的预记失真——`align_decompose` 派发后
   handleArchitectPlan false 返回（0 任务/超时 replan）时，预记称已应用而 DB 未动。
   有自愈（replan），checkConformance 不可见——同族问题、频率低，暂记录不修。
2. transitionPhase 另两条失败路径（冲突重读失败 / 外层 DB 异常）不写回执——DB 已坏时回执
   多半也写不进去，可辩护；如未来需要硬不变量再评估。
3. 回执占用 decisionTrace 500 条封顶额度——病态拒绝风暴会挤掉最旧条目（与已拍板封顶取舍一致）。
4. transitionPhase 拒绝对用户的可见性仍只有 console.warn（工单原稿的"顺带评估"）——
   trace 回执已可经 analytics 消费（casRejectCount 已在 API 返回），UI 展示待 §4.1 可视化升级一并考虑。

## 相关文件

- src/lib/orchestrator/state-machine.ts（rejectEntry/appendRejectTrace + 两条失败路径插桩）
- src/lib/orchestrator/decision-trace.ts（casRejected 类型 + casRejectCount + 分类分支）
- tests/transition-reject-trace.test.ts
- src/lib/services/chat-router.ts:170-190（决策点预记逻辑，未改动）

## 参考资料

- docs/design/phase2-3.2-write-points.md（§3.2 写入点清单与拍板）
- docs/design/roadmap-to-excellence.md §3.2 / 附录 B（"每个实际 phase 写入都入 trace 且不双记"不变量）
