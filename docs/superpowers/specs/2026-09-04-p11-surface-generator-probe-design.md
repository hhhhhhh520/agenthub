# P11 设计：作用面生成器探针（A 方向「第二闸门」靶点裁定）

> 日期：2026-09-04 | **状态：v3（两轮独立审查并入：Security Engineer APPROVE_WITH_CHANGES F1–F14 + pre-commit-audit 独立审查 5❌/多⚠️）→ 待用户审阅**
> 项目：AgentHub A方向（显式状态机） | 上游：P10 全收官（`report-p10-weak.md`、`report-p10-port-decision.md`、spec `2026-09-01-p10-port-decision-weak-band-design.md` §3、规划 §9.2、memory `agenthub-direction-a-state-machine`、接续 prompt）
> 定位：北极星=**追因·拆件+功效**（功效是前置）。本轮交付 = **纯离线探针 + 红黄绿裁决 + 四桶失败地图**；造第二张网与测试批 = 条件触发的后续独立项目（暂名 P11b），不在本 spec 实施。
> **两轮审查核心教训（v1/v2 各自的假绿灯通道，均已堵）**：① join 键 + 桶① taskCount（Security Eng F1/F2）；② 锚点算术/分母单位/依赖清单/路径白名单/no-pass 歧义（pre-commit 5❌）。**探针存在的全部意义 = 只有 join 对、taskCount 接上、分母单位钉死，红才是可辩护的红；否则给假绿——正违反北极星「不买已信结论」。**

---

## 0. 已定论输入（勿重议）与数据取证（实测坐实，可复算）

**勿重议**：移植=分支3 维持 env 门控（可分析 0，启动条件≥20 且命中≥5）；「干预效应∝作用面」跨两档闭环；主效应 OFF vs ON **跨档第四次 null**；seqgate 在 C 格 0/5→4/5(强)、0/5→5/5(弱，5-0 扫描 `p_exact=0.0625`=n=5 下限)，触发与 pass 同现 100%；**主口径=精确 McNemar，每格 5 对精确 p 下限=0.0625**（n=5 达不成「p<0.05」，先算功效）；装置 v7.2，跨进程信号=文件非 console。

**A 格权威读数（审查员开 metrics 文件复算，非自述；可提交物仅聚合数）**：

| band（模型） | off+verify | on+verify | on-seqgate+verify | A ¬pass 合计 | skip | defect(含 error) |
|---|---|---|---|---|---|---|
| 强（P9-乙·deepseek@xfyun） | 3/5 | 2/5 | 4/5 | **6** | 4 | 2 |
| 弱（P10·glm-flash@Ark plan） | 2/5 | 2/5 | 4/5 | **7** | 5 | 2 |
| 池 | | | | **13** | **9** | **4** |

> 全臂名钉死于 §2.1 `arms`；§4-5 交叉核对用此表全三列。

**数据取证**：
- **join 主键 = `Session.projectDir` basename**：`mkdtempSync(join(workDir, runId))`（`run-one.ts:76`）→ basename = `runId + mkdtemp 后缀`，`runId=${config}-${taskId}-s${seed}-${uuid8}`（`run-one.ts:58`，含 `+` 无需切分、uuid8 天然去重、可分 attempt1/最终批）。`basename.startsWith(metrics.runId)` 实测 30/30 唯一命中、零 JOIN-FAIL。
- **title（`run-one.ts:80`，无 uuid）不唯一**：A 格 `LIKE 'p5-%A-s%'` 命中 250 会话/仅 35 个不同 title。**title 仅用于 `(config,task,seed)` 简写定位，run 去重必须靠 projectDir 键。**
- **dayGroup band 选样被实证 3× 污染**：仅日期窗选出 89 A 会话 vs 权威 30（多 `p9b-aborted-21`、`p10-matrix-attempt1` seqgate 5/5≠最终、`auto-sentinel-*` 控制组落弱窗且模型是 deepseek）。**→ 批成员由 §2.1 文件表定，dayGroup 降为交叉校验列。**
- **trace 无 `taskCount` 字段**（`decision-trace.ts:33-45` 实无此列）→ 决策时刻 taskCount 必查 `Task` 表：`Task.createdAt=…+00:00` vs trace `ts=…Z` 格式分裂，**`Date.parse` 数值比、禁字符串比**。缺它 → 桶① 抓不住 off/on 臂 idle→done-0任务会话（无 correction 记录），实测 33 条 `(idle,done,缺三边)` 跨两 band 成群整块漏进桶② → **假绿灯**。
- **per-run 会话 trace 条目实测 max 8、0 触顶 0 解析失败** → 逐趟分桶是精确值（≠跨批聚合的下界）。`trace-<runId>.json` 单文件确不在盘（`metrics.ts:141` 仍写该路径字段，探针不依赖）。
- 以上实测数（除 §1 锚点外）均可由 `analyze-a-surface-probe.ts --verify-only` 复算（§4）。

