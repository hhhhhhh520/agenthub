# AgentHub 卓越路线图：对标 Codeg 的工程质量

> 创建时间: 2026-09-20 | 修订: v7（§3.1 收口后） | 状态: 🟢 已审查（APPROVE_WITH_FIXES）→ 已整改，三项拍板落地
> 来源: 与 xintaofei/codeg (v0.30.10) 的代码级对比（2026-09-18/19）

## 修订记录

| 版本 | 日期 | 变更 |
|---|---|---|
| v1 | 2026-09-20 | 初稿（对比结论 → 路线图） |
| v2 | 2026-09-20 | 独立审查整改：🔴 shell 改法实测有误（会打死 Windows 主路径）→ 换修法；🔴 SSE 补发机制覆盖不了验收 → 改为待拍板；lint 门禁现状 362 errors → 改"改动文件门禁"；架构守卫改为"phase 写入唯一性"断言；认证移出阶段一（与既有威胁模型记录一致）；SDK 化降级为条件项；数字修正（31 路由 / 6 处 cliSessionId / 依赖关系纠错）；补"先证明会红"验收条款 |
| v3 | 2026-09-20 | 拍板落地：**SSE 重放 = 修彻底**（持久化四类事件）；**E2E = 自动化**（进 CI）；**认证 = 不加锁**（前提：只在本机运行，§8#1） |
| v4 | 2026-09-20 | 提交前 pre-commit 审查整改：v2/v3 残留回扫（5 处"待拍板"字样 + 1 处与"修彻底"冲突的退路 + 头部版本号）；`route.ts:70` → `:101` 行号修正（真实清理点在 DELETE handler）；交叉引用记法统一 |
| v5 | 2026-09-21 | §2.1/§2.3/§2.4 收口（每项 TDD + 守卫变异验证 + 2 独立审查 Agent）：§2.4 invalidateCliSession 统一入口（6 处散点→1 函数）；§2.3 孤儿清扫（启动时 instrumentation 扫描，junction rootDir 收口；覆盖面诚实口径 + 2 项后续待办）；§2.1 CI（vitest+build+改动文件 lint 门禁+phase 架构守卫，tests/ no-explicit-any 放宽后基线 362→52 errors）；§1 判据表/附录 A 数字同步 |
| v6 | 2026-09-21 | CI 首次实测（PR#1）两轮整改后全绿：① ubuntu 上 4 测试文件红（Windows 平台假设：opencode 虚拟路径/process-registry 信号语义/shadow-git 元字符目录名）→ test job 换 windows-latest（测试跑目标运行平台）；② runner 无 git identity → CI 配 git config；③ lint-gate 按口径拦下安全批次触碰文件（process-registry.ts）4 个存量 error → 清零（门禁收敛机制首次实际生效），基线 52→48 errors；push 触发分支 main→master 审查抓出（v5 内） |
| v7 | 2026-09-21 | §3.1 收口（2 commit，TDD +21 测试 + 2 独立审查 Agent）：四类过程事件持久化（AgentProcessEvent 表，thinking 截断 4K 拍板）+ seq 化推流 + GET events 重放端点 + 前端 EventSource 断线重连/seq 门/游标跨刷新；审查修复 🔴 abort 监听时序（interval 泄漏）、pollMs 下界、chat 锁泄漏（预存）、冗余索引；redo 改 SSE（三梯队第 7 项）一次消掉 |
| v8 | 2026-09-21 | §3.2 收口（1 commit，TDD +14 测试 + 变异验证 4 组精确红 + 2 独立审查 Agent）：写入点清单拍板（docs/design/phase2-3.2-write-points.md）——transitionPhase 快照条件写 CAS（重读重算 3 次上限 fail-closed）+ Task 批次状态全写点条件化（B1 互斥闸门/ B2 completed 交互式事务联动弃权/ B3-B5/B7 前置条件）+ invalidateCliSession expectedFrom（redo 409 关 TOCTOU）；审查抓出 GET stuck reset updateMany 缺 status 前置一并收口；B8 修正、决策点 trace 拒绝型分歧记 ISSUE-025；范围拍板：不引入 generation 字段（状态前置条件写已覆盖全部已证实窗口，理由见清单文档 §2） |

