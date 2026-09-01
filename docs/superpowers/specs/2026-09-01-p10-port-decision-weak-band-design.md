# P10 设计：移植回顾决策 × 弱模型探带（seqgate 变现 + H1′ 边界补全）

> 日期：2026-09-01 起草 | **状态：v2 双视角审查并入，待用户审阅**
> 项目：AgentHub A方向（显式状态机） | 上游：P9-乙 收官（spec v3.1、`results/report-p9b-strong.md`、规划 §9.2、接续 prompt）
> 定位：长期主线（用户拍板 2026-09-01「不缺预算」）。两主线+随手账：① seqgate 移植**回顾性决策**（离线）；② OpenRouter 中间带探带 +（条件触发）45-run 弱模型批（H1′ 最后空白，④顺带）。
> 审查记录：Security Engineer APPROVE_WITH_MINOR_CHANGES（F1-F13，4 High）+ 声明核查「事实基础可靠，修 4 不实+6 存疑后定稿」——全部并入本版，映射见 §8。

## 0. 已定论输入与更正

- P9-乙 T5：A off 3/on 2/seqgate 4；B 天花板；C off 0/on 0/**seqgate 4**；gate 触发与 pass 完全同现；「干预效应 ∝ 作用面」获直接支持。OFF vs ON 主效应三批 null。
- **⚠️ 统计口径更正（v2，审查发现）**：上表 C 的「p≈0.046 显著」出自无连续性校正渐近卡方（stats.ts:47）；b+c=4 时**精确 McNemar p=0.125**（教科书 b+c<25 应用精确检验）。**P10 起主报告口径 = 精确检验**；「seqgate 移动 C」降级表述为「方向性强证据（15 run 中 4 对 discordant 全朝 gate 方向、触发与 pass 完全同现），渐近口径显著/精确口径未达」。§0 其余与 §1 各假设以此为地基重排——H6 的在先证据变弱，恰是弱模型批值得跑的又一个理由。收尾时同步修正 memory/PROGRESS/规划/report 相关措辞。
- T6 负结果只封死「本地 ≤1.8B」路径；线上 3~9B 档未探。
- 线一探测事实（2026-09-01，只读实测，复核属实）：dev.db 会话 21（group 16/orchestrator 4/private 1），**含 decisionTrace 会话 = 0**（全部真实会话早于 P3 b74686b/08-11）→ 线一先天落三分支（§2.1）。
- 用户拍板：①价值=决策落档非修痛点；②「多候选探带，地板即收」；轻量通道 P11。

## 1. 假设（可证伪；推翻即落档，不临场补救）

| # | 假设 | 推翻条件 |
|---|------|------|
| **H4** | OpenRouter 付费 3~9B 档存在中间带模型（`off+verify×A` pass 1-4/5 且 skip/非法形态出现） | 全地板/全天花板 → 负结果落档、矩阵不开。**地板判据有环境有效性前置（§2.2-③），限流风暴不得被写成科学结论** |
| **H5** | 弱模型上 OFF vs ON 可测出差异（三批强 null 的反面） | 仍 null → H1′ 修正义务转 P11，「纠非法」作用面本身存疑 |
| **H6** | seqgate 优势在弱模型保持/放大（在先证据：§0 降级后表述） | seqgate ≤ ON → P9-乙 C 结果降级为能力条件性结论 |

线一无假设，只有决策规则（§2.1）。

## 2. 设计

### 2.1 线一：移植回顾决策（新脚本 `experiments/p5/analyze-port-replay.ts`，纯离线零 LLM）

**打开方式（F1/F6/F13 并入，替换 v1 的"@libsql 只读"错误声明——libsql 不支持 `?mode=ro`，analyze-cross-batch 的 createReadonlyDb 是前缀守卫非真只读，CTE-delete 实证可穿透）**：
1. 前置断言：应用未运行 **或** `dev.db-wal` 不存在/为空 → 把 dev.db（连同当时存在的 -wal/-shm）拷入 `results/snapshot-<ts>/`，**分析只碰副本**（open RW 句柄在 WAL 下会写生产文件集，实测）；
2. 独立 `createClient`（禁 import `@/lib/db`——prisma-libsql 会切 WAL 且 Windows 句柄不释放，setup.ts:131 实证）；连上首句 `PRAGMA query_only=ON` + **write-self-test**（故意 INSERT 必须 throw，否则中止）；脚本永不发 `PRAGMA journal_mode=`；
3. SQL 全参数化（勿继承 analyze-cross-batch:174 的字符串拼接），显式列名 SELECT，**禁查 Agent/Provider 表**（F13）。

**命中面判定（F10/F11 并入）**：trace 事件 `decisionPoint='handleOrchestratorDecision' ∧ inputState.state='idle' ∧ llmProposal.action='done'`（纠正前快照，chat-router:82-87——谓词可行性已双审实证）；taskCount 用**决策时刻口径**：`Task.createdAt <= entry.ts`（两者 `Date.parse` 后数值比较，raw libsql 时间戳是 TEXT ISO，**禁字符串比较**），终态计数并列出表；trace 触顶 500 的会话（截断丢最旧、idle 事件天然最前）单列不判命中，结论标「命中面为下界」。过滤 `id NOT LIKE 'p5-%'`（防实验数据混入未来复算）。

**fail-closed 前置闸门（F2 并入，先于三分支）**：`scannedRows>0 ∧ parseFailed==0 ∧ 路径为绝对 ∧ sha256 已记录` 全满足才允许输出分支结论，否则 exit 1。trace 非数组/畸形 JSON 计入 parseFailed 静默丢弃。**报告必含**：db 副本路径+sha256+mtime/size、journal_mode、按 type 计数、trace 三态计数（有/空/解析失败）、max(updatedAt) 快照边界。

**三分支规则（计量单位钉死：含 ≥1 条决策点 trace 的非 p5 会话数——v1 的"orchestrator 会话"口径作废，生产决策点不按 type 分流，group 会话同样入 trace，核查员实证）**：<20 → 落点三：维持 env 门控 + 启动条件（该单位 ≥20 且命中 ≥5 时重跑本脚本即出分支 2/3 数据）；样本足 → 人工复核首条用户消息意图（≤几十条人眼够，非 LLM-as-judge），误伤高 → 不转正负决策，误伤低 → 可转正+就绪评估（实施另立项）。按 §0 事实预期落分支三，脚本价值 = 把「没数据」变成可复算落档（R3 正当性）。

**产物边界（F8 并入）**：可提交物（规划/PROGRESS/memory）**只允许聚合数字与分支号**；sessionId/消息摘录只进 gitignored 报告，且摘录 JSON.stringify 包裹、剥控制符（含 ESC/U+202E）、`|`/换行转义、截 80 codepoint。

### 2.2 线二探带（pilot）

**候选（计划化 curl `/api/v1/models`+当日价核实钉死，4 个）**：付费 3~9B 低价带（qwen3-8b / llama-3.1-8b-instruct / qwen2.5-7b / glm-4-9b 级）。**不用免费档**（日限额与体量冲突、静默限流伪装失能=本 spec F3 同构事故）。上游条款标注：这是对 P9 spec「无上限换候选重探」的收紧修订（4 候选封顶即收线）；F1 轮换已豁免（PROGRESS 08-30 拍板，引用即可）。

**装置（「全复用」v1 措辞作废——审查发现 4 处真实缺口，以下为 P10 harness 改动清单，全在 experiments/ 内）**：
- ① 发射器 `run-gate-smoke.ps1` 扩展：每候选独立日志名（含 sanitize 后的 model+时间戳）；发射前若存在 `results/metrics.jsonl` 先自动归档为 `metrics.p10-pilot-<model>-<ts>.bak.jsonl`（F4：beforeAll rmSync 会销毁上一候选证据，T5/T6 手工备份纪律编进启动器）；批后断言行数==预期；**key 不上命令行**（删 $args[3] 通道，切换=逐候选编辑 `.env.local`——单槽位三元组是唯一真路径，v1 声明与实现矛盾修正，F9）；发射前断言 GLM_MODEL/GLM_BASE_URL/GLM_API_KEY 三值非空且**同批一致**，baseUrl 匹配 `^https://` + 主机白名单（openrouter/xfyun 域；GLM_BASE_URL 未设静默落已 ban 的 opencode 端点，核查员实证，F9）；
- ② `setup.ts preflightDecision` 加固：返回前 echo 耗时+HTTP 状态；错误签名黑名单（401/403/429/rate/quota/unavailable/"error" 壳）命中即 throw（v1「非空白即通过」会把 provider 错误文本判成就绪，F3）；
- ③ **地板分支环境有效性前置（F3 核心，防假负结果入库）**：仅当该候选 ≥1 run `rounds>=2 ∧ totalTransitions>0` 时，其「地板」读数才有效；否则判「环境无效」重探一次，仍无效则点名该候选除名，不得下 H4 结论；每候选批后 log grep `429|overloaded|retry-after` 为读分固定前置；**探带批末控制组哨兵**：deepseek@xfyun 重跑 1 次 preflight，控制组也退化 ⇒ 判环境不判模型；
- ④ 中间带标准沿 P9：pass 1-4/5 + skip/非法形态。≥1 合格 → 取 pass 率最接近 2.5/5 的**单模型**进 §2.3（R4 防临场扩列）。

### 2.3 矩阵：弱模型 45-run（条件触发）

- 三臂（P9_ARMS=1）×A/B/C×5=45，卷子/oracle 同 P9-乙 保可比；`GLM_*` 切到合格候选。
- **超时错位（F7）**：vitest testTimeout/hookTimeout → 35min，CONFIG.timeoutMs 保持 30min——内部 deadline 必先触发，kill+finally+teardown 有 5min 余量（v1 同值=清理窗口为零，弱批常撞顶必炸孤儿 CLI/丢 metrics，且即 ISSUE-020 疑点的成因形状）；**批前孤儿进程闸门**（node/claude/opencode 命令行含 `--model` 计数=0 才发射）。
- **配对口径修正（核查④）**：McNemar 是**每 task 5 对**（全文不存在 15 对合并检验，v1「n=15/臂×task」措辞作废；stats.ts:33 注释同错，随手修）；**主对比 OFF vs ON（H5）、ON/OFF vs seqgate（H6）三对配对 report.ts 已在位（已核）**；显著性主口径=**精确 McNemar**（§0 更正的制度化：新增 `mcnemarExact` + 测试，report 双口径并列输出，渐近仅作历史可比）。
- 批次纪律：跑前备份、`detectBatchContamination` 判阴（新脚本内联 NormRow 映射，**不改** analyze-cross-batch 的 `BatchId='P6'|'P7'|'P8'` 闭联合，核查⑧）、trace 抽查；report 增 `## 环境快照` 段（v1「已在位」不实——三开关/P7_GATE_CELL/P9_ARMS/seed 集/model/baseUrl/key 指纹 sha256 前 8 位，**无任何密钥本体**；这是 P9-F4「人眼终检」条款的补票，F5）；bootstrap CI 非种子化声明沿 P9（只比 pass 数组不比 CI 端点，F12）。
- ④顺带：A 格三臂 +15 run（弱维），报告与强批**并排呈现，跨模型不构成配对、不做合并显著性声明**。

### 2.4 随手账

1. `work/` 实测 412 个条目：无实验进程时一次性清空；「teardown 后目录重建」立 **ISSUE-020**（v1 的 014 编号已被占用，archive 排到 019——本条即编号无守卫的历史注脚）。
2. vitest 长批 flake 复跑约定一行进 CLAUDE.md p5 节；**同批修 CLAUDE.md:284 include 清单过期行**（实际已含 analyze-cross-batch.test.ts，核查附带发现）。
3. `.env.example` PORT=8080 幽灵——**审查拿到强线索（待验证）**：task C 罐头指令原文就是「把项目根 .env.example 端口 3000 改成 8080」（tasks.ts:36），work/*/.env.example 存在 PORT=8080 残留 ⇒ 疑为某次 run 的执行 CLI cwd 回落到仓库根。计划化阶段沿 cwd 链路验证，成立则记 ISSUE（harness 环境缺陷），用户侧无需再查。

