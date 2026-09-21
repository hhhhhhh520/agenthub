# P5 受控实验 harness

验证"状态机比 LLM 自由推进更可靠"。决策走真实 LLM（deepseek-v4-flash，P5 实际运行），执行 mock。
Spec: docs/superpowers/specs/2026-08-13-p5-controlled-experiment-design.md
P6 扩展为 2×2 全矩阵（状态机 on/off × verify 有/无 = 4 配置 × 3 任务 × 5 seed = 60 run）：docs/superpowers/specs/2026-08-15-p6-full-matrix-design.md
P11 monitor A/B（2026-09-21，commit 471af12）：结构化监控信号 vs LLM 审查作纠偏触发器的检出对比，见下方专节。

## 运行
```bash
export GLM_API_KEY=...   # 实验 LLM key（env 名沿用 GLM_API_KEY 历史命名，端点见 setup.ts 默认 opencode.ai/zen/go；永不硬编码）
⚠️ 不要填智谱 key——该 key 会被发往 opencode.ai/zen/go，必须是该 provider（opencode.ai/zen/go）的 key
npx vitest run --config experiments/p5/vitest.config.ts
```

## P11 monitor A/B 跑批（与 legacy 批互斥）

```bash
export GLM_API_KEY=...
export MONITOR_AB=1       # 严格 '1'；设了只跑 monitor 批（legacy pilot 整体 skipIf 跳过）
npx vitest run --config experiments/p5/vitest.config.ts
```

- **两臂**：`on-monitor`（EXPERIMENT_STRUCTURED_MONITOR=on，结构化纠偏先行/LLM 降级第二道）vs `on-llmmon`（未设=生产默认 LLM 审，结构化信号记 monitor 事件=反事实）。
- **4 罐头 D-G**（tasks-monitor.ts，剧本 = mock executor 写真实文件让影子 git 检出 + 定型 result；监控审查两臂透传真实 LLM）：
  - D clean（双 pass 基线）/ E ghost 只写杂散文件（S1 命中）/ F schema 缺字段（S2 命中）/ G 自曝缺陷（结构化盲区、LLM 应纠偏）。
- **指标**：Task.trace 按 success 分段配对两判据（metrics.ts parseMonitorCycles，verify- 前缀任务排除）→ 触发率 / 混淆矩阵 / 跨臂 McNemar；报告 generateMonitorReport（afterAll console + 效度口径段必读）。
- **信号**：`monitor-batch-last.json`（独立于 legacy 的 p5-batch-last.json）；metrics.jsonl 由本批 beforeAll 重建。
- **判读边界**：on 臂结构化命中即纠偏、该 cycle LLM 不可观测（unset 臂补反事实面）；LLM 审 JSON 解析失败与"判无需纠偏"不可区分。详见报告效度口径段。

## 结构
- vitest.config.ts  独立 config（test.env 指向 p5.db、串行、小时级 timeout）
- config.ts         固化参数（报告回显）
- tasks.ts          3 档任务 + oracle 边定义
- mock-executor.ts  executeTaskBatch + monitoring mock
- setup.ts          p5.db 初始化 + 清 prisma 单例 + preflight
- run-one.ts        单次 run 驱动
- user-simulator.ts 暂停点自动回复
- metrics.ts        pass/失效模式采集 + JSONL 落盘
- stats.ts          bootstrap CI + 配对 McNemar + seed noise
- report.ts         对比报告