---

## 0. 背景与定位约束

**为什么写这份文档**：2026-09-18/19 对 codeg 与 AgentHub 做了代码级对比（4 个并行探索任务）。本文把对比结论转化为可执行的工程质量升级路线。

**定位不变（2026-07-07 决策）**：自用 + 研究（AI 协作的治理与可观测层），非产品化。注：仓库已为 PUBLIC + MIT（09-14 门面批次），"开源"既成事实；07-07 约束实际指向的是**不发包、不承担外部用户与兼容性承诺**。

**"Codeg 水平"的定义**：见 §1 判据表——一套品类无关的质量标准，与具体功能无关。

**证据约定**：本文 file:line 经 2026-09-20 两轮核实（作者 grep + 独立审查员复现）。附录 A 为已核实事实，附录 B 为审查发现与处置记录。文中"三梯队第 N 项"按 PROGRESS.md:262-265 清单跨行连续计数。

---

## 1. 判据对照表

| 判据 | Codeg 的样子 | AgentHub 现状 | 差距性质 |
|---|---|---|---|
| **质量门禁** | CI：clippy `-D warnings`、快照测试、架构守卫、453 前端测试 | ✅ 2026-09-21 起 `.github/workflows/ci.yml` 实测全绿（PR#1：lint-gate 40s + test 2m29s；vitest 全量 + build + 改动文件 lint 门禁 + phase 架构守卫；test job 跑 windows-latest——测试套件是 Windows 平台假设，目标运行平台）；1154 单测（2026-09-21）+ E2E 仅 13 个冒烟用例（自动化待 §5）；`npx eslint .` 当前 **48 errors / 83 warnings**（tests/ no-explicit-any 放宽 + execution.ts / process-registry.ts 清零后，experiments/p5 集中 39 个） | 有测试有门禁；lint 存量收敛中（§9#4） |
| **可靠性工程** | run_seq 世代号 CAS 贯穿状态迁移；崩溃恢复；残留清理 | SSE 无自动重连 / 无 Last-Event-ID（已核实）；thinking/tool_use/tool_result/permission_request 四类事件**只流式不落库**（已核实）；锁并发窗口为 ISSUE-022 已解决后的预期行为（非缺陷） | 关键路径缺恢复语义 |
| **安全底线** | 两条凭据通道（HTTP Bearer + WS protocol）+ 空 token fail-closed | 31 个路由零认证（**已拍板维持缓期：只在本机运行**，§8#1）；spawn 与 shadow-git 注入面已守卫（2026-09-20，§2.2 第 1/4 项）；`list_files`/`attachments` 路径校验已收口（§2.2 第 2 项） | 注入面已收敛 |
| **工程卫生** | 文档外置但同步；每版 release notes | 根目录 5 个遗留文件为 **git 已跟踪**（hello.py / index.html / script.js / styles.css / test_api.py）；无 CHANGELOG、无 release tag（`package.json` 版本 0.1.0 已有）；v2 决策文档标题写"12 项"实含 22 条（计数自相矛盾）；`CLAUDE.md:106` 端点数为过时数字（16 → 实为 31） | 已知欠账（遗留文件 + 两处计数 2026-09-20 已清，余项待办） |
| **独有杠杆** | ACP 协议 + 17 转录解析器（一次投资，永久收益） | decisionTrace / process mining 已有最小消费面（2 个 API 端点 + 231 行 analytics 页），距"可消费"完成度远 | 资产完成度低 |
| **可信交付** | 一键安装 + docs 站 + 10 语种 README | README 已含徽章/卖点/quickstart/架构图（815f2f0、59b07dd）——**缺实验数据**；交付形态仅 `npm run dev` | 差最后一段 |

---

## 2. 阶段一：工程底线（预计 1-2 周）

目标：把无条件项清零。全部是小活，无架构决策（认证已拍板不加锁，见 §8#1）。

### 2.1 上 CI（GitHub Actions）✅ 2026-09-21 完成