## 3. 不做（P11 候选，防本批膨胀）

轻量决策通道｜余类闸门③｜A 独立功效设计④正式版｜多候选对比矩阵｜任务族重构｜posture｜seqgate 转正实施。

## 4. 验证

1. `analyze-port-replay.ts` TDD：fixture 覆盖三分支各一 + **空壳/错路径库必须 exit 1 不落分支三** + trace 非数组计入 parseFailed + 决策时刻 vs 终态两列 + 截断会话除名 + write-self-test 真拦（对副本）。新测试文件进 p5 vitest.config include（CLAUDE.md 规则在位）。
2. `mcnemarExact` 单测（b=0,c=4 → p=0.125 锚点；对称性；p≤1 上限）；launcher 断言逻辑可抽 ps 函数手测（ps 不进 vitest，发射前 `-t` 预检：preflight+三值断言+日志出现）。
3. 探带/矩阵批机器判据（F12 替代人眼）：批后 log 解析 vitest 摘要行，`skipped==0 ∧ passed==预期`，不符该批作废；发射后验日志文件出现。
4. 改动针对性测试 + pre-commit 三视角审查 + **launcher 既有 gate/无参模式回归冒烟**（改启动器不破 P9 复现路径，R8）。

## 5. 风险

| # | 风险 | 缓解 |
|---|------|------|
| R1 | 限流/失能与「地板」结论形式同构 → 假负结果入库 | §2.2-③ 环境有效性前置+控制组哨兵+429 grep（已从"人眼看 latency"升级为结构判据） |
| R2 | 弱模型 hang 拖垮批 | 30/35 超时错位+pilot 早停+孤儿闸门 |
| R3 | 明知空账本仍建脚本=过度工程质疑 | 脚本即启动条件复算工具；预算半天含测试；纯查询导出零新依赖 |
| R4 | 双合格临场扩列 | 定死单模型 |
| R5 | 弱批被当强批续读 | 环境快照段（本次交付）+文件名回显+④并排不合并 |
| R6 | 发射环境中毒 | scrub 内置在位（已核）；绕 harness 直 spawn 属红线 |
| R7 | 统计口径更正引发「P9 结论被推翻」误读 | §0 措辞精确：降级的是显著性标签，非「0/5→4/5 同现」的方向证据本身；双口径并列报 |
| R8 | 启动器/harness 改动破坏 P9 复现路径 | §4-4 回归冒烟；src/lib 零改动红线不变 |

