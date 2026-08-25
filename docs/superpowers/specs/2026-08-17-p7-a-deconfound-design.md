# P7-A 受控实验设计：重建状态机 ON/OFF 区分度（去行为引导）

> 日期：2026-08-17 | 状态：设计初稿（待用户拍板 + 安全审查 + 计划化）
> 项目：AgentHub A方向（显式状态机） | 上游：`docs/superpowers/specs/2026-08-15-p6-full-matrix-design.md`（P6 已执行完）
> 定位：独立于 P6 的新实验（P6 数据保留作历史基线，P5/P6/P7 三批条件不可直接合并）

## 1. 问题

P6 60-run 结果：**A/B 全 4 配置 5/5 pass，无状态机/verify 区分度**。根因（源码已核实）：

- `experiments/p5/run.test.ts:75` 的 delegate/self mock 罐头固定返回：
  `"委派任务已受理并拆解为可执行任务，请安排执行。"`
  该字符串是**行为引导信号**，直接告诉 LLM「任务已拆解好，去执行」。
- 于是无论状态机 on/off，LLM 都被引导走规范边（`align_decompose→align_arch`、`execute→exec`、`done`）→ 全部 pass → A/B 无区分。

**这正是 P6 记录的最大教训**：实验 harness 的罐头是行为引导信号（不是纯消息内容），P5/P6 为打通 pass 而把罐头语义化成「引导 execute」，代价是**抹平了被测试变量（状态机 on/off）的对比**。

## 2. 目标（用户拍板）

> P7 处理 A/B 无区分时，更看重「**最大化区分度**」——接受这是独立于 P6 的新实验。

即在**去除行为引导**的前提下，重新问出 P5 想问但被罐头压掉的问题：**当 LLM 可以自由推进（OFF）时，是否更容易走捷径、漏掉规范流程，进而导致可靠性下降？而状态机（ON）强制走完整流程是否带来稳定性？**

## 3. 已拍板 / 待定决策

| 决策 | 状态 |
|------|------|
| 目标 | **最大化区分度**（用户拍板） |
| 罐头回退 | **路线 A：delegate/self 罐头改中性，不再引导 execute**（已拍板） |
| delegate 罐头形式 | **delegate 保留 P5 的 JSON 任务列表**作为「纯内容、非行为引导」的中性对照，但**任务描述统一抽象**、不带 A/B/C 各自语义；self 用独立中性文本（已拍板，见 §4.1 细节） |
| oracle | **不改**（B 路线违背「最大化区分度」，排除） |
| 决策 prompt | **暂不改**（C 路线，后续确认仍无区分才考虑） |
| off/no-pass 诊断 | **新增**——用 decisionTrace 回放区分「走捷径被拦」vs「真卡死」，防误判 harness 缺陷为状态机价值 |
| 安全/方法论 | **已完成** Security Engineer 审查（APPROVE_WITH_MINOR_CHANGES，§10 全部吸收）；实施中每改动 pre-commit 三视角 |
| retain P6 | P6 数据保留作历史基线，P7 独立运行 |

## 4. 设计（路线 A 核心）

### 4.1 delegate/self 罐头回退为中性（两消费者拆开）

`experiments/p5/run.test.ts:76` 当前 **delegate 和 self 共用同一个 return 分支**，都返回引导句。P7 必须把两者拆开成两条独立路径：

| 消费者 | 当前 | 改后（中性） |
|--------|------|--------------|
| **delegate** | 引导 execute 文本（与 self 共用 `:76`） | 返回 **中性统一 JSON 任务列表**（`tasks` 数组 + declared_files）——只描述「一件事怎么拆」，**不包含**「已就绪 / 请执行 / 继续」类行为引导词 |
| **self** | 引导 execute 文本（同 `:76`） | 独立中性文本（如 `我已处理，结果如下。`）——self 是 orchestrator 自执行，ORCHESTRATOR_DECISION_PROMPT 会让它继续决策 |