- ✅ `vitest` + `build` 全量 + **lint 采用"改动文件门禁"**（`.github/workflows/ci.yml`，push=master / PR）：PR 用 base.sha、push 用 `event.before`（全零回退 HEAD~1），ACMR 过滤 .ts/.tsx，0 error 阻塞、warning 不阻塞。**tests/ 的 `no-explicit-any` 实测为 error 级且存量 ~310 个**，已按"可先放宽"落 eslint.config.mjs（`tests/**` off）；全仓基线 362→**52 errors / 83 warnings**（experiments/p5 集中 39，收敛节奏 §9#4）。CI 里 `prisma generate`（generated 目录不跟踪）+ `prisma db push`（**Prisma 7 已移除 `--skip-generate` flag**，审查隔离实测；触发分支为 master——origin 实际默认分支，审查抓出 main 失配）。
- ✅ **架构守卫**（tests/architecture-phase-guard.test.ts，随 vitest 进 CI）：①非 state-machine.ts 的 `prisma.session.*` 写调用参数不得含 `phase:` 字面量（平衡括号提取，跳过字符串/注释配对）②`STATE_PHASE` 不得被外部引用。**每条均做过故意违规→精确红→还原**；盲区清单（$executeRaw/交互式事务/别名导入/方括号访问等 7 项 + 字符串字面量误报向量，18 例变异探测确认均无现役实例）固化进测试注释。
- 验收：✅ push/PR 上 CI 全绿（PR#1 实测：首跑暴露 ubuntu 平台差异 → test job 换 windows-latest + runner git identity + 门禁拦下 process-registry.ts 存量 error 清零，第二轮全绿）；lint 门禁本地等效验证（脏文件 exit 1 / 干净文件 exit 0）。

### 2.2 安全修复（无条件项）

1. **spawn 注入面收敛（修正版，🔴 审查抓出的关键纠错）**：v1 提议"shell 默认改 false"**会打死 Windows 主执行路径**——本机实测（Node v24.14.0）：`spawn('claude', …, {shell:false})` → ENOENT；`spawn('claude.cmd', …)` → THROW EINVAL；`shell:true` → 正常。原因：Windows 上 claude/opencode 是 npm 全局 shim（.cmd），Node ≥18.20.2 起 `shell:false` 无法启动 .cmd/.bat。且 OpenCode 适配器已显式 `shell:true`（`opencode-adapter.ts:212`），改默认值对它零收益、只伤 Claude 路径。
   **正确修法**：保持 `shell:true`，收敛可注入面——prompt 已走 stdin（`promptAsArg` 全仓无人设为 true，已核实），命令行上只剩 `--dir`(workDir) / `--model` / `--allowedTools` 三个用户自填字段：对它们做校验/转义，或用 `cmd.exe /d /s /c` 显式包裹并严格引号。注意 Node 的 DEP0190 警告（shell:true + args 数组 = 仅拼接不转义）证实了这个方向。
   **✅ 已完成（2026-09-20）**：新增 `src/lib/adapter/arg-safety.ts`（`assertSpawnSafe`），在 process-registry spawn 前对 command+args 做 fail-closed 校验，拒绝 cmd 元字符 `&|<>^%!"` 与空白（注入已实测复现：`x & echo PWNED`）；反斜杠 Windows 路径不误伤；16 个新测试（含 2 个接线测试，防"删守卫全量仍绿"的变异存活）。**行为变化**：含空格的 workDir 由"静默截断"转为"显式报错"（fail-closed）——仅 OpenCode 路径的 `--dir`/`--file` 上命令行；Claude 路径 workDir 只作 `cwd` 不进参数，不受影响；修复前这些场景本就不可用。
