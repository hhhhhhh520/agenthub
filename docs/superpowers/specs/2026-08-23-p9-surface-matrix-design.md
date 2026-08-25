# P9 受控实验设计：干预作用面 × 模型能力矩阵（跨批指纹 → 三臂矩阵）

> 日期：2026-08-23 起草，2026-08-24 拍板收口 + 安全审查并入 | 状态：设计定稿 v3（v1 第三臂前提被源码证据推翻后修正；核心决策全部拍板；安全审查 APPROVE_WITH_MINOR_CHANGES，findings 已并入；下一步计划化）
> 项目：AgentHub A方向（显式状态机） | 上游：P8 收官（`results/report.md` + 规划 §9.2）
> 定位：P9 是「模型是第一实验变量」新认知下的重设计，含两段：**丙**（跨批离线分析，零新数据）→ **乙**（三臂 × 强弱模型新实验）。乙的参数由丙产出校准。

## 0. 修订记录

- **v2 关键更正（前提推翻）**：实验决策流直通生产代码（`run-one.ts:86` 调 `handleOrchestratorDecision`），ON 格从来都是 canonicalCorrect + `idleExecuteGate`（state-machine.ts:163）+ 转移表三件捆绑——v1「第三臂=把生产闸门接进实验」不成立。且闸门已是局部补缺失机制（拦 idle 直发 execute→强制补 decompose，chat-router.ts:109-113），只覆盖「缺拆解」一类。`correctionCount` 为混合口径（canonicalCorrect/闸门/done 守卫三类重定向共写一个 corrections 数组，push 点 ：100/:111/:121/:129）。由此结论精化：现有干预族对非法类错误覆盖完整、对缺失类错误仅覆盖「缺拆解」子集。
- **v3 安全审查并入**：双视角独立审查（声明-vs-实现 14 条逐项核实全属实；Security Engineer F1-F8 无 High/Critical，APPROVE_WITH_MINOR_CHANGES），findings 全部落进 §4/§5/§6/§8。
- **v3.1 靶点裁定（2026-08-26 探针，tmp 脚本已清）**：77 个「曾推进且缺边」会话逐条解剖——**66/77 为同一家族：bypass 循环（self/delegate/verify）后从 idle 直接提议 done 收尾，且 66/66 taskCount=0**；提议谱：done=72（idle 发出 66）、align_decompose 仅 8、execute 仅 9；ON 臂 42 缺边会话现有干预族仅触发 3 次。关键机制：idle+done 是转移表内容错边（state-machine.ts:60），每条单边都合法，「缺失」在序列层而非单边层——canonicalCorrect 规则1 只覆盖 align 态 done、done 守卫只覆盖 exec 态 done，idle 态过早 done 是干预空白。**seqgate 靶点据此定为「idle 过早 done 闸门」：state=idle ∧ action=done ∧ taskCount=0 → redirect align_decompose（表内合法目标）**。确定性信号用 taskCount（不可让 LLM 自证，沿 §10.2 精神）；取占比最高类做最小扩展（§6 风险表既定规则），余类（缺 execute:*→exec 等 11 会话）入 P10。

## 1. 问题

P8 在 DeepSeek-V4-Flash-0731 上测得状态机 ON/OFF 无显著差（12/30 vs 10/30，McNemar 全 p≥0.5）。统一口径（OFF=illegalProposalCount / ON=correctionCount，`report.ts:109` 已定义）下重算三批有效数据（数字已经独立 subagent python 重算复核）：

| 批次 | 模型@源 | 总 pass | 非法尝试合计（jsonl 口径）¹ | 非 pass 主导形态 |
|---|---|---|---|---|
| P6 | deepseek@Ark | 43/60² | OFF 共 1；ON corr 18 | 无 failKind 字段（罐头引导期） |
| P7 | stealth | 25/60 | OFF 共 2；ON corr 6 | skip 26 + defect 9 |
| P8 | deepseek@xfyun | 22/60 | OFF 共 6；ON corr 6 | **skip 23（占非 pass 61%）** + defect 15 |

> ¹ 统一取 jsonl 聚合口径。report.p6 权威口径下 P6 为 OFF 共 2 / ON corr 17——两源差异即溯源矛盾本身，见注 2 与 §4.1-6。
> ² P6 溯源矛盾：report.p6 内部自洽=42（on+verify 组 12）；jsonl=43（on+verify 组 13），corr/ill 亦错位（9vs10、1vs0）——jsonl 含事后重跑行，非生成 report 的原数据。

