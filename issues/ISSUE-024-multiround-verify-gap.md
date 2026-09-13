# ISSUE-024 多轮对齐 verify 缺口
> 创建时间: 2026-09-13 | 状态: 🟢已解决

## 问题描述
ISSUE-008 的自动 verify 只覆盖第一轮代码任务：第二轮对齐新增代码任务时，
旧代码看到已存在 `verify-` 任务就直接跳过。若老 verify 已执行完，
第二轮代码静默零验证直接交付，UI 上还显示“有验证任务兜着”。

## 出现原因
`handleArchitectPlan`（`src/lib/services/alignment.ts`）的 verify 块是二选一：
无则建、有则跳过。老 verify 的依赖只挂建它那轮的代码任务 id，
后续轮次的新代码从未进入任何 verify 的依赖。

## 解决方案（条件式，2026-09-13，已拍板）
- 老 verify 仍 `pending` → 本轮新代码任务按 id 去重并入其依赖，描述用
  老任务（读库）+ 新任务重建；无新任务时静默无操作。
- 老 verify 已终结（completed/failed）或执行中（in_progress）→ 为本轮新建 verify
 （往终结任务上追加等于漏检；往执行中任务上追加门控已过，同样漏检）。
- 创建逻辑抽成 `createVerify` 复用；`EXPERIMENT_VERIFY` 开关、redo 不新建、
  测试工程师优先分配原样不动。

## 验证
- `tests/alignment.test.ts`：旧“不重复创建”用例按新语义改写
 （pending + 已覆盖 → 不建不更）；新增 4 用例（pending 追加含描述重建断言 /
  completed・in_progress・failed 各新建且描述隔离）。
- 全量 84 文件 / 1098 passed / 3 skipped。
- 变异 `=== 'pending'`→`!== 'completed'` 精确红 in_progress/failed 两例，还原全绿。
- `tsc` 经手文件 0 错误；`eslint` 仅剩基线旧 `any`（对照过 HEAD）。

## 相关文件
- `src/lib/services/alignment.ts` — 条件式 verify
- `tests/alignment.test.ts` — 改写 1 用例 + 新增 4 用例（含 `task.update` mock 键）

## 参考资料
- ISSUE-008（自动创建验证任务的由来）
- 拍板记录：条件式 vs 永远新建 vs 永远追加（2026-09-13 会话内确认）
