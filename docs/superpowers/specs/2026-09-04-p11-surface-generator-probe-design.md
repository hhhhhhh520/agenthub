# P11 设计：作用面「有界预测」证伪探针（四桶失败地图为主，红/绿裁决为辅）

> 日期：2026-09-04 | **状态：v6（五轮审查并入：+ v5 复核钉死机检(i)防恒真回放）→ 已获批，待 writing-plans**
> 项目：AgentHub A方向（显式状态机） | 上游：P10 全收官 + spec `2026-09-01-p10-...md` §3 + 规划 §9.2 + memory `agenthub-direction_a_state_machine` + 接续 prompt
> 定位：北极星=**追因·拆件+功效**。P11 = **一个纯离线探针**：产出 A（+ C 正对照）的**四桶失败分解地图**（主角交付物），并借此给「作用面论对 A 的有界预测」摆一次**可被打脸的证伪检验**（裁决是地图的副产物）。造第二张网 + 测试批 = 条件触发的后续项目 P11b，不在本 spec 实施。
> **v5 关键修正**（v4 聚焦核查）：①「机检并入②归属」曾击穿四桶穷尽性 → ② 改为**构造性残差桶**（= ¬pass − ⓪ − ① − ③）+ confirm-state 分级（§2.3）；②机检删掉对新模式自相矛盾的「反例在 gate-开副本消失」支；③`TRANSITIONS` 补入内联 + 漂移测试；④正对照钉**强带 C-off** 且签名归因由探针自验（弱带非全①族）；⑤哨兵带宽改精确和；⑥Step0 白名单收窄到快照（禁原地开库）；⑦快照只拷主文件 + 非空 WAL 拒跑。
> **v6（用户复核）**：钉死机检 (i)「派生」定义（转移表可达性判定、**严禁回放本会话观测序列**，防恒真退化）+ §4-1(d) 补**负例/变异 fixture**（先证明机检会红）；补 ①∩③ 交叠 fixture；`==13` 降为 sanity、真正口径约束改 ③≤4+skip/defect 对照。

---

## 词表（本文自足，脱离接续 prompt 可独立读——M5）

| 记号 | 含义 |
|---|---|
| **¬pass** | 「未过」（failureMode ≠ pass，含 `error/stuck/escalate-exhausted/no-pass` 全部非 pass 值）。**`no-pass`（反引号）专指枚举值**（❌5） |
| **格 / 带 / 臂** | 格=(task×band)；带 band=模型能力档（强/弱）；臂=配置（`off+verify`/`on+verify`/`on-seqgate+verify`） |
| **靶 / 面（作用面）** | 靶=可被一条窄网（确定性闸门）罩住的失败模式；作用面=该模式在某格的发生频率。「干预效应 ∝ 作用面」 |
| **①/②/③/⓪** | 四桶。①=seqgate 老靶已罩的失败；**②=构造性残差桶**（¬pass 中非⓪/①/③者，即理论未预见的结构跳步候选池）；③=纯内容/流程不可救；⓪=未推进（排除分母）。优先级 `⓪≻①≻③≻②`，② 为残差 ⇒ **穷尽性由构造保证**（§2.3） |
| **② confirm-state** | 每个 ② 签名的机检结论：`confirmed`（过机检 ∧ 成群≥2）/ `candidate`（机检不过 ∨ 孤例）。**翻绿只认 confirmed ∧ 跨带 presence** |
| **seqgate** | `idlePrematureDoneGate`（谓词 `idle∧done∧taskCount=0`），P9-乙 立、在 C 已证；env 门 `EXPERIMENT_SEQGATE=on` |
| **机检复现** | 一个 ② 签名是否**结构上**成立的两支（§2.3）：(i) 仅由签名三元组 + 内联 `TRANSITIONS` 自动派生的路径，其缺失边集 == 实测缺失边集（证结构性，非模型怪癖/计数噪声）；(ii) 该签名**不满足** seqgate 谓词（证真新模式，非①邻域）。**不再要求「反例在 gate-开副本消失」**——真正的新模式此刻无对应门，该支要么循环要么误杀（v4 核查 A-2） |
| **正对照 / 标定** | 用已知有大靶的格（**强带 C-off**）跑同一分类器，应重捞出已知①族 = 证明尺子没坏。**弱带 C-off 非全①族，不作标定基线**（Refinement 2） |
| **P11b** | 翻绿才立项的后续：造 gate#2 + seqgate-单开对照（Z）+ 测试批功效预算 |
| **presence≠配对** | 仅 2 带，「跨带复现」=不同模型各现一次，非配对显著性（F13，沿 P10 §2.3-④） |