2. ✅ **`list_files` 路径校验收口**（2026-09-20 完成）：新增 `isListDirSafe`（path-safety.ts）消除前缀同族绕过（`../project-evil`）；进一步收口 junction 泄漏——新增 `src/lib/list-dir.ts`（`listDirTree` 手动递归不跟进符号链接，`listProjectFiles` 承载工具主体）；同型缺口 `attachments/[id]` 路由裸 `startsWith` 一并换 `isPathSafe`；新增测试：累计 1098→1137（校验守卫 +5 / 接线 +2 / junction 收口 +11 / spawn 守卫 +16 / shadow-git +5），全量通过。
3. ✅ **让"只在本机运行"从意图变成事实**（2026-09-20 完成）：dev 脚本加 `-H 127.0.0.1`（实机验证：日志 `Local: http://127.0.0.1:3000`，监听仅 127.0.0.1）；README 加安全提示。访问统一用 `localhost:3000`（避免 Next 16 的 127.0.0.1 ≠ localhost 跨源坑）。
4. ✅ **shadow-git execSync 模板串注入收口**（2026-09-20 审查发现并当日修复）：`projectDir` 零校验入库 + `shadow-git.ts` 模板串拼 shell 构成注入机制——exec 命令串层实测 canary 被写入；端到端在 Windows 被前置 `fs.mkdirSync` 闸住（`"` 是非法路径字符先抛 ENOENT），POSIX 下可达。**修法**：7 处 execSync 全改 `execFileSync` 参数数组（无 shell），新增 5 测试（源码守卫为唯一回退绊线）；集成测试（真实 git+FS）9/9 通过；顺带消除旧实现引号内 `%VAR%` 展开缺陷。

### 2.3 卫生清零（2026-09-20 部分完成）

- ✅ 从 git 移除根目录 5 个遗留文件并补进 `.gitignore`（`git rm --cached`，磁盘文件保留）。
- ✅ **shadow-git 孤儿目录清扫**（2026-09-21 完成）：`cleanupOrphanShadowGits`（shadow-git.ts，纯 FS）+ `src/instrumentation.ts` 启动扫描（distinct projectDir，nodejs runtime，best-effort 三层容错）；rootDir 为 junction/symlink 时 lstat 整目录跳过（删除原语不跟进链接，对齐 list-dir.ts 先例）。**覆盖面诚实口径**：只清"id 失联且 projectDir 仍被存活 session 引用"的孤儿；session 活着但目录漂移（PUT 改走/清空 projectDir）需 DELETE/PUT 侧按旧 projectDir 主动清——**后续待办**。启动快照竞态（多实例下 findMany 快照与扫描非原子，新 session 影子目录可能被误删→敏感越界守卫静默失效；单实例 register 阻塞启动期基本安全）——**后续待办**（per-id 复查 / mtime 宽限期）。
- ✅ 修 `CLAUDE.md:106` 的过时端点数（16 → 31）。
- ✅ 修 v2 决策文档的计数自相矛盾（标题"12 项" vs 实含 22 条）。

### 2.4 `invalidateCliSession()` 统一入口 ✅ 2026-09-21 完成

- ✅ 新增 `src/lib/services/cli-session.ts`：单事务清 Task + SessionMember.cliSessionId，调用方附加字段 taskData 合并后强制 `cliSessionId: null`（spread 顺序兜底，测试锁定反序变异）；**不含 kill 进程**（三条调用路径均发生在 agent 进程退出后的结果处理阶段，杀活跃进程属 process-registry 职责）。
- ✅ 6 处散点全量替换（`redo/route.ts` ×2 + `execution.ts` ×4）；静态守卫：该字面量在 src/lib/services + src/app/api 只允许出现在统一入口 + 两调用文件必须 import（变异验证：故意改回字面量→精确红→还原）。
- 非阻塞备注（审查记录）：守卫扫描范围暂不含 orchestrator/adapters 目录；success 路径（execution.ts:367-384）两表同写为仅存人肉复制点，未来可纳入统一入口的"赋值"变体。

**阶段验收**：CI 绿 + 安全审查 2 轮无 Critical + `git status` 根目录干净 + 每项改动有针对性测试（含守卫的"先证明会红"）。

---

## 3. 阶段二：可靠性工程（预计 3-4 周）

目标：把「研究装置」升级为「可依赖装置」。

### 3.1 SSE 事件序号 + 重放（最高优先）✅ 2026-09-21 完成

