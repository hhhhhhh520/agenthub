# P5 受控实验 harness

验证"状态机比 LLM 自由推进更可靠"。决策走真实 LLM（glm-4.7-flash），执行 mock。
Spec: docs/superpowers/specs/2026-08-13-p5-controlled-experiment-design.md

## 运行
```bash
export GLM_API_KEY=...   # 智谱 key（永不硬编码）
npx vitest run --config experiments/p5/vitest.config.ts
```

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