---

## 0. 已定论输入（勿重议）与数据取证（实测坐实，可复算）

**勿重议**：移植=分支3 维持 env 门控（可分析 0，启动条件≥20 且命中≥5）；「干预效应∝作用面」跨两档闭环；主效应 OFF vs ON **跨档第四次 null**；seqgate 在 C 格 0/5→4/5(强)、0/5→5/5(弱，5-0 扫描 `p_exact=0.0625`=n=5 下限)，触发与 pass 同现 100%；**主口径=精确 McNemar，每格 5 对精确 p 下限=0.0625**（先算功效）；装置 v7.2，跨进程信号=文件非 console。

**A 格权威读数（审查员开 metrics 复算，逐格吻合；可提交物仅聚合数）**：

| band（模型） | off+verify | on+verify | on-seqgate+verify | A ¬pass | skip | defect(含 error) |
|---|---|---|---|---|---|---|
| 强（deepseek@xfyun·P9-乙） | 3/5 | 2/5 | 4/5 | **6** | 4 | 2 |
| 弱（glm-flash@Ark·P10） | 2/5 | 2/5 | 4/5 | **7** | 5 | 2 |
| 池 | | | | **13** | **9** | **4** |

**C 格已知靶（标定基线）**：**强带 C-off = 5/5 ¬pass、全 `skipped-spec-edge`**（P9-乙 靶点裁定：为 `idle→done·taskCount=0` 族，后经 seqgate 收到 4/5）。⚠️ **弱带 C-off ≠ 全①族**（实测 4 skipped + 1 defect）→ 不作标定基线。**「强带 5/5 全为 idle-done-0」是签名级归因，探针将在标定步自行从快照重读强带 C-off 的末决策并报告实测复现率**（§2.2-6），不直接采信。

**数据取证（均可 `analyze-a-surface-probe.ts --verify-only` 复算）**：
- **join 主键 = `Session.projectDir` basename**（`mkdtempSync(join(workDir,runId))` `run-one.ts:76`，`runId=${config}-${taskId}-s${seed}-${uuid8}` `run-one.ts:58`）→ `basename.startsWith(metrics.runId)` 实测 30/30 唯一、零 JOIN-FAIL、可分 attempt1/最终批。**title（`run-one.ts:80`，无 uuid）不唯一**（A `LIKE 'p5-%A-s%'` 250 会话/仅 35 不同 title）→ title 仅作简写定位，去重靠 projectDir。
- **trace 无 `taskCount` 字段**（`decision-trace.ts` 六字段确无）→ 决策时刻 taskCount 必查 `Task` 表；`Task.createdAt=…+00:00` vs trace `ts=…Z` 格式分裂，**`Date.parse` 数值比、禁字符串比**。缺它 → ① 抓不住 off/on 臂 idle→done-0 会话 → **假绿灯主通路**（F2）。
- **弱批已冻结（M4）**：源 = `results/metrics.p10-weak-frozen-20260904.bak.jsonl`（**sha256 `af6e590a2878e80585dafd726fc7a857af589c48a4047814ed625f6fed620ba6`**，45 行），探针读此不可变副本。
- **per-run 会话 trace 条目实测 max 8、0 触顶** → 逐趟分桶是精确值（≠跨批聚合下界）。

---

## 1. 认知框架：作用面论的**有界预测**证伪（M1 重定位；预期结局≠白跑）

**为什么不是「探针裁定 A 有无第二靶」**（那是 theater）：作用面论 + seqgate 已罩 idle→done-0 族 ⟹ 对 A 的先验边界预测就是——**A 的 ¬pass ⊆ ③（内容/流程不可救，理论中立）∪ ①（seqgate 已罩），②（理论未预见的第二 gateable 群）稀疏/空**。所以「红」是理论先验定的；把它当探针悬念，正是北极星禁的「买已信结论」。