---

## 1. 北极星与命题（可证伪；三态皆一等交付物；预期主结局=红）

**北极星**：追因，明确拒绝「花几十次测试买已信结论」。故 P11 **不拆旧捆绑**（其成分已被 P9-丙 分解 + 作用面论解释：ON 成分作用在罕见/不命中的失败模式），而是把作用面论从「解释器」用成「生成器」——检验能否指出第二个「一逮一大片」的靶。

| # | 假设 | 推翻/落点 |
|---|------|------|
| **H8（靶点存在性）** | A（及未推进会话）失败里，存在**统一、窄网可罩、跨 band 复现、结构可机检复现**的新签名（桶②） | 无任一签名成群/复现 → **红灯**：A 无第二 gateable 主导致模式，作用面论边界落档 |
| H9（seqgate 独立成立，**属 P11b 不属本探针**） | seqgate 单开 ≈ ON+seqgate | 需真跑对照臂，本探针不答，§7 登记 |

**预演锚点（非交付物、仅作 §4-4 sanity；口径=§0 表）**：池 A ¬pass=13 = **defect/error≈4（→桶③）+ skipped-spec-edge≈9（→桶①/② 之分，取决于 taskCount）**。informal 读（未走正式分类器、未查 Task 表）示：那 ~9 条 skipped 里绝大多数是 seqgate 老靶（桶①），残差 ~3 互异孤例、无跨 band 复现 → **倾向红**。**注意：桶①+②≈9 而非 13（4 条 defect 必落③）**——正式探针哨兵以「③≈4、①+②≈9」为基线（§4-4 容差带），非「①+②=13」。

---

## 2. 设计（探针：纯离线、只读、零 `src/lib/**` 运行时 import、自带快照副本）

### 2.1 数据源与依赖（pre-commit ❌2/❌4 修正）
- **pass/failureMode/failKind 唯一权威源 = `metrics.jsonl` 行**（run 时同套 oracle 产出）→ **探针不调 `classifyFailKind`/`resolveFailureMode`/`hasRequiredEdges`/`checkConformance` 任何函数、不复制其逻辑**（pass 侧零 oracle 依赖，F4）。
- **签名数据源 = p5.db**：`Session.decisionTrace`（`decisionPoint / inputState.state / llmProposal.action / corrections[].{from,to} / actualTransition.{action,from,to,applied}`）+ **`Task` 表**（决策时刻 taskCount，参数化 `Date.parse` 比）。
- **桶②/③ 必需边差集**：`requiredEdges` 数据从 **`experiments/p5/tasks.ts`（非 src/lib，安全）** 直读；`missingRequired(edges, required)` 在探针**本地实现**（镜像 `metrics.ts:27` 语义）+ 一条与 `metrics.ts` oracle 的**等价性黄金测试**（防口径分家）。**禁 import `analyze-cross-batch.ts`**（其 `:98` 有运行时 `import .../state-machine` → 穿透 `@/lib/db`，破 F3）。
- **`arms` + 批成员表（spec 内嵌常量，非 dayGroup）**：
  ```
  PROBE_BATCH_FILES = {
    arms: ['off+verify','on+verify','on-seqgate+verify'],
    strong: { file:'metrics.p9b-strong-20260829.bak.jsonl', expectA:15 },
    weak:   { file:'metrics.jsonl', expectA:15, note:'当前 45 行=P10 weak 最终批；由 §2.2 sha256 冻结身份；若已被 launcher 归档为 metrics.p10-*.bak 则改指该 bak，绝不用无锚当日 metrics' },
    excluded: ['metrics.p9b-aborted-21.bak.jsonl','metrics.p10-matrix-attempt1-37rows.bak.jsonl','metrics.auto-sentinel-20260902-110740.jsonl','metrics.auto-sentinel-20260902-202552.jsonl'] }
  ```
  排除项逐一点名；报告回显各文件 sha256+mtime+行数。