- ✅ **四类过程事件持久化**（已拍板修彻底）：新表 `AgentProcessEvent`（sessionId+seq 唯一，随 session 级联删）——thinking/tool_use/tool_result/permission_request + permission_cancel 五类；text/error 成品仍由 Message 表承载（重放不重复）。**隐私口径（2026-09-21 拍板）：thinking 截断 4K 字符入库**；封顶 500 条/session（先 trim 后 create 硬上限，首触顶 warn 对齐 decisionTrace 模式）。db push 应用（migration 历史与库早已 drift，migrate dev 会要求 reset 丢数据）。
- ✅ **seq 化推流 + 重放端点**：chat route 持久化帧带 seq（streamClosed 后仍落库不推流——刷新补发前提）；`GET /api/sessions/[id]/events`（Last-Event-ID 优先、补发带 replay 标记 + DB 轮询增量、abort 窗口防御）；redo noopSendEvent 退役（三梯队第 7 项一次消掉）。
- ✅ **前端断线重连**：EventSource 常驻 + seq 单调门去重（双通道）+ 游标 sessionStorage 跨刷新恢复（精准补发断线窗口）+ permission_request 补发不重新弹窗。
- **审查抓出并修复**：🔴 events 端点 abort 监听注册晚于 backlog await（补发期间断开 → interval 泄漏至进程重启，StrictMode 可稳定触发）→ 顶部注册 + aborted 主动检查（变异验证精确红→还原）；⚠️ pollMs 无下界（钳制 50ms）；⚠️ chat finally 二次 close 跳过锁释放（预存，包 try/catch）；⚠️ 唯一约束冗余索引去除。**遗留待办**：tool_result/tool_use 单行体积无截断口径（本机自用可接受）。
- 验收：断线不丢流（含四类过程事件）✓；测试 1175 passed / 3 skipped（+21 全部先红后绿）；2 独立审查 Agent（声明一致性 10/10）。

### 3.2 generation CAS 统一状态写入 ✅ 2026-09-21 完成

- ✅ **写入点清单先行**（docs/design/phase2-3.2-write-points.md）：全景 A1-A4/B1-B10/C1-C2 逐点评估 + 窗口分析（abort 提前释放锁的僵尸流双写窗口实证）+ 范围拍板（不引入 generation 字段：状态前置条件写已结构性覆盖，generation 的增量价值只在 §3.3 需要批次纪元时再评估）。
- ✅ **phase 写入 CAS**：transitionPhase 改快照条件写（updateMany where {id, phase, phaseStep}=读时快照）+ 冲突重读重算（3 次上限）+ 仍冲突/非法 fail-closed 拒写；trace 条目用最终成功轮的快照。
- ✅ **Task 批次状态条件化**：B1 pending→in_progress 互斥闸门（count=0 剔除出批+重读同步——重复执行结构性不可能）；B2 completed 交互式事务（count=0 时 result 不落、member 不写、跳过 monitoring）；B3/B4/B5/B7 前置条件写；B6 invalidateCliSession 加 expectedFrom（敏感='in_progress'/纠偏='completed'/redo=['failed','blocked']→409 关 TOCTOU）。
- ✅ **审查收口**：GET stuck reset 的 updateMany 补 status 前置（唯一能造成误 done 的残余写者）；决策点 trace 拒绝型分歧记 ISSUE-025（存量）。
- 验收：✅ 回归基线 10 用例先红（现状无条件写全数击穿）；✅ 变异验证判别力 4 组（phase CAS 去条件/B1 去条件/B2 去条件/B6 忽略 expectedFrom → 各自精确红后还原全绿）；测试 1175→1189。

### 3.3 执行中断恢复语义

- 批次中断后能恢复，而非依赖锁超时行为。参考 codeg：reconcile tick + 以外部事实（git）为裁决 + 「半成品清理」路径。

### 3.4 monitoring 结构化（兼研究变量）

- 现状（已核实）：`execution.ts:434` `executeSingleAgent` 让 Orchestrator 出 `needsCorrection`（`:460`），上限 `MAX_CORRECTION_RETRIES`（`:467`）——LLM 审 LLM。
- 改法：git truth 完成性校验（declaredFiles 声明的文件是否真的变更）+ preflight 命令红绿灯，结构化检查前置，LLM 审查降级为可选第二道。
- **兼研究**：结构化 vs LLM 审的纠偏触发率差异本身就是 A/B 实验（三梯队第 1 项）。
- 注：与 §2.4 撞同一段代码（`execution.ts:471-488` 纠偏路径），排期时合并处理。