**改成**：给这条**有界断言**摆一次可被打脸的检验。**主角交付物 = 四桶失败地图**（迄今无人把 A 失败按 taskCount-正确签名精确分四桶 = 真·新信息，无论结果方向都有价值）；裁决只是副产物：
- **②-confirmed 群为空/仅孤例** → 有界预测**证实**：A 无第二 gateable 主导模式，作用面论适用域钉死（预期结局，是成果不是白跑）。
- **② 出 confirmed ∧ 跨带 presence 的群** → 有界预测**证伪**：真发现 → 翻绿 → P11b（且这是唯一让绿有意义的场景）。

**②-空的证据强度来源（B-2 修正：不靠单一正对照，而靠三重担保）**——「②-空才可信」依赖：(a) **C-off 分桶标定**（§2.2-6，校准①识别）＋(b) **§4-2 missingRequired 等价性黄金测试**（校准缺失边集口径）＋(c) **§4-6 TRANSITIONS 漂移测试**（校准机检派生所据转移表）。三者俱过，②-空才是「校准过的尺子量出的 null」（Refinement 2）；任一不过 → 证据强度如实降级标注，不硬吹。

**正对照/标定（Refinement 2，钉强带）**：强带 C-off 是已知①族格（§0），同一分类器应把该族 ① 签名重新捞出——分类器能复现 ground-truth 靶，分桶才可信。**注意正对照校准的是 ①/③ 分桶侧，不直接背书 ② 归属**（② 靠 (b)(c) 两支）。**Step 0 必验前提（R11）**：若强带 C-off 实为大量 ⓪（未推进、appliedEdges=0 被 `⓪≻①` 先吃），标定退化 → 报告如实标「强带 C 未干净复现①族，A-null 证据强度降级」。A 仍主场，C 只作对照，不改 H8 主体。

| # | 假设（有界预测） | 打脸条件 |
|---|------|------|
| **H8** | A ¬pass ⊆ ③ ∪ ①（②-confirmed 群稀疏/空，无跨带成群） | ② 出 confirmed 群 ∧ 跨带 presence → 证伪 → 绿 |
| **H-cal**（标定，非主命题） | 分类器在**强带 C-off** 重捞出 ≥ 阈值 的①族 | 复现率 < 阈值（或 C-off 多⓪）→ 标定降级 → A-null 证据强度打折 |
| H9（属 P11b） | seqgate 单开 ≈ ON+seqgate | 本探针不答，§7 登记 |

---

## 2. 设计（探针：纯离线、只读、零 `src/lib/**` 运行时 import、自带快照副本）

### 2.1 数据源与依赖
- **pass/failureMode/failKind 唯一权威源 = metrics 行**（A 三臂两带 + **强带 C-off** 标定）→ 探针**不调/不复制 `classifyFailKind`/`resolveFailureMode`/`hasRequiredEdges`/`checkConformance`**（pass 侧零 oracle 依赖，F4）。
- **签名数据源 = p5.db 快照**：`Session.decisionTrace`（`decisionPoint / inputState.state / llmProposal.action / corrections[].{from,to} / actualTransition.{action,from,to,applied}`）+ **`Task` 表**（决策时刻 taskCount，参数化 `Date.parse` 比）。
- **② 缺失边集**：`requiredEdges` 数据从 **`experiments/p5/tasks.ts`（非 src/lib）** 直读；`missingRequired(edges,required)` 探针**本地实现**（镜像 `metrics.ts:27`）+ 与 oracle 的**等价性黄金测试**（§4-2）。**禁 import `analyze-cross-batch.ts`**（`:98` 有运行时 `import …/state-machine` → 穿透 `@/lib/db`，破 F3）。
- **常量内联 + 源文本漂移（F3；v5 补 TRANSITIONS）**：探针本地内联 **`TRANSITIONS`（机检派生所据）+ `NON_TRANSITIONING` + seqgate 谓词**，三者各配**源文本漂移测试**（读 `state-machine.ts` 源、断言字面量一致；`type`-only import 因擦除放行）。`TRANSITIONS` 不入内联清单 = 机检无合法取用路径 = F3 冲突（v4 核查 A-3）。
- **批成员表（spec 内嵌，非 dayGroup）**：
  ```
  PROBE_BATCH = {
    arms:['off+verify','on+verify','on-seqgate+verify'],
    strong:{file:'metrics.p9b-strong-20260829.bak.jsonl', cells:{A:15,'C-off':5}},
    weak:  {file:'metrics.p10-weak-frozen-20260904.bak.jsonl', sha256:'af6e590a…620ba6', cells:{A:15}},
    excluded:['…aborted-21…','…p10-matrix-attempt1…','…auto-sentinel-20260902-110740…','…auto-sentinel-20260902-202552…'] }
  ```
  排除项逐一点名；报告回显各文件 sha256+mtime+行数。**标定基线只用强带 C-off（5）**；弱带 C-off 不入标定。