**delegate 任务描述必须统一抽象，不复用 P6 三档**。P6 的 `cannedTasksByTask` 是 A/B/C 差异化过的：A「实现 add 函数放 math.ts」含「实现/函数」语义、B「登录接口」、C 非代码。若 delegate 直接复用，就把任务差异带进委派路径，再次耦合了「任务是否代码/模糊/可捷径」与「消息内容」——抹平区分的元凶会换个形态回来。P7 的 delegate JSON 用**一份中性的、抽象的**任务描述（如「一项已拆解的子任务」——**不含** `执行` 根，见红线+安全审查 F1），declared_files 空或一个与 A/B/C 无关的占位文件），只测「收到委派任务后 LLM 如何决策流程」，不测任务本身语义。

**⚠️ 行为引导红线（含安全审查 F1 修正）**：任何新罐头措辞**必须**先经 `p5.db` 真实轨迹实证、确认不含「执行/继续/已就绪/实现」这类引导词后再定稿（P6 教训）。安全审查指出：初稿样例「一项可执行的任务」里的 `可执行` 含 `执行` 根，与红线自相矛盾——`description` 字段用不含引导根的措辞，如 `'拆解生成的子任务'`；delegate JSON 的 `id`/`assignedAgent`/`dependencies` 保持结构统一，`description` 偏差与 A/B/C 正交，避免泄漏任务档位语义。

### 4.2 off/no-pass 诊断解耦（failKind 按配置分列）

**目的**：回答「no-pass 是状态机价值还是 harness 缺陷」——这是用户反复要求回答的问题，必须两列清爽分开，不能混排。

**实现**：`metrics.ts` 对每个 no-pass run 增加 `failKind` 判定（纯函数，decisionTrace 回放）。**failKind 按配置分列定义**，因为 ON/OFF 的 no-pass 语义天然不同：

| 配置 | failKind | 归属 |
|------|----------|------|
| **OFF** | `skipped-spec-edge`：phase 到 done 但 missing 规范边（`hasRequiredEdges=false`） | **状态机价值**——LLM 自由推进走了捷径、缺规范边被 oracle 拦下（ON 强制不会发生） |
| **OFF** | `defect`：撞 maxRounds / no-progress break 且未 done，或异常击穿 | **harness 缺陷**——没有走捷径，是卡死/超时 |
| **ON** | `done-but-conformance` | **状态机价值**——ON 的 no-pass 几乎尽归此（canonicalCorrect 纠正 + done 守卫在决策点就拦，ON 不会产生 skipped-spec-edge） |
| **ON** | `defect` | **harness 缺陷** |

report 按 config × task 展示两个 failKind 分布：**OFF 列 = 状态机价值 vs harness 缺陷；ON 列 = 状态机价值 vs harness 缺陷**，两列各清一列。不并入 pass 主口径。

**failKind 必须对 `resolveFailureMode` 全部 5 值穷尽（安全审查 F2/F5）**：`failureMode` 产生 `pass | escalate-exhausted | stuck | error | no-pass`。failKind 判定要显式 switch 覆盖全部，`error` 和 `escalate-exhausted` 不得静默折叠进 `defect`（异常击穿会把 harness 缺陷列灌满，直接误导 Gate 早停 / 结论）。命名用 `defect` 而非复用 `stuck`——避免与 `failureMode:'stuck'`（语义=撞 maxRounds）歧义（F5）。

> 修订注：初稿曾把所有配置混在一个 failKind 定义里，把 ON 也装进 `skipped-spec-edge`——错。ON 的 legit 失败被 done 守卫/canonicalCorrect 拦截在决策点，产生的只会是 conformance 违规，绝不产生 off 专属的 skipped-spec-edge。混排会把「状态机价值（ON 拦下非法）」和「harness 缺陷（卡死）」两股信号搅在一起，诊断自我矛盾。分列后各归其位。

### 4.3 范围（不做）

