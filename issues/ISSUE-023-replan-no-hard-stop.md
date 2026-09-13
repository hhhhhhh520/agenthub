# ISSUE-023 replan 弹跳无硬终止
> 创建时间: 2026-09-13 | 状态: 🟢已解决

## 问题描述
架构师拆不出任务（0 任务或超时）→ 写 `[REPLAN]` → 等用户重述 → 再拆 → 再失败 →
再 `[REPLAN]`……循环无计数、无上限。若根因在模型侧（不稳定、输出恒解析失败），
用户重述多少次就烧多少次 LLM 调用，永不收敛，也永远不会告诉用户“别试了”。

## 出现原因
- `handleArchitectPlan`（`src/lib/services/alignment.ts`）的失败路径只写标记、不记轮数。
- 超时轮连标记都不落：计数无从谈起，且下一轮 `isReplan` 失效会回退到冻结首条需求
  （P2 待办④修过的同类 bug 在超时路径上依然存在）。

## 解决方案（2026-09-13）
- 新增纯函数 `countConsecutiveReplans`：倒序数连续 `[REPLAN]`，成功轮清零；
  上限 `MAX_REPLAN_ROUNDS = 3`（对标既有 `MAX_CORRECTION_RETRIES`）。
- 到顶硬停：不再调拆解，直接写 `[REPLAN-EXHAUSTED]` + error 事件 + 清输入提示，
  `return false`（调用方中止契约不变）。
- 恢复语义：`EXHAUSTED` 前缀刻意不命中 `[REPLAN]`——用户发新输入后计数清零自动再试，
  不死锁；复活轮按重述处理，用最新输入而非冻结首条。
- 超时轮同样持久化 `[REPLAN]`（计入计数 + 下轮用最新重述）。

## 验证
- `tests/alignment.test.ts` 新增 5 用例：计数器（含清零/断链）/ 3 连败硬停 /
  2 连败继续 / 超时记数 / EXHAUSTED 后新输入恢复（含最新输入选择）。
- 全量 84 文件 / 1094 passed / 3 skipped。
- 变异 `>=`→`>` 精确单红（3 连败用例），还原全绿。
- `tsc` 经手文件 0 错误；`eslint` 仅剩基线旧 `any`（对照过 HEAD）。

## 相关文件
- `src/lib/services/alignment.ts` — 计数器 + 硬停 + 超时标记
- `tests/alignment.test.ts` — 5 用例 + 共享 mock 补 `sessionMember.findUnique`

## 参考资料
- P2 待办④（`[REPLAN]` 标记与最新重述语义）
- `MAX_CORRECTION_RETRIES`（上限量级先例）
