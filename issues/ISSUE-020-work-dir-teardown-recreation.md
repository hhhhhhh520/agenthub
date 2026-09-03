# work 目录 teardown 后重建疑点
> 创建时间: 2026-09-02 | 状态: 🟡排查中

## 问题描述
P9-乙 T5 强模型 45-run 批结束后，afterAll teardown（run.test.ts 文件级清理，rmSync force）无 warn 正常执行，但 `experiments/p5/work/` 末 7 个目录仍残留（疑 CLI 进程迟到写重建）。P10 期间 T6/T7 各批后又新增若干，2026-09-03 清理时存量为 436 个。

## 出现原因
疑点（未最终实锤）：CLI 子进程在 teardown 完成后仍有在途写（进程存活窗口 > vitest afterAll），或临时文件句柄延迟释放导致 rmSync 部分失败但无 warn。关联：vitest Temp/ssr 缓存 ENOENT（见 CLAUDE.md p5 节 flake 条目）同族——均为进程/文件系统生命周期与 vitest 假设不同步。

## 解决方案
P10 T8 一次性清理（436→0，2026-09-03）。缓解已在位：launcher v7 发射前孤儿进程闸门（--model 进程计数）+ 超时错位（内部 30min < vitest 35min，kill+finally 有 5min 余量，F7）。若后续批次再出现：记录目录名+时间戳与对应 runId 对照定位写入者，再定修法（teardown 延迟重试或 CLI 生命周期钩子）。

## 相关文件
experiments/p5/run.test.ts（afterAll teardown）、experiments/p5/run-one.ts（createdWorkDirs 注册）、experiments/p5/run-gate-smoke.ps1（孤儿闸门）

## 参考资料
P9-乙 T5 PROGRESS 行（末 7 目录无 warn 残留）；P10 plan F7 超时错位条款