- **不改 oracle**（`metrics.ts:96`、`tasks.ts` requiredEdges）
- **不改决策 prompt**（C 路线）
- **不改 verify 维度开关 / 2×2 配置矩阵结构**（沿用 P6 `on+verify/on+no-verify/off+verify/off+no-verify`）
- **不改生产 8 Agent / 模型钉死**（deepseek-v4-flash + Ark 端点 + `GLM_MODEL/GLM_BASE_URL` env）

## 5. 执行策略（含显式中止门 Gate）

沿用 P6 分批可续跑（每格 5 run，12 批）。**但先跑单个诊断格，结果决定是否铺满全矩阵**：

### Gate（早期止损，不进全矩阵的条件判断）
先跑 **一个诊断格**（如 `off+verify / A`，5 run），读取两个信号：

1. **去引导后 OFF 是否出现 no-pass？**
   - ✅ **出现** → 区分度恢复，failKind 归因清晰 → 铺满全矩阵。
   - ❌ **OFF 仍 5/5 pass** → 说明 mock 装置本身（拆解 + 补拆兜底 handleArchitectPlan 会把 idle→execute 恢复成规范边）就诱使 LLM 走规范边，**「去引导」也救不回来** → **直接得出「mock 装置测不出状态机对比」的结论收官，不铺全矩阵**（省 60-run 的钱）。
2. **failKind 是否清晰可归因？** → 确认 `skipped-spec-edge` / `done-but-conformance`（状态机价值）与 `defect`（harness 缺陷）在两列可分，才进全矩阵。

> 说明：即使回退罐头，补拆兜底仍可能在 OFF 下把 idle→execute 走捷径恢复成规范边，使 OFF 依然 pass——这正是 Gate 要拦的「塞不出的差异」。钉死这条 gate，P7 不再为凑区分度烧 60-run。

全矩阵（若通过 Gate）：4 配置 × 3 任务 × 5 seed = 60 run（与 P6 同规模，便于对比形态，虽不直接同比）。

## 6. 统计与报告

沿用 P6：逐格 pass 数组（seed 排序）+ bootstrap CI + 配对 McNemar（状态机/verify 主效应）+ 交互 2×2 表 + seed noise + failKind 诊断分布。

报告新增：
- `## failKind 诊断（no-pass 分解）`——各格 `skipped-spec-edge`(状态机价值) / `done-but-conformance`(状态机价值) / `defect`(harness 缺陷) 计数（含 `error`/`escalate-exhausted` 正确归入 `defect`），附结论：区分度来自「捷径被拦」（状态机价值）还是「卡死」（harness 缺陷）。

## 7. 验证

1. 罐头拆 delegate/self 改动后先跑纯单测（P6 A1+A2 那组断言引导句会红——**需同步更新断言**，见 §8 风险）。
   - **shape 契约守卫（安全审查 F3）**：新增纯函数断言——
     - delegate 返回可解析 JSON（`{tasks:[...]}`，`description` 用中性抽象措辞）
     - self 返回不可解析的中性文本
     - 判别器用 systemPrompt 显式区分，不用模糊子串，防 shape 串台。
2. 单诊断格真实 LLM 冒烟，确认 failKind 归因正确（含 `error`/`escalate-exhausted` 正确归入 `defect`，F2/F4/F5）。
3. 全矩阵 60 run。
4. 报告生成 + 结论 + 文档同步（PROGRESS/memory/会话归档/P8 接续 prompt）。
5. 每次改动针对性测试 + pre-commit 三视角审查（F1-F6 逐条对照 §10）。

**failKind 实现细节（安全审查 F2/F4/F6）**：
- `failKind` 为 `RunMetrics` **optional 字段**（`failKind?:`），report/loadMetrics 显式处理 `undefined`（旧 resume 行、编译期 fixture）——不破坏 JSONL 前后兼容。
- 归类逻辑是**穷尽且 total** 的 switch（对全部 5 个 `failureMode`），collectMetrics 内绝不 throw（decisionTrace parse 复用现有 try/catch 防御模式），防丢行。

## 8. 风险与缓解