**阶段验收**：断线不丢流（完整重放，含四类过程事件）、中断可恢复、重复执行结构性不可能、monitoring 有结构化层 + A/B 数据；每项先证明会红。

---

## 4. 阶段三：研究资产产品化（预计 3-5 周）

### 4.1 trace 可视化升级（真正的杠杆）

- 现状：已有 231 行最小页（`src/app/(dashboard)/analytics/page.tsx`，P4 T6）+ 2 个 API 端点（`/api/analytics/process`、`/api/sessions/[id]/process`）——不是从零，是补完成度。
- 做法：先写**从现有页到目标页的差距清单**（conformance 视图、DFG、变体、纠偏时间线缺什么），再逐项补齐到 Codeg token usage analytics 的完成度。
- 验收（可操作化）：随机抽 3 个真实会话，不看代码、仅用 dashboard，能在 5 分钟内说出"这次协作在哪一步跑偏、被什么机制拦住"。
- 注：数据源是已持久化的 decisionTrace，**与 §3.1 无关**（v1 的依赖声明有误）。

### 4.2 治理层 SDK 化（条件项，降级）

审查裁定：**现在不做**。理由（采纳）：
1. 顺序错误——阶段二/三正在大改治理层接口（3.1 事件流、3.2 CAS、3.4 审查链），此时抽库 = 抽一个正在变形的接口，必然二次返工；
2. 定位不符——"给别人的编排层加治理"是产品化叙事；研究的产出是可验证结论（§4.3 已承担对外证明功能且不需要 API 稳定）；
3. 决策量级误判——仓库已 PUBLIC，"冲突"被夸大；npm 包是可逆增量，不是定位级重拍板。

**启动触发条件（三条同时成立再谈）**：外部有人明确要复用（非"理论上有人要"）+ 3.1/3.2/3.4 全部落地且 3 个月内无接口变更 + 有人承担 npm 兼容性承诺。

### 4.3 实验方法论公开

- 复盘文档（三梯队第 9 项）+ P9/P10 实验报告整理为可发布形式。
- 差异化：Codeg 的 README 给不出"为什么有效"的证据，AgentHub 能。

---

## 5. 阶段四：交付与开放（预计 1-2 周）

1. **README 补实验数据**（已含徽章/卖点/quickstart/架构图，"重写"降级为"补一节"）。
2. **v0.1 版本化**：CHANGELOG、release tag（版本号 0.1.0 已有）、issues 模板。
3. **LICENSE / CONTRIBUTING 复核**（两文件已存在）。
4. **E2E 从 13 补到 ~50 + 进 CI**（✅ 已拍板 2026-09-20：自动化）。前置工作：
   - 先修不一致：`playwright.config.ts` 无 globalSetup、e2e/ 无 skip 守卫，与 README 声称的"默认 skip，需密钥"不符；
   - 密钥走 GitHub Secrets（**禁止硬编码**，沿用测试内 env + skipIf 惯例）；无密钥时 CI 内自动 skip，保证 fork/PR 不因缺密钥全红；
   - 评估 dev server 启动方式与运行时长（真 LLM 调用），必要时降频（如仅 main 分支或每日跑）。

---

## 6. 明确不做

- 任务板 / worktree 编排 / 移动端 / 15 agents / 多语种——产品广度，同赛道比肌肉必输。
- SaaS、多租户、Docker 分发。
- 实验开关留在生产热路径：现状 `applyTransitionWithOverride` / `isExperimentOff` / `idlePrematureDoneGate` 的调用点在 `chat-router.ts`（`:94/:121/:160`，`:9` 为 import 行；已核实）——seqgate 转正时移出。**加硬时限：转正条件（可分析会话 ≥20 且命中 ≥5）若 3 个月内未满足，也强制移出**，避免"两套机制并存期过长"无人触发。

---

## 7. 完成判据（怎么知道到了「同水平」）