- **DB 打开（recipe=`analyze-port-replay.ts:91-101 prepareSnapshot`，非 `createReadonlyDb`）**：探针**自带快照** `results/snapshot-<probe-ts>/p5.db`——**只拷主文件**，**拷贝前断言「无实验进程 ∨ `p5.db-wal` 为空」，否则拒跑**（照 `prepareSnapshot` 语义，`-wal/-shm` 非空即拒，**不拷** -wal/-shm，避免撕裂快照）。独立 libsql client；`PRAGMA query_only=ON` + **write-self-test**（故意 INSERT 必 throw）；永不发 `journal_mode=`；SQL 全参数化 `client.execute({sql,args})`（禁 `${}`）。`createReadonlyDb`（前缀正则 + `:174` 拼接）**不得当只读保证**。

### 2.2 Step 0：fail-closed 硬闸门（先于任何靶点结论）
1. 快照可开只读 + write-self-test 拦下 + **路径 ends-with == `experiments/p5/results/snapshot-*/p5.db`（v5 收窄：不放行原地 `experiments/p5/p5.db`，与「一律读快照」一致）** + `journal_mode`/`-wal` 回显 + 绝对路径 + sha256/mtime/size（F11）+ **弱批 sha256 == `af6e590a…`**（M4）；
2. `basename↔runId` **双射**、A 每带 **恰=15**、**强带 C-off=5**、无重复 (config,task,seed)、无 `arms` 外 config；
3. `p5-%` 粗筛后解析 `taskId==='A'`/`'C'` **精判格**（LIKE 大小写不敏感 `%A-s%` 不稳健，F10）+ 断言无串档；解析成功率=**实测值写报告**（非声明）；
4. `parseFailed==0` + 每条目必需字段存在性（`decisionPoint ∧ inputState.state∈State ∧ llmProposal.action ∧ actualTransition`），违例 `schemaDegraded` 超 0 即 exit 1（F8）；
5. **⓪ 占比前置**：A 的 `appliedEdges==0` / A ¬pass ≥ 0.3 → 判「样本不足以裁 H8」→ exit 1 落「数据不足」，不进裁决；
6. **标定前置（R11，钉强带）**：探针从快照重读强带 C-off 5 条末决策，报①族复现率；**①复现率 < 4/5 → 报告横幅「尺子未干净校准，A-null 证据降级」**（阈值钉死 4/5，非示例）。

### 2.3 分类器：四桶确定性（**绝不上 LLM-judge**；优先级 `⓪≻①≻③≻②`；②为构造性残差 ⇒ 穷尽）
对每 **¬pass** 会话，按优先级判桶，**② = 兜底残差（非⓪、非①、非③者）**——故 `⓪+①+③+② == ¬pass 总数` 由构造成立（A-1 修）：