- **常量内联避 F3**：`NON_TRANSITIONING` 集合与 seqgate 谓词以**探针本地副本**内联 + **源文本漂移测试**（读 `state-machine.ts` 源断言字面量一致；`type`-only import 因擦除放行）。
- **DB 打开方式（recipe 源=`analyze-port-replay.ts:103-109 openGuardedReadonly`，非 `createReadonlyDb`）**：探针**自带 `copyFile` 建本次专用快照** `results/snapshot-<probe-ts>/p5.db(+ -wal/-shm)`（照 `analyze-port-replay.ts:155`），**一律读副本**（原地仅在副本失败且已确认无实验进程时降级并回显）；独立 libsql client；连上首句 `PRAGMA query_only=ON` + **write-self-test**（故意 INSERT 必 throw）；永不发 `journal_mode=`；SQL 全参数化 `client.execute({sql,args})`。**`createReadonlyDb`（前缀正则 + :174 拼接）不得复用为只读保证。**

### 2.2 Step 0：fail-closed 硬闸门（先于任何靶点结论）
1. 副本可开只读 + write-self-test 拦下 + 路径 ends-with ∈ {`experiments/p5/p5.db`, `experiments/p5/results/snapshot-*/p5.db`}（❌4 白名单）+ `journal_mode`/`-wal` 状态回显 + 绝对路径 + sha256/mtime/size 记录（F11）；
2. `basename↔runId` **双射**、每 band A 会话数 **恰 = `expectA`(15)**、无重复 `(config,task,seed)`、**无 `arms` 外表内 config**（如遗留 `'on'/'off'`、`*+no-verify` 属他批不入选）；
3. `p5-%` 粗筛后**解析 `taskId==='A'` 精判格**（LIKE 大小写不敏感、`%A-s%` 不稳健，F10）+ 断言无 B/C 混入；解析成功率=**实测值写进报告**（非声明）；
4. `parseFailed==0`（不设自由阈值，F8）+ 每条目**必需字段存在性**（`decisionPoint ∧ inputState.state∈State ∧ llmProposal.action ∧ actualTransition`），违例记 `schemaDegraded` 超 0 即 exit 1；
5. **⓪ 占比前置**：若 `appliedEdges==0` 会话 / A ¬pass ≥ 0.3 → 判「样本含大量未推进、数据不足以裁 H8」→ exit 1 落「数据不足」，**不进裁决**（⓪ 不作红/绿桶）。

### 2.3 分类器：四桶确定性（**绝不上 LLM-as-judge**；优先级 `⓪≻①≻②≻③` 显式声明）
对每个 **A ∧ ¬pass**（¬pass=failureMode≠pass，含 `error`/`stuck`/`escalate-exhausted`/`no-pass` 全部非 pass 值——**本 spec 统一用「¬pass」指「未过」，`no-pass` 反引号仅指枚举值**，❌5），取**末致命决策**归一桶（⓪ 先吃，防 appliedEdges=0 会话挤进①缩分母，⚠️9）：

