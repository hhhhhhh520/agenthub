# .env.example PORT=8080 幽灵改动的根因链
> 创建时间: 2026-09-03 | 状态: 🟡根因已定位，修复留 P11（涉 src/lib，P10 红线不动）

## 问题描述
`.env.example` 出现 `PORT=8080` 幽灵改动（staged/工作区）共三次（P6/P7 期间、P9-乙 期间），每次均非人为，照例还原。来源 2026-09-03 定位。

## 出现原因（证据链闭合）
1. **罐头指令原文**：task C 的任务描述就是"把项目根目录 .env.example 里的端口从 3000 改成 8080"（`experiments/p5/tasks.ts:36`）；
2. **work 残留实证**：work/*/ 下存在内容含 `PORT=8080` 的 `.env.example`（任务在 work 目录创建过同名文件）；
3. **cwd 回落**：`src/lib/adapter/claude-code-adapter.ts:7` `const DEFAULT_WORK_DIR = process.cwd()` + `process-registry.ts:348` `cwd: workDir`——执行 CLI 的工作目录未被显式指定时回落到 **process.cwd()**，而实验批从**仓库根**发射 → 某些执行任务的 CLI 把罐头指令做在了真仓库的 `.env.example` 上。
时间相关性吻合：三次幽灵均出现在长批（P6/P7/P9-乙 45-run）期间，恰是 task C 执行窗口。

## 解决方案
建议（P11，属 src/lib 改动，P10 零改动红线不动）：harness 给执行任务显式传 workDir（实验任务永不落仓库根 cwd）；或 adapter 对 DEFAULT_WORK_DIR 加保护（禁止回落到含 package.json 的仓库根做写任务）。短期防御：发射前 `git status` 快照 + 批后 diff 巡检（T5 首发射时人工巡检已实证有效）。

## 相关文件
experiments/p5/tasks.ts:36（罐头原文）、src/lib/adapter/claude-code-adapter.ts:7、src/lib/adapter/process-registry.ts:348

## 参考资料
PROGRESS P9-乙 收官行（第三次出现记录）；P10 T8 Step4 线索验证任务