| 优先级 | 桶 | 判定签名（字段路径钉死） |
|---|---|---|
| 1 | **⓪ 未推进** | `decisionTrace=='[]'` ∨ `appliedEdges==0`。排除分母（§2.2-5 前置） |
| 2 | **① 老靶（seqgate 已罩）** | (a) 末条目 `inputState.state==='idle' ∧ llmProposal.action==='done' ∧ taskCount@entry.ts===0` **∨** (b) 末条目 `decisionPoint==='handleOrchestratorDecision' ∧ inputState.state==='idle' ∧ ∃c∈corrections(c.from==='done'∧c.to==='align_decompose')`（三合取全写，`metrics.ts:131-137`）。两支均**限末决策**（非本 run 任意处，防 `on-seqgate s3` 末决策 align_arch+execute 被吞，F2-3/⚠️6）。**①按签名判、不按「是否被罩」**——off/on 臂 idle-done-0 会话即有①签名，正是 seqgate 老靶，不算新靶 |
| 3 | **③ 内容/流程不可救** | `failureMode∈{error,stuck,escalate-exhausted}` ∨ `failKind==defect`（**∧ 非⓪**，否则已被⓪吃，M3）；metrics 行直读、DB 不反推（F4） |
| 4 | **② 构造性残差桶** | 其余 ¬pass（即 `failKind==skipped-spec-edge ∨ done-but-conformance` 且非①/⓪/③）——理论未预见的结构跳步候选池 |

**② 的 confirm-state（Refinement 1 修正，翻绿门）**：对每个不同 ② 签名过**机检复现**两支——
- (i) **结构可复现（判定转移表结构性缺口，非本会话序列回放；v6 钉死）**：**派生** = 从 `(末态, 提议)` 出发、仅据内联 `TRANSITIONS` 判断「转移表是否存在能覆盖各缺失必需边的可达续作路径」。判定方向：**若缺失必需边可经 `TRANSITIONS` 从 `(末态,提议)` 的可达续作覆盖**（表本可走通、是模型没走）→ 属单点偶发/模型怪癖，非结构性缺口 → **(i) 失败 → candidate**；**各缺失必需边均不能被任何 `TRANSITIONS` 可达续作覆盖** → (i) 通过（=转移表结构性缺口，新闸门是唯一杠杆）。**硬约束：派生只依赖 `(末态,提议)` + 内联 `TRANSITIONS`，严禁回放本会话已观测的 applied 序列**——否则 `missingRequired(派生) ≡ missingRequired(观测)` 恒真，机检塌缩成「同签名≥2」计数，假绿通道复活（v5 复核 🔴）；
- (ii) **非①邻域**：该签名**不满足** seqgate 谓词（证真新模式）。
过 (i)+(ii) ∧ 同签名 ≥2 → `confirmed`；机检不过 ∨ 孤例(<2) → `candidate`（呈于地图，**不翻绿**）。**绿只认 confirmed ∧ 跨带 presence（§2.4）**。
> 注：机检**不再含「反例在 gate-开副本消失」**——真正的新②此刻无对应门，该支要么循环（引用尚不存在的门）要么必误杀（新签名不受 seqgate 影响→永不消失→②恒空→证伪名存实亡）（v4 核查 A-2）。

穷尽断言（构造式）：**每 ¬pass 恰落一桶 ∧ ② := ¬pass − ⓪ − ① − ③ ⇒ 四桶和恒等于 ¬pass 总数**。

**worked example（M5，端到端；脱敏示意非真实 sessionId）**：
- **A-off 会话**：`idle →(delegate 旁路)→ idle 提议 done, tc=0 →(off 无 gate，TRANSITIONS[idle].done=done)→ phase=done`，appliedEdges={done:idle→done}，缺边含 `align_decompose→align_arch`、`execute→exec`、`exec→done` → failKind=skipped-spec-edge、¬pass。归桶：appliedEdges>0 非⓪ → 末决策 `idle∧done∧tc0` → **①(a)** ⇒ 桶①（老靶，非第二门）。
- **强带 C-off 会话（标定）**：同类末决策 `idle∧done∧tc0` → **①** ⇒ 复现 P9-乙 已知 C 族 ⇒ 尺子校准。
- **②-候选长什么样（反例说明②之稀有）**：末决策 `align_arch 提议 done`（缺 decompose 边、非 idle-done-0）、非⓪/①/③ → **②**；再过机检：该缺失边**不可经 `TRANSITIONS` 从 `(align_arch,done)` 的可达续作覆盖**（结构性缺口，(i) 过）∧ 非 seqgate 谓词（(ii) 过）⇒ 若跨带同签名 ≥2 → `confirmed` → 翻绿。否则（缺失边可被转移表续作覆盖=模型怪癖→(i) 败，或孤例<2）→ `candidate`，仅呈地图。

