# 决策点 trace 记 applied:true 而 transitionPhase CAS 拒写（拒绝型 trace/DB 分歧）

> 创建时间: 2026-09-21 | 状态: 🟡排查中（§3.2 攻击者审查发现，属存量问题、CAS 化后暴露面变大）

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

## 解决方案（候选）

- 方案 A：handler 收到 ok:false 时补记一条 corrections/escalated 条目（trace 可见拒绝）。
- 方案 B：决策点条目延后到 handler 回执后落库（改"先落库再派发"时序，动 P3 不变量，成本高）。
- 建议 A；顺带评估 transitionPhase 拒绝时对用户的可见性（当前仅 console.warn）。

## 相关文件

- src/lib/services/chat-router.ts:214-251（五个 case 忽略返回值）
- src/lib/orchestrator/state-machine.ts（transitionPhase fail-closed 拒写路径）
- src/lib/orchestrator/decision-trace.ts（appendDecisionTrace / checkConformance）

## 参考资料

- docs/design/phase2-3.2-write-points.md（§3.2 写入点清单与拍板）
- docs/design/roadmap-to-excellence.md §3.2 / 附录 B（"每个实际 phase 写入都入 trace 且不双记"不变量）