三个推论：

1. **强模型几乎不犯非法类错误**（去引导后全批非法尝试 2-6 次），转移表拦截器没有输入；模型实际犯的主导错误是缺失类（跳提案），现有干预族对该类的覆盖只有闸门的「缺拆解」子集。P8 的 null 不是「干预无效」，是**干预覆盖集与错误形态集错位**。
2. **H1′（P9 核心假设）：干预的可测效应要求 目标模型的对应错误类产出率 > 0**。要测出干预价值，要么换错误形态更丰富的模型（乙的弱模型维度），要么把干预覆盖扩到主导错误类（乙的新臂）。
3. **skipped-spec-edge 的确切缺边构成未知**：oracle 必需边三任务同集且不含 align_pm/align_qa（tasks.ts:17-41，只要 decompose/execute/exec态done 三条）；P8 报告记载 skip run 的 trans 仅 2-4——连最低三条边都不够，但具体缺哪条、done 边为何未按预期 applied 未记录。这是丙的第一问（DB 可答）。

**附带数据治理问题**：

- **P6 不可用作 provider 对照**：P6（Ark）与 P8（xfyun）虽同模型异源，但 P6 处于罐头引导期（P7 才去引导），provider 差异与任务 prompt 版本混淆。
- **quota-dead 批存在可检污染签名**（avgTrans≈0、rounds 打满、defect 全格灌满）——固化为批次健康检查函数（§4.1-5）。
- **work/ mkdtemp 泄漏在涨**：实测已 398 个目录（记载的 336 为旧快照，P8 试跑新增 ~62）。乙 ~90 run 将续泄——teardown 进计划化任务清单（§5-6）。

## 2. 目标（用户拍板）

> 拍板记录：2026-08-23 定证据双层（L1 过程层为主）与路线丙→乙；2026-08-24 经前提更正后确认三臂结构并拍板 verify 维度处理。

- **丙**：三批统一指纹表 + DB 逐 run 回放（缺边类型学 + corrections 成分分解）+ 作用面分析（H1′ 检验）+ 批次健康检查函数 + P6 溯源裁决。
- **乙**：在三臂 × 强弱模型矩阵上检验：
  - **H1（行为层，主证据）**：干预改变过程行为——corr 率 / 非法尝试率 / skip 率 / 闸门触发率随臂与模型变化；
  - **H2（结果层，辅证据）**：行为改变传导为 pass 差异，仅在特定模型×任务族成立；
  - **H3（序列闸门假设）**：把确定性闸门扩展到主导缺边类后，该缺边类的 run 转化为「规范路径完成」或「显式 escalate」，主要移动 A 任务（skip 集中区），不影响 C（self 循环另一形态），B 近天花板无空间——此为可证伪预测。

## 3. 已拍板决策（全部收口）

| 决策 | 结论 | 出处 |
|------|------|------|
| 证据分层 | **双层并重，L1 过程层为主**，pass rate 为辅 | 用户拍板 08-23 |
| 路线 | **丙→乙**，丙先行零成本降险 | 用户拍板 08-23 |
| 乙臂结构 | **三臂：OFF / ON现状 / ON-seqgate（序列闸门扩展）**。v1「接现成闸门」前提被 §0 推翻后重新拍板 | 用户拍板 08-24 |
| verify 维度 | **砍掉维度，固定 verify=on**（生产默认语义）。矩阵 = 三臂 × 3 task × 5 seed = **45 run/model**。理由：三轮证明 verify 主效应 null 且 mock 装置下结构性无感 | 用户拍板 08-24 |
| 配置命名约束 | 复用 `off+verify`/`on+verify`，新增 **`on-seqgate+verify`**，保 startsWith 前缀约定（三个消费点 metrics.ts:110/120/125、report.ts:113 已实证兼容） | 设计约束+审查实证 |
| posture 维度 | 后置。posture×ON 交互预期 null；行为方差角色由弱模型维度承担 | 08-23 讨论 |
| 任务族重构（原方向3） | 后置 P10。A/B/C 维持现状保跨批可比 | 08-23 讨论 |
| turn budget（原方向2） | 不做独立维度，L1 内被动观测 | 08-23 讨论 |
| P6 权威数据裁决 | **以 report.p6 为权威**（内部自洽），jsonl 标注含事后重跑行；指纹表脚注点名差异条目（含 §1 表注 1 的混源风险消除） | 随 v3 生效 |
| 弱模型选型 | ⏳ 唯一留白：讯飞 `GET $BASE/v1/models` 列候选 → 单格探带。中间带标准：pass 约 20%-80% 且出现 skip/ill 形态。**前置硬性动作：先轮换存量两把待轮换 key 再接新 provider（审查 F1）** | 丙后执行 |
| 乙强模型基准 | deepseek@xfyun（与 P8 直接可比） | 08-23 讨论 |