### 2.4 裁决（最小升级规则；砍阈值机——M2）
分母 = (task,band) 合并三臂、排除⓪的 ①+②+③。**探针只判「有没有理论未预见的 confirmed 群」**；「能否验出」全交 P11b 功效预算：
- **绿（唯一升级出口）**：∃ 一个 **confirm-state=confirmed** 的 ② 签名，**两 band 各≥1 presence**（presence≠配对，F13）→ 有界预测被证伪 → 立项 P11b。
- **红（默认/预期）**：无任一 confirmed ② 签名跨带 presence → 有界预测证实 → 交付=地图。
- **图例注（替代旧不可达自查❌3）**：单带 presence、亚阈值、或仅 candidate 的签名 → 地图图例标「不足以翻色，仅呈分布」，**不立独立裁决分支**；**若某 confirmed 签名仅单带出现（理论未预见的单带新模式）**，亦仅呈图例、不翻绿（跨带 presence 是绿的硬条件）——**「跨带复现但 <绿门 → 构造变体格再验」这条亚阈值出口，按 M2 已有意并入 P11b 功效职责（§7-2），探针不再为它立分支**。

### 2.5 地图输出规范（M2 投资重心；决定「第三方可复读」）
1. **签名表示法**：`<末态>/<提议>/<缺失必需边集(排序)>` 三段确定串 + `confirm-state`（confirmed/candidate）。
2. **最小成群规模**：同签名 ≥2 才算「群」；单例入「孤例表」（仍落②桶，但不成群）。
3. **众数并列 tie-break**：按绝对数降序 → 同数按签名串字典序（确定可复算）。
4. **跨 band 合并计**：地图同签名两 band 合并总数呈分布；**翻绿用各 band presence（≥1/带），非合并数**。
5. **表列与序**：`band | arm | task | bucket | signature | confirm-state | n | %(÷非⓪分母)`，按 band→arm→bucket→n 排序；行末对账 **⓪+①+②+③ == ¬pass 总数**（构造恒等，A-1 修后必平）+ §0 权威三列对照。

---

## 3. 不做（P11b 候选）
造 gate#2｜任何真跑测试批｜Z：seqgate 单开臂｜seqgate 转正（等启动条件）｜ISSUE-021 修复（动 src/lib 破零改动红线）｜任务族重构（P11b 内构造变体格时引用）｜posture｜余类缺边闸门。

---

## 4. 验证（每改必新增针对性测试；红绿验证）
1. **classifier TDD**：fixture 钉四桶 + 边界——(a) ① (a)/(b) 各命中 + 「本 run 任意处 fired 不入①」（`on-seqgate s3` 反例）；(b) 无 Task-table taskCount → **拒绝裁决**（非默认入②，F2 假绿回归守卫）；(c) `⓪≻①≻③` 交叠（error ∧ appliedEdges=0 → ⓪；error ∧ appliedEdges>0 → ③，M3）+ **①∩③ 交叠**（末条目干净 `handleOrchestratorDecision` + fired correction ∧ `failureMode=error` → 按优先级 `①≻③` 落①，钉死优先级方向）；(d) **② 机检复现双向 + 变异检验（先证明会红）**：**正例**——结构性缺口签名（缺失边不可经 TRANSITIONS 续作覆盖 ∧ 非 seqgate ∧ 同签名≥2）→ (i)(ii) 过 → confirmed；**负例/变异**——造一会话其缺失必需边**确可经 `TRANSITIONS` 从 `(末态,提议)` 覆盖**（模型怪癖/单点偶发）→ 机检 (i) **必须失败** → candidate 不翻绿（此条专防「派生=回放观测序列」的恒真退化实现，v6）；孤例(<2) → candidate；(e) fired 支三合取缺一不误判；(f) **穷尽构造**：任给 ¬pass 集合，四桶和 == 总数（构造式断言，A-1 回归守卫）。
2. **missingRequired 等价性黄金测试**：探针本地版 vs `metrics.ts` oracle 缺失边集全等（防口径分家=新假绿通道）。
3. **正对照测试（Refinement 2，钉强带）**：强带 C-off fixture → 分类器①复现率 ≥4/5；另造「强带 C-off 多为⓪」fixture → §2.2-6 降级横幅触发；守卫断言**弱带 C-off 不入样本、不计入标定基线**（§2.1 弱带 cells 仅 A:15，非全①族的弱带 4 skipped+1 defect 不参与标定）。
4. **join 测试**：同 title 多 run 靠 projectDir runId 前缀分 attempt1/最终批；双射 + 计数（A=15/带、强带 C-off=5）；参数化 + 断言探针 SQL 无 `${}`（F12）；弱批 sha256 != `af6e590a…` → exit 1（M4）；**原地开库（非快照路径）→ exit 1**（§2.2-1 白名单收窄）。
5. **口径锚点哨兵（F6/❌1→§4-5，v6 修正）**：**真正咬人的口径约束** = `③ ≤ 4`（③⊆defect/error 行）∧ 池 `skip==9 / defect==4` ∧ metrics 三列对照（§0 权威）；**`⓪+①+②+③ == 13` 是构造恒等、恒真，仅作实现 bug 的 sanity，不得当口径正确性判据**（v5 复核 🟡）。**近似带宽（防误报）**：③∈[2,4]、①+②∈[9,11]。显著偏离硬约束 → 顶部横幅「先自查口径（选样/taskCount/join）」。
6. **零生产 import 测试**：模块图**无任何指向 `src/lib/**` 运行时边**（`@/lib/db` 具名子断言；type-only 按擦除识别、正则扫非 `import type` 的 `from '@/lib`）+ **`TRANSITIONS`/`NON_TRANSITIONING`/谓词 内联副本源文本漂移测试**（v5 补 TRANSITIONS）。
7. 新测试文件进 `vitest.config.ts` include；收尾 pre-commit 三视角 + 全 diff 密钥扫描。