| 桶 | 判定签名（字段路径钉死） |
|---|---|
| **⓪ 未推进** | `decisionTrace=='[]'` ∨ `appliedEdges==0`。**排除分母**，§2.2-5 已前置 |
| **① 老靶（seqgate 已覆盖）** | (a) 末条目 `inputState.state==='idle' ∧ llmProposal.action==='done' ∧ taskCount@entry.ts===0`（谓词支）**∨** (b) 末条目 `decisionPoint==='handleOrchestratorDecision' ∧ inputState.state==='idle' ∧ ∃c∈corrections(c.from==='done' ∧ c.to==='align_decompose')`（fired 支，**三合取全写**，`metrics.ts:131-136`）。两支均**限末决策**（非本 run 任意处，防 `on-seqgate s3` 末决策 align_arch+execute 被吞，⚠️6/F2-3） |
| **② 新、窄网可罩的跳步骤** | 严格非①；`(末态 state, 提议 action, 缺失必需边集)` 三元签名成群；缺失边集由 §2.1 `missingRequired` 算 |
| **③ 纯内容 defect** | 非①②；`failureMode ∈ {error,stuck,escalate-exhausted}` ∨ `failKind==defect`（metrics 行直读，DB 不反推，F4） |

穷尽断言：**每 ¬pass 会话恰落一桶 ∧ ⓪+①+②+③ == A ¬pass 总数 ∧ 分母 = ①+②+③（排除⓪）**。核心输出：**每 (task,band) 跨臂、桶② 各签名的众数占比与绝对数**（+ 四桶分布供失败地图）。

### 2.4 红黄绿裁决（单位/分母/众数/基准四重钉死，❌3/❌5）
分母 = **(task,band) 合并三臂、排除⓪的 ①+②+③ ¬pass 数**（强=6、弱=7）。探针门槛**只判「有没有主导新靶」**，「能否验出」交 P11b 功效预算（v1 把两者混塞致「≥4/5 该格」在 arm×band 单位算术不可达）。

- **绿灯（解锁 P11b）**：∃ 单一桶② 签名 **两 band 各 ≥2 且合计 ≥5**（合计/池分母 13 ≈ ≥38%，去 v1 恒真合取，⚠️8）**且** 结构可机检复现（下）。P11b 自持功效（够大 n/变体格使完美门清 n=5 下限）。
  - **结构可机检复现（⚠️10 补可证伪）**：签名三元组 + `TRANSITIONS` **自动派生** fixture 输入（禁手填路径）；通过式 = `missingRequired(派生序列) == 实测缺失边集`；**并要求反例 fixture**：同签名在「gate 打开」的转移表副本上必须消失。三条不全 → 不计结构支（堵「事后叙事换皮」）。
- **黄灯（P11b 但强制构造变体题，议题②作工具）**：单一签名跨 ≥2 band 复现但 < 绿门（含「各 ≥1 但 <2」）→ 现有 A 格浓度/n 不足，改「造把该签名做成绝对主导的 C 变体格」再测。
- **红灯（预期主结局）**：无任一签名跨 band 复现（大头落 ③ 或 ② 全孤例）。**措辞模板**：「A 不存在第二个可被窄网罩住的主导致失败模式」=作用面论边界，**非**否定 seqgate/C 战果（R4）。
- **不可达自查（❌3 改基准）**：**逐 band** 查「该 band 桶② 绝对数 ≥2？」——任一 band 桶② 子池 <2 → 报告点名「M 超桶②样本，非红灯结论」并输出真实四桶分布，**不静默判红**。（比的是桶②子池，不是总失败数。）
- **跨 band 声明（F13）**：仅 2 band，「跨 ≥2 band 复现」= 不同模型各现，**presence 非配对**；沿 P10 §2.3-④ 不做合并显著性声明，失败地图表头 + §7 均标注。

---

