# P10 设计：移植回顾决策 × 弱模型探带（seqgate 变现 + H1′ 边界补全）

> 日期：2026-09-01 起草 | 状态：**待安全审查** → 待用户审阅
> 项目：AgentHub A方向（显式状态机） | 上游：P9-乙 收官（spec v3.1、`results/report-p9b-strong.md`、规划 §9.2、接续 prompt `D:\ai全栈挑战赛\A方向-P10接续prompt.md`）
> 定位：长期主线（用户拍板 2026-09-01「不缺预算」）。P10 补两块：① seqgate 生产移植的**回顾性决策**（纯离线，零 LLM 消耗）；② 弱模型中间带探带 +（条件触发）45-run 矩阵——H1′ 研究线的最后一块空白。

## 0. 已定论输入（勿重议）与关键探测事实

- P9-乙 T5：seqgate 显著移动 C（b=0 c=4 p≈0.046），A 方向正不显著（p=0.317），B 天花板；OFF vs ON 主效应三批 null；「干预效应 ∝ 作用面」实证。
- T6 负结果：≤1.8B 过不动生产 CLI 通道（数十 KB system prompt 下崩坏）；讯飞 7B 无权限 403。**注意：这只封死了「本地小模型」路径，线上 3~9B 档未探**。
- 议题① 前置事实（2026-09-01 只读探测 `dev.db`）：会话共 21（orchestrator 4），**含 decisionTrace 的会话 = 0**（真实会话全部早于 P3 trace 上线）。→ 线一「样本充足」两个分支先天不可能命中，落点预定为三分支（见 §2.1），本 spec 按此预期撰写，脚本仍交付（复算资产，见 §5 风险表 R3 的正当性论证）。
- 用户拍板：AgentHub「基本不真实使用」→ ①的价值=决策落档而非修痛点；②失败分支「地板即收」，轻量通道留 P11。

## 1. 目标与假设（可证伪，H3 教训：每条钉死推翻条件）

| # | 假设 | 推翻条件（数据说「不」的样子） |
|---|------|------|
| **H4** | 线上 3~9B 付费档存在中间带模型：`off+verify×A` 探带格 pass 1-4/5 **且** 出现 skip/非法提案形态 | 全地板（trans≈0 全 defect）→ 负结果：生产 CLI 通道连 9B 档都不可用，弱模型线收线；全天花板（pass≥4.5 均值且零错误形态）→ 负结果：该能力档以下无错误样本可研究。两分支都**终止本批矩阵**，不做补救 |
| **H5** | 弱模型上 OFF vs ON 终于可测出差异（三批强模型 null 的反面假设）——状态机「纠非法」价值在错误产出率>0 的模型上显现 | 弱批 OFF vs ON 仍 null → H1′ 需修正：光换模型不够，「纠非法」作用面本身存疑（转 P11 议题，非本批补救） |
| **H6** | seqgate 优势在弱模型上保持或放大 | seqgate 臂 ≤ ON 臂 → P9-乙 C 显著可能只是强模型怪癖对上了靶点，通用性降级为「能力条件性」结论 |

线一无假设，只有**决策规则**（§2.1）。

## 2. 设计

### 2.1 线一：移植回顾决策（`experiments/p5/analyze-port-replay.ts`，纯离线）

- **数据源**：`agenthub/dev.db`（prisma `DATABASE_URL=file:./dev.db`），@libsql 只读打开（沿 P9-丙 F5 约束：只读、禁 eval、路径常量派生、输出消毒）。
- **分析**：解析 `Session.decisionTrace`，找 `decisionPoint='handleOrchestratorDecision' ∧ inputState.state='idle' ∧ llmProposal.action='done'` 的决策事件，join 该 session 的 Task count；`taskCount=0` 即 seqgate 命中面。导出命中清单（sessionId/时间戳/首条 user 消息摘录）供**人工**复核「真需求被偷懒 vs 闲聊收尾」（不做 LLM-as-judge）。
- **决策规则（三分支，先定死）**：
  1. 可分析 orchestrator 会话 <20 → **落点三：维持 env 门控不转正 + 记录启动条件**（真实会话 ≥20 且命中事件 ≥5 时重跑本脚本即出分支 2/3 数据）；
  2. 样本足且人工复核误伤率高（多数为闲聊自然收尾）→ **不转正，负决策带数据**；
  3. 样本足且误伤率低 → **可转正 + 就绪评估**（转正**实施**仍不在 P10，另立项）。
- 按 §0 探测事实，预期命中分支 1；脚本价值 = 把「没数据」从口头变成可复算的落档 + 未来决策随用随算。
- **产出**：`results/report-p10-port-decision.md`（results/ gitignored）+ 决策一句话进规划文档 §9.2/PROGRESS/memory。**生产代码零改动。**

### 2.2 线二：探带（pilot）