---

## 5. 风险
| # | 风险 | 缓解 |
|---|------|------|
| R1 | projectDir 后缀碰撞 | uuid8 + 双射 + 计数断言 |
| R2 | metrics 权威 pass 与 DB 分桶漂移 | pass 只取 metrics；§4-2/§4-5 兜底 |
| R3 | ①/② 邻域糊把老靶当新靶（F2 假绿主通路） | taskCount 强制 + ①优先 + 机检支 (ii)非 seqgate + 无 taskCount 拒裁 |
| R4 | 红被误读「状态机无用」 | §7 措辞钉「A 有界预测证实=作用面边界，非否定 seqgate/C」 |
| R5 | 原地读非空 wal 击穿/句柄 | **一律读快照**（§2.2-1 白名单仅快照路径）+ 快照只拷主文件、非空 WAL 拒 |
| R6 | 运行时 import src/lib 切 WAL 毁下批 migrate | 零运行时边 + 禁 import analyze-cross-batch + §4-6（含 TRANSITIONS 漂移） |
| R7 | 哨兵/中止批污染 | 批成员表 + 排除点名 + projectDir 去重 |
| R8 | （旧自查基准错致恒不触发） | 已随 M2 降为 §2.4 图例注，非判据 |
| R9 | **② 机检误杀真发现 / 噪声翻绿** | 机检两支（派生==实测 ∧ 非 seqgate）并入②确认判据；不过 → candidate 不翻绿；删掉循环的「反例消失」支（A-2）；§4-1d |
| R10 | arms 外 config / §0 不可第三方复算 | §2.1 arms + §2.2-2 + §0 全名全三列 |
| R11 | 强带 C-off 实为大量⓪ → 正对照退软证据 | §2.2-6 标定前置（钉强带、阈值4/5）+ 报告如实降级 |
| R12 | ② 残差桶吞掉本应单列的缺陷 | ② 为构造性兜底、每签名带 confirm-state；孤例单列于孤例表不入群 |

---

## 6. 相关文件
- **新增**：`experiments/p5/analyze-a-surface-probe.ts` + `.test.ts`（+ vitest.config include 行）
- **只读数据源（快照）**：`p5.db` 快照（575 会话含 decisionTrace + Task 表）、`metrics.p9b-strong-20260829.bak.jsonl`、`metrics.p10-weak-frozen-20260904.bak.jsonl`
- **只 import 非-src/lib**：`tasks.ts`（requiredEdges）；`TRANSITIONS`/`NON_TRANSITIONING`/seqgate 谓词 = 探针内联副本 + 源文本漂移测试
- **明确禁 import**：`src/lib/**`（运行时）、`analyze-cross-batch.ts`（:98 src/lib 边）、`@/lib/db`
- **不改**：`src/lib/**`、launcher、run-one/setup/config、metrics.ts、analyze-cross-batch.ts、analyze-port-replay.ts
- **产物**：`experiments/p5/results/report-a-surface-probe.md`（**gitignored**；可提交物只准聚合数 + 裁决号，F8；模型/供应商名公开版弱化为「强批/弱批模型」）