- [ ] CI 绿（含 E2E 自动化）+ ≥1 条"会红验证过"的架构守卫 + 测试金字塔不倒挂
- [ ] 断线不丢流（完整重放，含四类过程事件）、中断可恢复、重复执行结构性不可能
- [ ] 安全注入面收敛（shell 字段校验 / 路径校验）；认证按 §8 拍板结果执行
- [ ] trace dashboard：3 个真实会话盲测 5 分钟可解释
- [ ] 一份公开的实验报告 + **在一台干净机器上从零安装跑通**（不引入外部用户）
- [ ] 仓库根目录干净、文档与代码同步（含端点计数等）、有 CHANGELOG 与 release tag

---

## 8. 拍板记录

| # | 事项 | 状态 | 决定 |
|---|---|---|---|
| 1 | **API 认证** | ✅ 已拍板（2026-09-20） | **不加锁，维持缓期**——前提：只在本机运行。前提的技术保障列入 §2.2 第 3 项（dev 绑定 127.0.0.1 + README 警告）。若将来要远程访问/公网部署，重新拍板（届时可用 middleware.ts + cookie 单口令的轻量做法） |
| 2 | **SSE 重放覆盖** | ✅ 已拍板（2026-09-20） | **(a) 修彻底**：持久化四类事件，完整重放（§3.1） |
| 3 | **E2E 的 CI 归属** | ✅ 已拍板（2026-09-20） | **(a) 自动化**：进 CI，密钥走 Secrets + 无密钥自动 skip（§5 第 4 项） |

## 9. 风险

| # | 风险 | 说明 |
|---|---|---|
| 1 | 时间估算 | 各阶段合计 **8-13 周**（1-2 + 3-4 + 3-5 + 1-2）；考虑阶段二 SSE 改造的不确定性，实际预期 **10-14 周**（含缓冲） |
| 2 | 阶段依赖 | §3.4 与 §2.4 撞同一段代码（execution.ts:471-488）需合并排期；其余阶段相互独立（v1 的"4.1 依赖 3.1""3.4 依赖阶段一"均经审查证伪） |
| 3 | 实验开关移出 | 与 seqgate 转正绑定 + 3 个月硬时限（§6） |
| 4 | lint 收敛节奏 | 362 errors 存量，改动文件门禁若长期不收敛，等于门禁虚设——需设阶段目标（如每阶段降 30%） |
| 5 | 事件持久化容量 | 四类过程事件入库后数据量显著增长（thinking/tool_result 体积大），需容量上限 + 清理策略，否则重演 shadow-git 类无界增长 |
| 6 | E2E 自动化成本 | 真 LLM 调用 + dev server，CI 时长与密钥成本需控（降频策略见 §5 第 4 项） |

---

## 附录 A：已核实事实（2026-09-20 两轮核实）

| 事实 | 位置 | 核实方式 |
|---|---|---|
| spawn `shell` 默认 true | `src/lib/adapter/process-registry.ts:358` | grep + 本机 spawn 实测（ENOENT/EINVAL/OK） |
| Windows 上 shell:false 无法启动 claude | npm shim：`%APPDATA%\npm\claude.cmd` | node 实测复现 |
| `list_files`/`attachments` 路径校验已换 isPathSafe（2026-09-20 收口，含 junction 不跟进） | `src/lib/list-dir.ts` / `src/lib/path-safety.ts` | grep + 端到端实测 |
| monitoring = LLM 审 | `src/lib/services/execution.ts:434/460/467` | grep |
| 实验开关在生产热路径 | `chat-router.ts:9/94/121/160`；`state-machine.ts:133/152/178/252` | grep |
| 根目录 5 遗留文件为 git 已跟踪 | `git ls-files` | 命令确认 |
| 无 CI | ~~无 `.github/`~~ → 2026-09-21 起有 `.github/workflows/ci.yml`（vitest + build + 改动文件 lint 门禁 + 架构守卫；push=master/PR） | ls |
| API 路由 31 个、零认证 | `find src/app/api -name route.ts \| wc -l` = 31 | 命令（v1 写 32 有误） |
| `cliSessionId: null` 6 处 2 文件 | ~~`redo/route.ts:82,96` + `execution.ts:326,333,478,483`~~ → 2026-09-21 已收口至统一入口 `cli-session.ts`（守卫锁定该字面量仅存于统一入口） | grep（审查报告写 7 处，复核为 6） |
| eslint 现状 | `npx eslint .` → **131 problems (48 errors, 83 warnings)**（2026-09-21：tests/ no-explicit-any 放宽 + execution.ts / process-registry.ts 存量 any 清零后；v2 记录 362 errors 为放宽前口径） | 实跑 |
| SSE 无重连 | 全仓无 EventSource / Last-Event-ID；`use-chat.ts` fetch+getReader | grep |
| 四类事件不落库 | `message.create` 只存成品消息；thinking/tool_use/tool_result 仅 chunkQueue emit | grep |
| task_status 轮询是显式设计 | `use-chat.ts:184` 注释 | sed |
| analytics 最小页存在 | `src/app/(dashboard)/analytics/page.tsx`（231 行） | wc |
| 仓库 PUBLIC | `gh repo view` → visibility: PUBLIC, isPrivate: false | 命令 |
| 单测 1175 passed / 3 skipped（2026-09-21 §3.1 后；v6 记录 1154、v4 记录 1137、初版 1098） | `npx vitest run` | 实跑 |
| 关键文件真实路径 | `src/lib/services/{execution,chat-router,shadow-git,alignment}.ts`；`src/lib/orchestrator/{state-machine,decision-trace}.ts` | find |