## 6. 相关文件

- 新增：`experiments/p5/analyze-port-replay.ts` + test（+ vitest.config include 行）
- 改动（全在 experiments/ 内，v1「复用不改」清单据此更正）：`run-gate-smoke.ps1`（独立日志名/自动归档/三值+baseUrl 断言/行断言/删 key 通道）、`setup.ts`（preflight 黑名单+耗时回显）、`report.ts`（环境快照段+精确 p 并列）、`stats.ts`（mcnemarExact+注释修正）、`CLAUDE.md`（flake 行+include 清单行）
- 不改：`src/lib/**`（零改动红线）、metrics.ts、run-one.ts、analyze-cross-batch.ts、config.ts
- 数据：dev.db 快照副本、`results/`（gitignored）、`metrics.p10-*.bak.jsonl`、`issues/ISSUE-020-*`

## 7. 产出

探带裁决（H4）→（条件）45-run + H5/H6 精确口径裁决 + 移植决策落档 + 统计口径更正同步（memory/PROGRESS/规划/report-P9 措辞）+ 随手账清。若立项实施走 plan→SDD 老流程。

## 8. 审查并入映射

Security：F1/F6/F13→§2.1 打开方式；F2→fail-closed 闸门；F3→§2.2-③+R1；F4→launcher 扩展①；F5→§2.3 环境快照；F7→§2.3 超时错位；F8→§2.1 产物边界；F9→§2.2-①；F10/F11→§2.1 判定；F12→§4-3/§2.3 CI 声明。声明核查：❌1→ISSUE-020；❌2→环境快照改「交付项」；❌3→key 通道删除+.env.local 单槽路径；❌4→每 task 5 对口径；⚠️5→§0 更正；⚠️6→决策时刻 taskCount；⚠️7→计量单位；⚠️8→NormRow 内联；⚠️9→launcher 全套；⚠️10→上游条款标注（§2.2/§2.1 已写）。