## 3. 不做（P11b 候选，防探针膨胀）
造 gate#2｜任何真跑测试批｜Z：seqgate 单开臂｜seqgate 转正（等启动条件）｜**ISSUE-021 幽灵修复（动 src/lib 破零改动红线，另议）**｜任务族重构（仅黄灯作 P11b 内工具引用）｜posture｜余类缺边闸门。

---

## 4. 验证（每改必新增针对性测试；红绿验证）
1. **classifier TDD**：fixture 钉四桶 + 边界——(a) 桶① (a)/(b) 两支各命中 + 「本 run 任意处 fired 不得入①」（`on-seqgate s3` 反例）；(b) **无 Task-table taskCount → 拒绝裁决**（非默认入②，防 F2 假绿回归）；(c) `⓪∩①`（`appliedEdges==0 ∧ 有 done→align_decompose correction`）按 `⓪≻①` 归⓪；(d) ②③ 切分；(e) fired 支**三合取**全非二缺一不误判。
2. **missingRequired 等价性黄金测试**：探针本地版 vs `metrics.ts` oracle 在同一 fixture 上缺失边集全等（防口径分家 = 新假绿通道）。
3. **join 测试**：同 title 多 run 靠 projectDir runId 前缀正确区分 attempt1/最终批；双射 + 计数=15 断言；参数化查询 + 断言探针 SQL 无 `${}` 插值（F12）。
4. **口径锚点哨兵（F6/❌1）**：探针输出四桶与 §0/§1 基线对账——**③∈[3,5]、①+②∈[7,11]、池 skip/defect == §0 表（9/4）**；显著偏离 → 报告顶部横幅「先自查口径（选样/taskCount/join）」再谈结论。**不硬写「①=10」这种与③冲突的单值。**
5. **聚合数交叉核对**：探针重算 A 各格 `pass/skip/defect` == §0 表全三列 + report-p10-weak/p9b-strong（差异点名，R2）。
6. **零生产 import 测试**：断言探针模块图**无任何指向 `src/lib/**` 的运行时边**（`@/lib/db` 为具名子断言；type-only 边按「会被擦除」识别、正则扫 `from '@/lib` 且非 `import type`）+ 内联副本源文本漂移测试。
7. 新测试文件进 `vitest.config.ts` include；收尾 pre-commit 三视角 + 全 diff 密钥扫描。

---

## 5. 风险
| # | 风险 | 缓解 |
|---|------|------|
| R1 | projectDir basename 后缀理论碰撞 | uuid8 + 双射 + 计数==15，碰撞 exit 1 |
| R2 | metrics 权威 pass 与 DB 分桶口径漂移 | pass 只取 metrics；§4-2/§4-5 双兜底 |
| R3 | ①/② 邻域糊把老靶当新靶（F2 假绿主通路） | taskCount 强制 + ①优先 + 无 taskCount 拒裁 + §4-1a 反例 |
| R4 | 红/黄被误读「状态机无用」 | §7-3 措辞模板钉死，非否定 seqgate/C |
| R5 | 原地读非空 wal 击穿生产 / 句柄不释放 | **§2.1 一律读自带副本**（副本优先，单一说法）+ §2.2-1 白名单+回显 |
| R6 | 运行时 import src/lib → 切 WAL 毁下批 migrate（F3） | 零运行时边 + 禁 import analyze-cross-batch + §4-6 模块图测试 |
| R7 | 哨兵/中止批并入污染 | 批成员表 + 排除点名 + projectDir 键去重 |
| R8 | 不可达自查比错量恒不触发（❌3） | §2.4 自查基准=逐 band 桶②子池 |
| R9 | 结构支事后叙事换皮 | §2.4 三条硬判据（自动派生+等式通过式+反例 fixture） |
| R10 | `arms` 外 config 混入 / §0 不可第三方复算 | §2.1 `arms` 白名单 + §2.2-2 + §0 表全名+全三列 |

---