## 4. 设计

### 4.1 丙：跨批分析脚本 `experiments/p5/analyze-cross-batch.ts`

纯离线，两个数据源：三份 jsonl（快照层）+ `experiments/p5/p5.db`（回放层，trace 存于 `session.decisionTrace`）。产出 `results/report-cross-batch.md`：

1. **统一指纹表**：batch × config × task → n / pass / skip / defect / corr / ill / esc / avgRounds / avgTrans。schema 异构：P6 行无 failKind 记 `n/a`（DB 是否留存 P6 会话由脚本探测），加载器 total 不 throw（P7 F4/F6 教训）。
2. **缺边类型学（丙第一问）**：逐 skipped-spec-edge run 回放 decisionTrace，判定缺哪条必需边、done 边为何未按预期 applied——直接决定第三臂拦截靶点。开工首日探测 p5.db 各批会话留存；旧批缺失则降级仅 P8 批并在报告声明。脚注注明：decisionTrace 每 session 封顶 500 条（decision-trace.ts:57），maxRounds=30 下远低于上限，但未来放宽 rounds 后回放结论可能无声截断（审查 F8）。
3. **corrections 成分分解**：归类 canonicalCorrect / idleExecuteGate / done 守卫三类触发占比。归类信号用结构化字段（redirect 目标 action + 所处状态），不用自由文本 reason 子串（措辞漂移易碎，审查 F7）。
4. **统一非法尝试率段 + H1′ 结论**：作用面 vs 错误形态错位的三批证据链。
5. **批次健康检查函数** `detectBatchContamination(rows)`：签名 = avgTrans 低于阈值 && rounds 打满占比高 && defect 占比高（quota-dead 校准阳性、p8-final 断言阴性）。乙每批自动调用验伪。
6. **P6 溯源裁决输出**：report.p6 逐格数组 vs jsonl 实数对照表，差异条目点名（on+verify 组 pass/corr/ill 三处）。

**防御性约束（审查 F5，写入验收标准）**：(a) 回放解析纯数据检查，禁止 eval/new Function/动态 import；(b) 报告输出路径只用常量派生，文件名引用 batch 名/runId 等标识符时先消毒，杜绝穿越；(c) p5.db 以只读模式经既有依赖 `@libsql/client` 打开，禁止新增 better-sqlite3 类原生依赖（供应链收敛 + 避开 setup.ts 实证过的 Windows 文件锁/WAL 纠缠）。

### 4.2 乙 harness：第三臂「ON + 序列闸门扩展」

- **语义契约（v3.1 靶点已裁定）**：seqgate = **idle 过早 done 闸门**——`state=idle ∧ action=done ∧ taskCount=0` 时 redirect `align_decompose`。判定信号是 taskCount（代码查库，非 LLM 自证）；redirect 目标 align_decompose 在 idle 态 TRANSITIONS 表内合法；escalate 兜底出口保留（taskCount 查询异常等 fail-closed 路径）。约束沿规划 §10.2 精神：**跳步合法性由代码看任务数据判定，不可让 LLM 自证**。
- **实现纪律（含审查强制项）**：
  - 零新增 LLM call，纯确定性代码；
  - **第三开关显式命名 `EXPERIMENT_SEQGATE`，严格相等语义**（如 `process.env.EXPERIMENT_SEQGATE === 'on'`，禁止真值判断防残留值激活）（审查 F4-Medium 必办①）；
  - **`RunEnvSnapshot`/saveRunEnv/restoreRunEnv 扩为三变量**，防跨 run 残留污染（P6 T9 同款 bug 类，F4 必办②）；配套 T9 同款三变量回归测试（F4 必办③）；
  - **守卫带插入位置：canonicalCorrect 之后、与 idleExecuteGate 同层**——防规则 2（exec 态 align_*→execute）与 seqgate 形成 redirect ping-pong；每个拦截靶点断言 redirect 目标在当前态 TRANSITIONS 表内（表外落 escalate 是 fail-closed 安全但属实验噪声）（审查 F6）；
  - src/lib 改动边界：仅 env 门控实验分支（沿用 isExperimentOff 先例，env 未设生产行为不变），非门控逻辑零改动；
  - 新配置 `on-seqgate+verify`，`envForConfig`/report 分组/GATE 过滤同步扩展；
  - `gateInterventionCount?: number`（optional 保 JSONL 兼容），采集用结构化标记而非 reason 子串（F7 同源原则）。