- **候选（计划化时 curl `GET /api/v1/models` + 当日价格核实后钉死名单，4 个）**：OpenRouter 3~9B 低价付费带，方向如 qwen3-8b / llama-3.1-8b-instruct / qwen2.5-7b-instruct / glm-4-9b 级。**不用免费档**（日限额 ~50 req 与探带体量冲突且静默限流伪装成模型失能——讯飞 v7 限流教训同构）；预算已拍板不限。
- **装置**：全复用——发射器 `run-gate-smoke.ps1` pilot 模式（`P7_GATE=1 P7_GATE_CELL='off+verify|A'`）、ISSUE-013 清洗、`GLM_MODEL/GLM_BASE_URL/GLM_API_KEY` env 切换（key 只进 `.env.local`，不上命令行）、CLAUDE_CONFIG_DIR 隔离与断言、模型 ID 白名单校验（F2 在位）。
- **每候选**：preflight 单调用通过 → `off+verify×A` ×5 run。中间带标准沿 P9 定死：pass 1-4/5 且 skip/非法形态出现。
- **裁决**：≥1 个合格 → 选 pass 率最接近 2.5/5 的**一个**（拍板前定死单模型，防「两好比较」临场加列）进 §2.3；全地板/全天花板 → 负结果落档，**本批收线**（H4 推翻条件即此），报告照出、矩阵不开。

### 2.3 矩阵：弱模型 45-run（条件触发）

- **规模与配对**：三臂（`P9_ARMS=1`）× A/B/C × 5 seed = 45 run，唯一变量=模型（强批 deepseek@xfyun vs 弱批 OpenRouter 候选），卷子/oracle/统计全同 P9-乙 保跨批可比。
- **批次纪律**：跑前备份 metrics；`detectBatchContamination` 判阴；DB trace 中毒抽查；afterAll teardown（迟到写残留立 ISSUE-014 观察不深查）。
- **统计**（stats.ts 现成 pairedMcNemar + report 三对配对已在位）：**主对比 OFF vs ON**（H5）；ON vs seqgate、OFF vs seqgate（H6）。n=15/臂×task，功效不足照 P9 口径声明（方向+置信区间，不过度宣称）。
- **议题④顺带**：A 格三臂各 +5 run（弱模型维），报告与强模型批**并排呈现**；跨模型不构成配对，**不做合并显著性声明**（防口径混用，P9-丙「两计数勿混用」同款警示）。

### 2.4 随手账（不占实验预算）

1. `work/` 存量目录（398+ 与 T5 末 7 个）：确认无实验进程后一次性清空；ISSUE-014 记「teardown 后目录重建」疑点待观察。
2. vitest 长批 flake（Temp/ssr ENOENT 三次，复跑即绿）→ 一行写入 `agenthub/CLAUDE.md` p5 运行姿势节。
3. `.env.example` PORT=8080 幽灵：用户侧查证，有结论记 PROGRESS。

## 3. 不做清单（P11 候选，防止本批膨胀）

轻量决策通道（H4 地板分支的补救）｜余类缺边闸门③（11/77，作用面小，统计注定不显著——「效应∝作用面」的直接推论）｜A 任务独立加 seed 功效设计④｜任务族重构｜posture 维度｜seqgate 转正实施。

## 4. 验证

1. 线一脚本 TDD：构造 fixture db（trace 含/不含 idle+done+0task 事件、脏 JSON 防御、三分支判定各一例），纯函数导出判定逻辑可单测；新测试文件**必须同步加进 `experiments/p5/vitest.config.ts` include**（P9-丙 教训）。
2. 探带前置硬检查：每候选 preflight 单调用（快速失败）；发射后**验日志文件出现**再离开（T5 静默空跑教训）。
3. 矩阵批：健康检查判阴 + trace 抽查 + 报告回显 env 快照/model 名（F4 人眼终检同款）。
4. 每改动针对性测试 + pre-commit 三视角审查照旧。

## 5. 风险与缓解

| # | 风险 | 缓解 |
|---|------|------|
| R1 | OpenRouter 限流伪装成模型失能，污染探带判读 | 用付费低价档；探带读分时先看 latency 分布异常（429/重试签名）再下 H4 结论；批间 `detectBatchContamination` |
| R2 | 弱模型 hang/超时拖垮批 | 30min timeout 已在位；pilot 先行即 Gate 早停 |
| R3 | 线一「明知空账本还建脚本」被质疑过度工程 | 脚本限定纯查询+导出（零外部依赖）；价值=启动条件复算工具 + 一次性手查变成可复核事实；实现预算 ≤ 半天含测试 |
| R4 | 两候选都合格引发临场扩列 | §2.2 已定死取 pass 率最居中的一个；扩列是 P11 决策 |
| R5 | 弱批被误当强批续读（跨模型不可比） | 报告文件名/表头强制回显 model；④并排不合并声明（§2.3） |
| R6 | 发射环境再次中毒（换机/换会话发射） | scrub 已内置 setupExperiment（ISSUE-013 修复）；绕 harness 直 spawn 属操作红线，CLAUDE.md 已有规则 |

## 6. 相关文件

- 新增：`experiments/p5/analyze-port-replay.ts`（+ test + vitest.config include 一行）
- 复用不改：launcher、config.ts、run-one、metrics、report、stats（45-run 三对配对 P9 已在位）
- 数据：`dev.db`（只读）、`experiments/p5/results/`（gitignored）、`metrics.p10-*.bak.jsonl`
- 文档：规划 §9.2、PROGRESS 完成表、memory、issues/ISSUE-014、CLAUDE.md（flake 一行）