| 风险 | 缓解 |
|------|------|
| 罐头回退后 delegate 又诱导 done / 卡死（P6 教训复现） | 先 p5.db 实证措辞；单诊断格冒烟；failKind 诊断解耦 `stuck` 与 `skipped-spec-edge` |
| **补拆兜底仍在 OFF 下把捷径恢复成规范边 → 回退后 OFF 仍 pass，区分度塞不出来** | **显式 Gate（§5）**：单格冒烟若 OFF 仍 5/5 → 判定「mock 装置测不出」→ 直接收官不铺全矩阵，不烧 60-run |
| P6 A1+A2 cucumber 测试断言引导句被打破 | 计划化时列出需同步的全部断言，红绿验证 |
| 回退后 OFF 大量 no-pass 被误读为「状态机价值」 | failKind 区分「走捷径被拦」vs「卡死」，报告明确归因 |
| 凭证误投 / provider 限流 | 沿用 P6：专用 key，分批可续跑，重跑前备份 metrics |
| classifier 暂不可用阻碍 subagent 安全审查 | 已缓解：Security Engineer 审查已完成（§10）；实施阶段再遇不可用则重试 |

## 9. 相关文件（预计改动）

- `experiments/p5/run.test.ts`（罐头拆 delegate/self + 断言同步）
- `experiments/p5/metrics.ts`（failKind 按配置分列诊断）
- `experiments/p5/report.ts`（failKind 分布段）
- `experiments/p5/results/`（新 metrics.jsonl + report，gitignored）
- 生产源码：**零改动**

**oracle 边界（`tasks.ts`，预计零改动但需确认）**：delegate mock 若改用抽象统一 JSON，要注意它**不喂给 oracle 的 requiredEdges 判定**——oracle ② 看的是 decisionTrace 的 applied 规范边（`metrics.ts:22` hasRequiredEdges 从 trace 读，不读 mock 罐头）。delegate JSON 只给 1 个任务时，requiredEdges 的 `align_decompose` + `execute` 仍由**补拆（handleArchitectPlan）**主导，一般 OK。计划化须显式写一条：确认 delegate mock 改动不影响 oracle ②（写死，防 `tasks.ts` 边集意外依赖 mock 内容）。

---

## 10. 安全审查（Security Engineer，APPROVE_WITH_MINOR_CHANGES，2026-08-17）

无 High；涉及无凭证加密钥、无 provider 端点、无生产代码（F7/F8 已核）。实施必须吸收：

| # | 严重 | 发现 | 落入 |
|----|------|------|------|
| F1 | Medium | delegate 样例措辞「可执行」含 `执行` 根，与红线自相矛盾，经真实 LLM 决策上下文会被当指令重引导 | §4.1 已改「拆解生成的子任务」 |
| F2 | Medium | failKind 未覆盖 `error`/`escalate-exhausted`，折叠进 `stuck` 会灌满 harness 缺陷列、误导 Gate | §4.2 已加穷尽 switch |
| F3 | Medium | delegate(JSON) / self(文本) 契约不同，分叉判别模糊会导致 shape 串、parse 崩 → 丢 run / N=4 断配对 | 计划化须显式判别器 + shape 单测（详见 §7） |
| F4 | Low | failKind 在 collectMetrics 抛出会静默丢行（追平 existing 防御式 parse try/catch） | 实现须 total/never-throw |
| F5 | Low | failKind 复用 `stuck` 与 failureMode:'stuck' 语义不同 → 读者误读 | §4.2 已改 `defect` |
| F6 | Low | failKind 加进 RunMetrics 破坏 JSONL 前后兼容（旧 resume 行无 key） | 实现须 optional `failKind?:` + report/loadMetrics 显式处理 undefined |
| F7 | Info | 凭证/provider 面不变，无泄漏路径 | — |
| F8 | Info | 生产零 touch 成立 | — |

安全结论：收紧后可达。实现计划须把 F1-F6 逐条对应到具体实现点。