---

## 7. 产出与后继
1. **主角=四桶失败地图**（§2.5 规范；A 各格 ⓪/①/②/③ + ② 签名/confirm-state 分布 + 强带 C-off 标定行），**副产物=红/绿裁决**（先数后判）。
2. **绿（真发现/证伪）** → **P11b 立项建议**（gate#2 照 `idlePrematureDoneGate` 模子 + env 门控 + Z：seqgate 单开臂 + 测试批功效自持〔够大 n，**必要时构造变体格以把候选②做成可测浓度**——原「黄灯」职责〕+ ISSUE-021 前置）；下轮单独 spec→安全审查→plan→SDD。
3. **红（预期/证实有界预测）** → 作用面论 A 域边界落档（规划 §9.2 + memory：「A 的失败 ⊆ 内容/流程不可救 ∪ seqgate 已罩，无第二 gateable 主导群；此结论由强带 C-off 标定的分类器 + missingRequired 黄金测试 + TRANSITIONS 漂移测试三重担保给出」）+ 地图作描述性交付。
4. 同步 memory/PROGRESS/规划 §9.2；负结果不夸大（R4）。
5. 若红且仍要正向 → 唯一不违北极星的是 seqgate 转正（议题④，等启动条件），非再造第二门。

## 8. 审查并入映射
**Security Eng F1–F14**：F1→§0/§2.1 projectDir 键+批成员表+双射；F2→§2.1 Task taskCount+①限末决策；F3→§2.1 零运行时 import+内联副本(含 TRANSITIONS)+副本读+§4-6；F4→§2.1 pass 唯一源=metrics；F5→§2.4 探针/P11b 解耦；F6→§4-5 锚点；F7→§2.3 ⓪+穷尽；F8→§2.2-4；F9→§2.1 文件表；F10→§2.2-3 精判格；F11→§2.2-1；F12→§4-4；F13→§2.4/词表；F14→§0。
**pre-commit ❌1–5**：❌1→§4-5 锚点 ①+②≈9/③≤4+带宽；❌2→§2.1 requiredEdges+本地 missingRequired+等价测试+禁 analyze-cross-batch；❌3→§2.4 自查降为图例；❌4→§2.1 自带快照+§2.2-1 白名单+R5 副本优先；❌5→词表+全文 ¬pass/`no-pass` 分离。
**方法评审 M1–M5（重定位）**：M1→§1 有界预测证伪框架 + 地图为主/裁决为辅；M2→§2.4 最小升级规则 + §2.5 地图输出规范；M3→§2.3 ③∧非⓪ + §4-5 ③≤4；M4→§0/§2.2-1/§2.1 冻结副本 + sha256；M5→词表 + worked example。**Refinement 1**（机检并入②，修穷尽）→§2.3 ②构造性残差桶+confirm-state+机检两支（删反例消失支）+ R9；**Refinement 2**（C=正对照/标定非猎场，钉强带）→§1 三重担保 + §2.2-6 + §4-3 + R11。
**v4 聚焦核查**：A-1→§2.3 ②构造性残差+§2.5-5/§4-1f 穷尽构造；A-2→词表/§2.3 机检删「反例在 gate-开副本消失」；A-3→§2.1/§6/§4-6 TRANSITIONS 入内联+漂移；B-1/4→§0 弱带非全①族+标定钉强带+探针自验签名；B-2→§1 三重担保；B-3→§2.2-6 阈值4/5 钉死；C-2→§2.4 亚阈值出口并入 P11b 明说；C-4→§4-5 带宽放宽为精确和+③≤4+[2,4]近似；附加→§2.2-1 白名单收窄快照、§2.1 快照只拷主文件+非空 WAL 拒、§8 锚点引用改 §4-5、worked example 缺边表述收紧。