## 附录 B：审查发现与处置（2026-09-20 独立审查 → v2/v3/v4）

| 发现 | 严重度 | 处置 |
|---|---|---|
| R1 shell 改法打死 Windows 主路径（实测） | 🔴 | 已改修法：保持 shell:true + 收敛三个用户自填字段（§2.2 第 1 项） |
| R2 SSE 补发覆盖不了四类事件 | 🔴 | ✅ 已拍板修彻底：持久化四类事件（§3.1） |
| R3 lint 门禁当前 362 errors | 🟡 | 已改"改动文件门禁" + 收敛节奏目标（§2.1、§9#4） |
| R4 架构守卫从第一天就是绿的 | 🟡 | 已改为"phase 写入唯一性"断言（§2.1） |
| R5 认证波及面未量化 | 🟡 | 已量化（31 路由/63 调用点/19 测试）+ 移出阶段一，已拍板不加锁（§8#1） |
| R6 E2E 无 CI 归属 | 🟡 | ✅ 已拍板进 CI（自动化），先修 playwright/README 不一致（§5 第 4 项） |
| R7 promptAsArg 死配置/过时注释 | 🟢 | 按规矩只报告不删除（已记录，未行动） |
| Q1 认证与既有威胁模型冲突 | 意见 | 采纳：移出阶段一，已拍板维持缓期（§8#1） |
| Q2 "外部用户"判据偏产品化 | 意见 | 采纳：改"干净机器从零安装跑通"（§7） |
| Q3 锁 60s 行描述方向错 | 意见 | 采纳：ISSUE-022 已解决，属预期行为（§1） |
| 遗漏 1：阶段二/三缺"先证明会红" | 遗漏 | 已补入 §3.2/§3 验收与 §7 |
| 遗漏 2：CLAUDE.md 端点数过时 | 遗漏 | 已入 §2.3 |
| 遗漏 3：实验开关无时限 | 遗漏 | 已加 3 个月硬时限（§6） |
| 遗漏 4：§4.1 判据不可操作 | 遗漏 | 已改盲测式验收（§4.1） |
| 遗漏 5：shadow-git 清理缺位 | 遗漏 | 已入 §2.3 |

## 附录 C：Codeg 侧参考要点（独立复核：行号无漂移）

- git truth 校验：`engine.rs:3863` `merge_landed_commit`（HEAD 位移 ∧ is_ancestor ∥ trees_equal）
- 任务引擎：`engine.rs:421` `run_task_engine` / `:922` `pump_folder`
- 崩溃恢复：`recover_merging:5304`（以 git 为唯一裁决，merging 行永不直接失败）
- 认证：`web/auth.rs:24` `require_token`（Bearer + WS protocol 两条凭据通道，空 token fail-closed）
- 架构守卫：`test.yml:145`（web handler 必须走 `commands/*_core`）；`test.yml:143` clippy `-D warnings`