## 6. 相关文件
- **新增**：`experiments/p5/analyze-a-surface-probe.ts` + `.test.ts`（+ vitest.config include 行）
- **只读数据源（副本优先）**：`p5.db`（575 会话含 decisionTrace + Task 表）、`metrics.p9b-strong-20260829.bak.jsonl`、P10 weak 最终批 metrics（当前 `metrics.jsonl`，sha256 冻结）
- **只 import 非-src/lib 数据**：`tasks.ts`（requiredEdges 数据）；`NON_TRANSITIONING`/seqgate 谓词 = 本地副本 + 漂移测试
- **明确禁止 import**：`src/lib/**`（运行时）、`analyze-cross-batch.ts`（:98 有 src/lib 运行时边）、`@/lib/db`（WAL 穿透）
- **不改**：`src/lib/**` 全体、launcher、run-one/setup/config、metrics.ts、analyze-cross-batch.ts、analyze-port-replay.ts
- **产物**：`experiments/p5/results/report-a-surface-probe.md`（**gitignored**；可提交物只准聚合数 + 红黄绿裁决号，F8——模型/供应商名亦按 F8 严格读法在公开版弱化为「强批模型/弱批模型」，内部版可留）

---

## 7. 产出与后继
1. **四桶失败地图**（A 各格 ⓪/①/②/③ 分解 + 桶② 签名众数，含「A 剩余失败全孤例」类正面陈述）+ **红/黄/绿裁决**（先数后判）。
2. **绿/黄** → **P11b 立项建议骨架**（gate#2 照 `idlePrematureDoneGate` 模子 + env 门控 + Z：seqgate 单开臂 + 测试批**功效预算自持**〔绿=够大 n；黄=构造变体格〕+ ISSUE-021 前置）；P11b 下轮单独 spec→安全审查→plan→SDD。
3. **红（预期主结局）** → A 方向因果链收官（规划 §9.2 + memory：「作用面论边界=**A 不存在第二个可被窄网罩住的主导致失败模式**」），决策权交回变现/收尾。
4. 同步 memory/PROGRESS/规划 §9.2，负结果不夸大（降级的是显著性标签非方向证据本身）。
5. 若 H8 推翻（红）且仍要正向 → 唯一不违北极星的是 seqgate 转正（议题④，等启动条件），非再造第二门。

## 8. 审查并入映射
**Security Engineer（F1–F14）**：F1→§0/§2.1 projectDir runId 键 + 批成员表 + §2.2-2 双射/计数；F2→§2.1 Task 表 taskCount(Date.parse) + §2.3 ①两支限末决策；F3→§2.1 零 src/lib 运行时 import + 内联副本/漂移 + 副本读 + §4-6；F4→§2.1 pass 唯一源=metrics、不 import oracle；F5→§2.4 探针/P11b 解耦；F6→§1 锚点 + §4-4 哨兵；F7→§2.3 ⓪ + 穷尽断言；F8→§2.2-4 parseFailed==0；F9→§2.1 文件表；F10→§2.2-3 精判格；F11→§2.2-1 路径/sha256；F12→§4-3 参数化；F13→§2.4/§7 presence≠配对；F14→§0 弱批数入表。
**pre-commit-audit（5❌+⚠️）**：❌1→§1 锚点改 ①+②≈9/③≈4（含 error）+ §4-4 带宽；❌2→§2.1 requiredEdges(tasks.ts,非src/lib)+本地 missingRequired+等价黄金测试+禁 import analyze-cross-batch；❌3→§2.4 自查基准改逐 band 桶②子池；❌4→§2.1 自带 copyFile 快照 + §2.2-1 ends-with 白名单 + R5 副本优先单一说法；❌5→全文 ¬pass/`no-pass` 分离；⚠️6→§2.3 ①字段路径钉死；⚠️7→§2.2-5 ⓪前置数字；⚠️8→§2.4 去恒真合取；⚠️9→§2.3 优先级 `⓪≻①≻②≻③` + 交叠 fixture；⚠️10/R9→§2.4 结构支三硬判据；⚠️11→§2.1 `arms` 白名单 + §0 全名；⚠️12/13→§4-4/§4-5 用四桶/全三列基线。