- **与 ON 的唯一差异** = 对主导缺边类的确定性补救能力；其余行为完全一致——配对干净归因增量。

### 4.3 乙执行策略

- **Gate 早停沿用 P7 发明**：先单诊断格（建议弱模型 × `off+verify` × A ×5）读两信号：① 中间带确认（pass 1-4/5）；② skip/ill 形态出现。任一不达 → 换模型候选重探，不铺矩阵。
- **矩阵规模**：三臂 × 3 task × 5 seed = 45 run/model（verify 恒 on）；强模型 deepseek@xfyun 与弱模型各一轮。
- **provider 纪律（含审查升级项）**：
  - **CLAUDE_CONFIG_DIR 隔离从操作纪律下沉为 harness 强制断言**——bootstrap 显式设置并在 preflight 校验指向实验专属目录，不再依赖人工记忆（审查 F3；P8 已实证忘设后果=启动挂死）；
  - **候选模型 ID 白名单校验** `^[A-Za-z0-9._\/:-]+$` 后才可流入 spawn 参数（审查 F2：process-registry.ts:358 默认 shell:true 经 cmd.exe 拼接，畸形模型 ID 即注入面）；
  - 实验 key 不与交互会话共用额度；分批可续跑；先备份 metrics；跑完自动过健康检查。

### 4.4 统计与报告

- **L1 主证据**：各臂非法尝试率、skip 率、corr 成分率、闸门触发率、avgRounds/avgTrans；bootstrap CI。
- **L2 辅证据**：臂间两两配对 McNemar（同 task 同 seed）：OFF vs ON（P8 复现）、ON vs ON-seqgate（新臂增量）、OFF vs ON-seqgate；精确二项 p + 效应量。
- **报告新增 `## 作用面分析` 段**：每模型错误形态谱 × 各臂干预触发率对照；H3 检验 = 主导缺边类在 seqgate 臂的转化率。

## 5. 验证

1. **丙**：TDD——健康检查 quota-dead fixture 断阳、p8-final 断阴；跨批聚合对已知数字快照断言（P8 corr 总和=6 等，数字已经独立复算背书）；P6 缺 failKind 行 total 加载；DB 回放对 P8 已实证案例断言缺边判定正确。
2. **乙 harness**：序列闸门纯函数单测（条件满足放行 / 不满足 redirect 补走 / escalate 出口 / 边界 / redirect 目标在表内断言）；config 解析扩展 + startsWith 前缀兼容断言；**RunEnvSnapshot 三变量回归测试（T9 同款，F4 配套）**；**「漏加第三开关则 on-seqgate+verify 不得静默等同 on+verify」的显式防呆断言（F4 核心）**；optional 字段兼容旧行；env 未设时生产行为不变对照测试。
3. 单诊断格真实 LLM 冒烟 → Gate 判定 → 铺满矩阵。
4. 报告生成 + H1/H2/H3 逐条裁决 + 文档同步（规划 §9.2、PROGRESS、memory、会话归档、P10 接续 prompt）。
5. **每批 teardown `work/<runId>` 目录**（新增；存量 398 个泄漏目录另列一次性清理任务，不混入实验改动）。
6. 每改动针对性测试 + pre-commit 三视角审查照旧。

## 6. 风险与缓解

| 风险 | 缓解 |
|------|------|
| **漏加第三开关 → seqgate 臂静默退化为 ON 臂，实验必然 null 不可察觉**（审查 F4） | §4.2 三条必办 + §5-2 防呆断言；报告回显各臂 env 快照供人眼终检 |
| 序列闸门过度约束 → 死循环 defect 恶化 | escalate 兜底终态；诊断格 Gate 早停；gateInterventionCount 观测 |
| 主导缺口不止一类 → 靶点选择困难 | 丙先出分布再定靶点；多类并存取最高占比做最小扩展，余者入 P10 |
| p5.db 旧批会话缺失 | 开工首日探测；缺失则类型学降级仅 P8 批并声明 |
| 弱模型地板测不出臂间差 | pilot 探带硬性前置，地板即换候选 |
| P6 混淆被误读为 provider 效应 | 指纹表显式标注引导期不可比 |
| ON vs ON-seqgate 配对被隐匿差异污染 | 新分支仅在 env 门控内生效不触碰既有 ON 路径；最终整体审查专查 + F6 插入位置约束 |
| seqgate 与 canonicalCorrect redirect 环（审查 F6） | 插入位置定死在其后同层 + 表内目标断言 |
| key 暴露面扩大（审查 F1/F2） | 接新 provider 前轮换存量 key；模型 ID 白名单校验 |

## 7. 相关文件（预计改动）

- 新增 `experiments/p5/analyze-cross-batch.ts`（+ test，含 DB 回放与健康检查）
- 改 `src/lib/orchestrator/state-machine.ts` 或 `src/lib/services/chat-router.ts`：仅 env 门控序列闸门分支
- 改 `experiments/p5/`：config（envForConfig 第三开关）/run-one（RunEnvSnapshot 三变量）/metrics(optional 字段)/report/GATE 过滤
- 新增 `docs/superpowers/plans/2026-08-24-p9-*.md`、`.superpowers/sdd/2026-08-24-p9-*/progress.md`
- `results/`（report-cross-batch.md、乙批 metrics+report，gitignored）
- 生产行为：默认（env 未设）零改变

---

## 8. 安全审查记录（2026-08-24，双视角并行）

**判定：APPROVE_WITH_MINOR_CHANGES**（无 High/Critical）。安全基本面经代码实证：env 门控先例可靠（严格相等 + finally 恢复）、LLM 提议绕过面被 Object.hasOwn 三处封死、解析链全程 safe-parse、报告不回显 apiKey、方法论/安全边界划分准确。密钥扫描：spec 本体零命中；`experiments/p5/.env.local` 存在明文讯飞 key 但属既定机制（.gitignore `.env*` 覆盖、git 全历史无记录），收尾轮换硬性项已有。

| # | 级别 | 发现 | 落点 |
|----|------|------|------|
| F4 | Medium | 漏加第三开关则 seqgate 臂静默退化为 ON（fail-unsafe）；RunEnvSnapshot 两变量快照残留泄漏风险；开关须严格相等 | §4.2 三条必办 + §5-2 防呆断言 |
| F2 | Low | process-registry.ts:358 默认 shell:true，弱模型 ID 字符串流入 spawn 即注入面 | §4.3 白名单校验 |
| F3 | Low | CLAUDE_CONFIG_DIR 隔离全仓零实现，纯操作纪律 | §4.3 下沉为 harness 断言 |
| F5 | Low | 分析脚本防御性要求（禁 eval/路径消毒/@libsql 只读） | §4.1 约束块 |
| F6 | Low | seqgate 与 canonicalCorrect 的 redirect 环风险 + 表外目标噪声 | §4.2 插入位置条款 |
| F1 | Info | .env.local 明文 key 待轮换；新 provider 接入前先轮换 | §3 弱模型选型前置动作 |
| F7 | Info | reason 子串归类脆 | §4.1-3 结构化信号 |
| F8 | Info | decisionTrace 500 条/session 封顶脚注 | §4.1-2 |

**声明-vs-实现核查**：spec 引用的 9 项代码事实 + 4 项数字聚合 + 1 项生命周期检查共 14 条全部核实属实（其中 P6 双源差异 42vs43、corr 9vs10、ill 1vs0 逐项复现）。生命周期补充：work/ 泄漏实测 398（记载 336 已漂移），teardown 入 §5-5。

**计划化必办最小集**：F4 三条（Medium）＞ F2/F3（随批）＞ F1（时序前置）；F5-F8 作为约束条款写入计划。
