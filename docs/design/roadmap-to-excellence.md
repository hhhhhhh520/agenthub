# AgentHub 卓越路线图：对标 Codeg 的工程质量

> 创建时间: 2026-09-20 | 修订: v53（Batch 0/1 收口 + 双维度权限/CLI 探针 + P1-01/02/03 闭环 + P2 全闭环（P2-08/11/12/13 经 Round 5 + Round 6 补齐）+ P3 #6/#8/#9/#10/#19 闭环；剩旧 P3 23 项） | 状态: 🟢 已审查（APPROVE_WITH_FIXES）→ 已整改，三项拍板落地
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
| v9 | 2026-09-21 | §3.4/§3.3 收口（2 commit，各 TDD + 2 独立审查 Agent + 变异精确红）：§3.4 monitoring 结构化——信号层纯函数（S1 git-truth 完成性/S2 outputSchema）+ EXPERIMENT_STRUCTURED_MONITOR 门控（on=结构化先行 LLM 降级第二道；未设=现状+反事实埋点 event:'monitor'）+ applyCorrection 统一助手（结构化/LLM 两臂同语义同遏制）+ preflight 命令红绿灯**不做**（RCE 面+schema 变更需单独拍板）；审查实证并修复 monitor 埋点丢 success trace 回归（B2 后内存 trace 未同步，基串改 successTrace + 同步补齐）；§3.3 启动 reconcile——in_progress 条件写置 pending + working 成员**无条件**清扫（审查 F1：成员残留与任务残留不必然共存）+ 周期 tick/半成品清理/phase 改动**不做**（拍板理由落档）；审查者读 Next 16.2.6 dist 源码实证 register 阻塞首个请求——启动竞态结构性闭合；A/B 数据=埋点装置就位、实验待跑（三梯队第 1 项 harness） |
| v10 | 2026-09-21 | 三梯队第 1 项装置收尾（2 commit：9c0ae4a/471af12，方案安全审查+攻击者+声明一致性三视角闭环）：**生产修复**（用户拍板）——监控 prompt 的 audit.declared 曾传声明清单而非真实交集（ghost 场景谎报"声明已修改"系统性压低审查 LLM 检出），改传 attributed（declared∩changed）；**P11 monitor A/B harness**——p5 原地扩臂（MONITOR_AB='1' 门控与 legacy 批互斥），两臂 on-monitor/on-llmmon × 4 罐头（clean/ghost-S1/schema-S2/plausible-wrong）× 5 seed，mock 剧本写真实文件（assertSafeCannedPath 三断言 fail-closed）+ 监控审查透传真实 LLM（臂判别 mocks.state.monitorReal 显式标记）+ env 快照第四键（防两臂同质化）+ parseMonitorCycles 按 success 分段配对两判据 + generateMonitorReport（含效度口径段）；变异精确红 2 组（on 臂归因/legacy 劫持门）；**批跑待 GLM_API_KEY**（用户侧），跑完按 §6 时限判定转正或移出；**S3 preflight 命令红绿灯第一版落地**（2026-09-22 用户拍板 1A/2A/3A：1A 约定探测 package.json scripts.{test,build,lint} 命令永不来自 LLM 零 schema 变更 / 2A `npm run <key>` 白名单三层收口——来源钉死+VERIFY_SCRIPT_KEYS+assertVerifyKey，Windows npm-shim 需 shell 的注入面收口 / 3A exit≠0 仅记 event:'preflight' 采数据不纠偏；EXPERIMENT_PREFLIGHT_VERIFY 门控，commit cae7cd2；已知限制落档：exec timeout 孤儿树+deadline 侵蚀，转正前收口） |
| v11 | 2026-09-26 | **P11 monitor A/B 批跑完成（三梯队第 1 项临门一脚）**：首批 tokenrhythm qwen3.8-flash 40 runs 全空转——Claude Code CLI 新版 model catalog 拒未知模型名（请求从未发出，transcript `model=<synthetic>` 铁证）+ preflight 黑名单漏签名假绿放行（ISSUE-026，无效数据备份隔离）；换火山方舟 ark plan（ark-code-latest→网关 glm-5-3-flash-260901）第二批 40/40 有效（109min LLM 延迟）：**结构化对 S1/S2 全 33 可观测 cycle 零漏检（llmOnly=0）+ 零误报**（D clean 基线两臂 0 触发），LLM 臂 9/13 cycle 检出、对 G（自曝缺陷）零检出；run 级 McNemar E p=0.5（n=5 功效不足，方向性证据）。报告落档 `experiments/p5/results/report.monitor-2026-09-26.md`（results/ 不进 git；判读含 D/G 测量面缺失定性：决策 LLM 行为方差跳过对齐链）；**structured-monitor 转正拍板待用户**（§6 硬时限 2026-12-21；→ 2026-09-27 已拍板转正并落地，见转正记录）。**ISSUE-026 闸门加固同批落地**：detectPreflightError 补 CLI 三签名 + preflight 回复**精确匹配**「就绪」（双审查拍板 exact-match，堵「服务未就绪」子串洞与 sentinel prompt 回显洞；TDD 先红 + 变异 3 组精确红 + 2 独立审查 Agent）；**§4.1 差距清单落档** `docs/design/phase3-4.1-visualization-gap.md`（G1 单会话 trace 视图 = 零消费端点 /api/sessions/[id]/process 的归处，G1→G2→G4→G5→G3 顺序）。教训落档：批跑运行期间禁编辑 include 集合内文件（vitest fork 按需加载，尾部文件会读到编辑中间态） |
| v12 | 2026-09-27 | **§4.1 trace 可视化五步全部落地（commit 8f8f241，双审查整改闭环）**：G1 单会话追踪视图 `/analytics/sessions/[id]`（纠偏时间线：decisionPoint 徽标区分 LLM 决策/代码补记 + 提议/守卫重定向/实际转移 + casRejected 等徽标；端点新增 entries 字段——此前零消费端点接线）；G2 casRejectCount 展示 + violations 补 sessionId（index→session 映射）；G4/G5 变体/会话可点跳转（用户拍板入口维持 analytics 内部闭环）；G3 DFG 内联 SVG（零依赖，弧顶钳制/自环绕行防标签裁切——双审查抓出的正是重做回边与 redo 自环两条关键边）。tsc 0 错 / 1244 tests / build ✓。**n=10 扩容批（用户拍板加 seed 重跑换显著性）**：两次中断（01:37 宿主睡眠杀进程 9 rows；13:22 结束时 34 run 因主会话并发 vitest/tsc 缓存互踩瞬死——均非实验语义失败，部分数据备份隔离），有效 46 rows（D/E 两臂 n=10 完整、F on-monitor 6、G on-monitor 10）。**跨批合并判读（n=5+n=10）**：结构化 E 累计 **40/40 cycle 零漏检**（llmOnly 全局 0）、D 基线 30 runs 零误报、run 级合并 McNemar E **p_exact=0.0625**（0.5→显著性边缘）、LLM 臂 65% 检出。报告 `report.monitor-2026-09-27.md`。**审查者越权代工发现**（生产语义输入）：监控审查 LLM 借 work 目录 git toplevel 指向仓库根（无独立 .git），对 E/D 罐头"自己动手实现"写到仓库根（src/api/login.ts 等，已清理）——启示：审查 agent 应当只读；harness 修复方向=work projectDir 跑批前 git init 隔离（后续项）。**structured-monitor 转正建议**：证据齐（零漏检零误报+方向性显著+不减少防线），拍板待用户。批跑纪律教训：批跑期间禁并发 vitest/tsc、禁 rm 仓库内目录、避开睡眠时段 |
| v13 | 2026-09-30 | **ISSUE-027 LLM 通路死亡修复（四 commit e4d7796/d62f5cf/f64d2e7/1ab265f）+ §4.1 盲测验收（未过，开 ISSUE-028）**。根因三层：① claude.exe v2.1.270 -p 模式无视进程 env 的 ANTHROPIC_BASE_URL（8 组活体实验，spawn env 注入失效——治理观测与管线路径的连线是 issue 之外的独立发现）；② 首次换线 tokenrhythm 后冒烟撞出网关拒收 claude CLI 必发的 anthropic-beta: interleaved-thinking 头（10 模型全 400，curl 实证网关层拒绝）；③ opencode 的 env 注入路径同样触发该头，唯一可通 = 配置文件显式 provider options。落地：受管 CLAUDE_CONFIG_DIR settings.json 通道（claude-code-env.ts，哨兵+sweep+scheme 校验+resume 降级+instrumentation 启动兜底）；isPermanentError 补 5 签名快速失败；looksLikeCliSyntheticError（前缀+<300+CJK 放行）拦 orchestrator 三堆积点 + skipMsg 透传真错误；**8 agent 切 platform=opencode** + tokenrhythm/v1 + mimo-v2.6-flash（OpenCodeAdapter 生成 XDG 配置文件替代 env 注入，agentId hash 目录防路径逃逸，fail-fast，agentId 消毒防 arg-safety 拒启）。全程双审查+pre-commit-audit，测试 1303 passed。**§4.1 盲测（代用户执行）：讨论/工具执行全通（8/8 agent 两轮 0 超时）但决策时间线全库 0 条**——chat-router:71-78 决策 LLM 解析失败静默回退 handleOrchestratorChat（带工具直连），绕过状态机与全部 trace 写点不打日志；agenthub_read_messages MCP 有消息会话返回空； Tasks 恒 0（管线从未触发）。→ ISSUE-028（回退显性化+记 trace / 决策换快模型 / read_messages 排查）。教训：**「CLI+第三方网关」冒烟必须用真实 CLI 走全链路——curl 探针不带 beta 头会假绿**；决策模型与执行模型应分离 |
| v14 | 2026-09-30 | **ISSUE-028 决策链路修复（四 commit d0a122c/a7fec72/75cfa28/9a5e113）+ §4.1 验收复测通过**。① **回退显性化**（d0a122c）：chat-router catch 分支 console.error（JSON.stringify 转义防日志注入）+ sendEvent 告知用户 + decision-fallback trace 条目（与正常 self 决策同构，'self'∈NON_TRANSITIONING 不污染 conformance 口径）；reasonToString 抽叶子模块（ISSUE-011 防线复用）。② **决策/执行模型分离**（a7fec72+9a5e113）：decision-llm.ts OpenAI 兼容直连快通道，env AGENTHUB_DECISION_MODEL 启用（凭据缺省复用 Orchestrator Agent DB 配置，key 不落盘；BASE_URL/API_KEY 可显式覆盖），收口 getOrchestratorDecision + callLLM（analyzeScene/角色生成/架构师拆解），callLLMForAnalysis 明确排除（钉住测试）；redirect:'error' 禁重定向 + 错误体脱敏 sk- 形态 + AbortSignal 超时转译自定义 TimeoutError；**验收实测追加根因**：tokenrhythm 的 qwen3.8-flash 为混合思考模型，长 prompt 下思考耗尽 max_tokens（finish_reason=length，content 空）→ 请求体固定 enable_thinking:false（实测 5.0s vs 45.7s，快 9 倍）+ max_tokens 8192 兜底 + 空 content 错误带 finish_reason 诊断。③ **read_messages 全角色可见**（75cfa28）：旧 where 硬过滤 role:'agent' 是 orchestrator"失忆"根因，buildChannelWhere 三角色过滤 + 接线守卫。**验收复测（真实 UI 全链路，会话 bfa9f2c6）**：对齐→拆解→执行管线完整走通（PM 确认→架构师拆解 Tasks 3→后端交付 convert.js→测试交付 convert.test.js，node --test 独立复跑 pass 2/fail 0）；**决策时间线 4 条一致性 100%**（含 0-task 守卫真实拦截记录）；全量 1337 passed / 3 skipped。教训：**混合思考模型做结构化决策必须关思考（enable_thinking:false）或给足 max_tokens——思考耗尽预算时 content 为空且极易误诊**；空 content 错误要把 finish_reason 带出来 |
| v15 | 2026-10-19 | **Batch 0：锁队列重写 + 统一释放 + 取消全链路（commit b6b2deb/c5930d3）**。旧 Map 链式锁在 A 持锁、B/C 排队、B 超时后 A 释放时 C 永久卡死（已复现）→ 显式 waiter 队列（超时/abort 移除自己、release handoff 队首、release 幂等）；持有者 abort 不释放锁，chat route 用 `lockHandedOff` + stream finally 统一释放。新增 `cancellation.ts`：stop/delete 取消执行，`ProcessEntry.ownerSessionId` + `cancelByOwnerSession`/`terminateEntry`（5s 优雅 + 5s 强制，exit/exitCode/alive 三重确认）；未确认时 stop 202 / delete 409 且不删 DB。`handleExecution` 取消时本批未落地任务条件写回 pending，不 completed/不 auto-done；`withTimeout` onTimeout 有界 10s、`eventLogger.flush` 有界 5s。全量 1368 passed / 3 skipped。**下一批**：执行恢复边界 + 审计三态（审计通过前禁止成功）+ 批次级归责/停止自动删除；再后：权限模型双维度、事件 seq 不可变、配置 owner 清扫。 |
| v16 | 2026-10-19 | **Batch 1 审计三态 + 批次级归责 + 共享目录停止自动删除（commit 55d5012/e75339d）**。`shadow-git` 新增 `getGitSnapshotDetailed`/`getChangedFilesDetailed`（`{ok,reason}`），旧兼容入口失败改为抛错，不再把 git 失败伪装成空 diff。`execution.ts` 新增 `auditBatchChanges`（`pass/violation/unavailable`）+ `failBatchForAudit`：批次开始快照失败 → 本批不执行、任务 failed + trace `audit_unavailable`；批次结束 diff 失败 → 不写 result/completed、不跑监控/不 done；敏感路径按本批 `declaredFiles` 并集整批 failed；普通越界只发批次级告警，**共享 projectDir 不再自动删除文件**；审计通过前禁止任何成功发布。全量 1384 passed / 3 skipped。**下一批**：权限模型双维度 + CLI 探针、事件 seq 不可变/单 logger、OpenCode 配置清扫前缀 bug、Pin 独立短锁、UI 权限恢复。 |
| v17 | 2026-10-20 | **权限模型双维度 + CLI 探针（commit 4774de6）**。Claude Code 2.1.270 实测：`--bare` 只暴露 Bash/Edit/Read 且忽略 `--tools`，已移除；改用 `CLAUDE_CONFIG_DIR` + `--settings` + `--setting-sources user` + `CLAUDE_CODE_DISABLE_CLAUDE_MDS`，`--tools` 控制可用性，CLI 始终 `--permission-mode default`，auto 由 ProcessRegistry 自动 allow。OpenCode 2.0.27 实测：`OPENCODE_CONFIG`/`OPENCODE_PERMISSION` 不生效，权限改写 agent frontmatter `tools`/`permission`；`--auto` 替代 `--dangerously-skip-permissions`；headless `ask` 自动拒绝，因此 default = 只读（保留 `.env` ask），写操作需切 auto。新增 `opencode-permissions.ts` 纯函数与测试；全量 1387 passed / 3 skipped。**下一批**：事件 seq 不可变/单 logger、OpenCode 配置清扫前缀 bug、Pin 独立短锁、UI 权限恢复、MCP/E2E/P5 收尾。 |
| v18 | 2026-10-20 | **OpenCode 配置清扫前缀 bug hotfix（commit ca020b8）**。根因：`sweepOrphanOpencodeXdgDirs` 的 active 集合存完整目录名 `agenthub-oc-<hash>`，旧比较先 `slice('agenthub-oc-'.length)` 成 `<hash>`，永远匹配不上 → 启动/agents 列表 sweep 会把所有活跃 OpenCode 配置目录当孤儿删除。改为 `active.has(e.name)` 直接比较完整目录名；新增隔离 tmpdir 回归测试（active 含/不含哨兵目录保留、孤儿删除、非 agenthub 目录不动），变异验证恢复 slice 精确红后还原。全量 120 files / 1388 passed / 3 skipped。**下一批**：事件 seq 不可变/单 logger。 |
| v19 | 2026-10-20 | **任务结果发布门禁修复（commit be969e0）**。根因：`allResults` 在 completed 条件写/CAS 之前写入，count=0 后仍进入最终成功摘要与后续批次入参。改为 CAS 成功后才写入；纠偏退回 pending 时删除旧结果，避免重试失败/取消后发布旧结果。新增 B2 拒绝摘要、纠偏旧结果、正常成功摘要三条断言，变异验证精确红。全量 120 files / 1389 passed / 3 skipped。**下一批 P1/P2**：审计内容证据（已脏路径再次修改/被忽略 .env）、主批次 tools 透传、OpenCode 权限文件按会话隔离、regenerate chatSessionId、iterator.return 有界、stop/delete 生命周期串行、恢复审批关联。 |
| v20 | 2026-10-20 | **P1-01 审计内容证据（commit 0dd751a/ce2703b）**。`shadow-git` 新增 `GitEvidence`（路径 → sha256/null），快照覆盖 tracked dirty、untracked 与 ignored 敏感文件（`.env*`，目录型敏感前缀折叠）；`auditBatchChanges` 改用 Map，按内容 hash + key 存在性比较，覆盖已脏同一路径再次修改、删除和忽略 `.env`；被忽略目录内的 `.env` 用 pathspec glob 补抓。证据读取失败仍走 `unavailable`。新增真实临时 Git 回归与 execution 接线守卫，变异验证 Map 分支回退精确红。全量 121 files / 1397 passed / 3 skipped。**下一批 P1**：主批次 tools 透传、OpenCode 权限文件按会话隔离；随后 timeout/regenerate/stop-delete/恢复审批。 |
| v21 | 2026-10-20 | **P1-02 主批次工具白名单透传（commit a5e6991）**。`execution.ts` 批次 agent 映射保留 `tools`；`executeTaskBatch` 与 `executeSingleAgent` 共用 `parseAgentTools`，非空 tools 透传为 `allowedTools`，空/缺失保持不限制。新增批次 connect、单 Agent connect、空 tools、auto 不放大及 execution 接线测试；变异验证移除映射/透传均精确红。全量 121 files / 1400 passed / 3 skipped。**下一批 P1**：OpenCode 权限文件按会话隔离；随后 Claude MDS、timeout/regenerate/stop-delete/恢复审批。 |
| v22 | 2026-10-20 | **P1-03 OpenCode 权限文件按会话隔离（commit ae39e00）**。agent md/XDG 目录加入 chatSessionId + permissionMode + tools/model/baseUrl/workDir/mcpConfig 指纹与 adapter 实例 nonce；`--agent` 与文件同名，default/auto 并发不再覆盖。ProcessRegistry 记录 managedAgentFile/managedConfigDir，进程退出/取消清理，共享路径按存活 entry 保护，retry 重建前 preserveManaged；sweep 保留 registry 活跃 per-session 目录。新增隔离、清理、retry、sweep 回归并做变异验证。全量 121 files / 1405 passed / 3 skipped。**下一批**：P2-05 Claude MDS 隔离、timeout/regenerate/stop-delete/恢复审批。 |
| v23 | 2026-10-20 | **P2-05 Claude MDS 隔离（commit a24ca60）**。根因：`CLAUDE_CODE_DISABLE_CLAUDE_MDS=1` 只在有 provider 凭据时注入，已有登录认证的空配置 agent 跳过，workDir 的 CLAUDE.md 自动发现未隔离。修复：MDS 开关与 provider 分支解耦，所有 Claude spawn 注入；`CLAUDE_CONFIG_DIR`/`--settings`/envScrub 仍只在凭据存在时使用。新增空配置 registry 边界断言与 provider 分支 MDS 断言，变异验证删除 env 注入精确红。全量 121 files / 1405 passed / 3 skipped。**下一批**：P2-01 timeout、P2-02 regenerate、P2-03 stop-delete、P2-04 恢复审批。 |
| v24 | 2026-10-20 | **P2-01 timeout iterator 收尾（commit ff53430）**。根因：`withTimeout` 超时后 `finally` 直接 `await iterator.return()`，非合作 generator 的 return 永不 settle 时 TimeoutError 永远不返回、继续占会话锁。修复：`iterator.return` 与 `onTimeout` 共用 `runCleanupBounded`（同一 cleanupTimeoutMs/硬上限）；return 抛错只 warn，不覆盖 TimeoutError；wrapper 明确只保证自身有界返回，底层迟到写入不再 yield。新增 return 永不 settle / return reject 回归；先红验证 2s 超时与 Error 覆盖。全量 121 files / 1407 passed / 3 skipped。**下一批**：P2-02 regenerate、P2-03 stop-delete、P2-04 恢复审批。 |
| v25 | 2026-10-20 | **P2-02 regenerate 取消安全（commit 74bda96）**。根因：regenerate 调 `executeSingleAgent` 时 `chatSessionId` 为 undefined，`ProcessEntry.ownerSessionId` 为空，stop/delete 的 `cancelByOwnerSession` 找不到进程；返回后也未复查取消就更新原消息/发 done。修复：传 `sessionId` + `workDir`；执行返回后先查 `isSessionCancelled`，取消则只发停止文本，不写回原消息、不发成功 done。新增两条路由回归；先红验证 undefined 与 messageUpdate 已调用。全量 121 files / 1409 passed / 3 skipped。**下一批**：P2-03 stop-delete、P2-04 恢复审批、P2-06/07。 |
| v26 | 2026-10-20 | **P2-03 stop/delete 生命周期屏障（commit 31c5946）**。根因：DELETE 等锁释放后、删库前仍要清理附件/影子 git；并发 stop 可在该窗口判为停止完成并 `clearSessionCancel`，新 chat 拿到锁后在删除前启动。修复：新增 `session-lifecycle` 进程内 deleting 标记；DELETE 在取消前 mark，DB 删除完成后才随成功路径清理，失败/409 由 `finally` 清理以允许重试；stop 对 deleting 会话不清取消标记并返回 `deleting:true`/202；chat 拿锁前后都拒绝 deleting 会话（409，不建消息、不启动执行）。新增并发 stop/delete、deleting 保持到删库、失败重试、chat 拿锁前/后拒绝与删除后 404 回归；变异验证恢复 stop 清理与移除拿锁后检查均精确红。全量 121 files / 1415 passed / 3 skipped。**下一批**：P2-04 恢复审批、P2-06/07 HTTP cancel/旧快照。 |
| v27 | 2026-10-20 | **P2-04 恢复执行关联同一获批计划（commit 6292cdd）**。根因：任务事务已提交但 phase 未推进时，`ensureExecutableState` 只看 phase/taskCount，会自动从 align_pm/align_arch/align_qa 推进到 exec；崩溃后用户可能从未看到计划，或计划尚未确认。修复：计划消息追加任务集 plan ID（任务 ID 集合 sha256 前 16 位，无 schema 变更）；恢复前要求计划消息对应当前任务集且之后有用户消息；缺失/不匹配时 `transitionToExecution` 用现有任务重新展示计划并停回 align_arch 等待确认，不重拆、不重复建任务、不调用 handleExecution。新增 producer/consumer、未呈现、未确认、任务集不匹配、无计划重展示与 chat 路由级回归；变异验证删除计划检查/确认检查/计划 ID 均精确红。全量 122 files / 1422 passed / 3 skipped。**下一批**：P2-06/07 HTTP cancel/旧快照。 |
| v28 | 2026-10-20 | **P2-06 SSE body cancel 安全（commit 7520866）**。根因：`controller.enqueue` 无关闭保护，ReadableStream 也没有 `cancel()` 分支；客户端取消 body 后继续推流抛 TypeError，异常穿透业务 handler 并提前结束后台处理。修复：统一 `safeEnqueue` 捕获 enqueue 异常并停止推流；`cancel()` 置关闭标记并清理 60min SSE 超时；超时/停止/错误帧均走 safeEnqueue；后台执行继续，锁仍由 stream.start 的 finally 释放。新增 reader.cancel 后继续发事件不抛错/不中断后台、cancel 清理定时器回归；变异验证 cancel 分支删除后定时器测试精确红。全量 122 files / 1424 passed / 3 skipped。**下一批**：P2-07 拿锁前旧快照、P2-08/09。 |
| v29 | 2026-10-20 | **Round 2 复核：嵌套 `.env` 补漏（commit 61c7218）**。根因：`SENSITIVE_PREFIX` 只匹配相对路径开头，`secrets/.env` 被当作普通越界，审计仍 pass。修复：敏感模式增加任意目录层级 `(^|/)\.env(\..*)?$`；新增 `isSensitivePath`/`pickSensitive` 单元回归和真实临时 Git 的 `auditBatchChanges` violation 回归；变异验证移除模式后 3 条测试精确红。全量 122 files / 1426 passed / 3 skipped。**Round 2 仍未闭环**：F2 任意 user 消息当计划确认、F3 align_pm 真实 POST 不可达、F4 OpenCode managed 资源清理丢失、F5 并发 DELETE 清除 deleting 标记、F6 展示/批准/执行任务集不一致、R1 timeout 清理竞争、R2 needsPlan 分支取消复查不足；P1-03/P2-03/P2-04 不能整体标 ✅。**下一批**：P2-07 + F2/F3/F5。 |
| v30 | 2026-10-20 | **P2-07 拿锁后重读会话快照（commit d2fb158）**。根因：chat route 在 `acquireSessionLock` 前读取 session，排队等锁期间上一持有者可能修改 phase/phaseStep/decisionTrace、permissionMode 或 projectDir；拿锁后只复查取消/删除，后续仍用旧快照。修复：拿锁后重读 `currentSession`，null 回 404，重新检查取消/删除，并用新值派生 permissionMode/workDir、传最新阶段信息；新增权限/目录、phase/trace、等待中删除、等待中 stop 四条并发排队回归；变异验证移除重读后 3 条新测试精确红。全量 122 files / 1430 passed / 3 skipped。**下一批**：P2-04 F2/F3/F6/R2、P2-03 F5、P1-03 F4、P2-13 R1。 |
| v31 | 2026-10-20 | **P2-03 F5 + P2-04 F2/F3/F6/R2 闭环（commit 95e0755 / 351cdbe）**。F5：并发 DELETE 第二个直接 409，不再清首个删除者标记。F2：只有明确肯定文本写 system 批准记录 `[PLAN_APPROVED]plan-<id>`；拒绝/澄清/旧批准失效；记录不进 UI/模型上下文。F3：align_pm + 已有任务的真实 POST 走受约束恢复入口，缺计划只重呈，无任务仍拒绝。F6：plan ID、展示摘要、恢复/执行统一使用全任务集。R2：ensure 后与重呈阶段/消息副作用前补取消复查。变异验证逐项精确红；全量 123 files / 1444 passed / 3 skipped。**下一批**：P1-03 F4、P2-13 R1、P2-08/09、P2-10/11/12。 |
| v32 | 2026-10-20 | **done 恢复审批闭环（commit 52d66c9）**。根因：`ensureExecutableState` 在计划 gate 前对 idle/done 直接返回 ok，done + 已提交任务 + 未展示计划时，模型误提 execute 仍会执行。修复：idle 保持合法早退；done 先过 plan ID/展示/明确批准 gate，已批准后才恢复 execute；done 缺计划时回到 align_decompose 重呈并等待确认。新增服务级与真实路由回归，变异验证恢复 `idle||done` 早退后 2 条测试精确红；全量 123 files / 1446 passed / 3 skipped。**最新复核未闭环**：F11 `.ENV` 大小写、F8 问句批准、F9 恢复 phase 写入前取消窗口、F10 Q&A 分支保存明确批准。 |
| v33 | 2026-10-20 | **F11 `.ENV` 大小写闭环（commit 4a7efec）**。根因：`.env` 敏感模式大小写敏感；Windows 上 `.ENV` 与 `.env` 是同一文件，但 `.ENV` 被审计判为普通越界。修复：任意层级 `.env` 模式加 `i` 标志；补 `.ENV`/`.Env.Local` 与 `pickSensitive` 回归；变异验证移除 `i` 后测试精确红。全量 123 files / 1447 passed / 3 skipped。**下一批**：F8 问句批准、F9 恢复取消窗口、F10 Q&A 批准保存；随后 P1-03 F4、P2-13 R1、P2-08/09、P2-10/11/12。 |
| v34 | 2026-10-20 | **F8 问句批准闭环（commit 3bb12ad）**。根因：`isExplicitPlanApproval` 的 normalize 删除全角/ASCII 问号，`执行？` 变成 `执行` 并命中批准集合。修复：保留问号，问句不再命中；感叹号/句号等语气标点仍忽略。新增 `执行？`/`确认执行?` 拒绝与 `执行！` 通过回归；变异验证恢复问号剥离后测试精确红。全量 123 files / 1447 passed / 3 skipped。**下一批**：F9 恢复取消窗口、F10 Q&A 批准保存；随后 P1-03 F4、P2-13 R1、P2-08/09、P2-10/11/12。 |
| v35 | 2026-10-20 | **F9 恢复取消窗口闭环（commit 1af2112）**。根因：已批准恢复在查询计划/批准记录后直接写 align_decompose/execute，取消发生在查询期间时 phase 已推进，调用方之后才发现停止。修复：approval gate 后、align_pm→align_decompose 后各加取消复查；取消后不再写 execute。新增 approved plan + 查询期间取消、断言零 phase 写入回归；变异验证移除 gate 后复查后测试精确红。全量 123 files / 1448 passed / 3 skipped。**下一批**：F10 Q&A 批准保存；随后 P1-03 F4、P2-13 R1、P2-08/09、P2-10/11/12。 |
| v36 | 2026-10-20 | **F10 Q&A 批准保存闭环（commit 0412a39）**。根因：recordPlanApproval 只在 execute 分支调用；用户明确确认执行但模型路由到 align_qa 时不保存批准，QA 无问题后 transitionToExecution 仍要求再次确认。修复：align_qa 分支也记录明确批准；后续 user 消息仍会使旧批准失效。新增真实 route + handleAgentQA 无问题直接执行回归；变异验证移除 align_qa 记录后测试精确红。全量 123 files / 1449 passed / 3 skipped。**最新复核项全部闭环**。**下一批**：P1-03 F4、P2-13 R1、P2-08/09、P2-10/11/12。 |
| v37 | 2026-10-20 | **F4 OpenCode managed 资源最终清理闭环（commit d6ef4a0）**。根因：exit 发生在 send 仍 busy/working 时，exit handler 为 retry 保留 managed 资源并删除 registry entry；随后 stdout.close 正常完成，killEntryIfCurrent 因 entry 不在 registry 直接返回，md/XDG 失去最终清理者。修复：cleanupEntry 在 preserveManaged 时记录 managedCleanupPending；send 成功收尾用当前 entry 引用执行 finalizeManagedCleanup，再走 killEntryIfCurrent。新增 exit 先于 stdout.close 的正常 NDJSON 回归；变异验证移除 finalize 后测试精确红。全量 123 files / 1450 passed / 3 skipped。**下一批**：P2-13 R1、P2-08/09、P2-10/11/12。 |
| v38 | 2026-10-20 | **P2-13 R1 超时优先级闭环（commit 3fac531）**。根因：timer 回调先 await onTimeout 再 reject；清理期间底层 next(done) 先完成时 Promise.race 正常返回，吞掉 TimeoutError。修复：超时触发后只启动有界 onTimeout 后台清理并立即 reject TimeoutError；iterator.return 仍在 finally 有界收尾。新增 onTimeout 清理期间 next 完成回归；变异验证恢复 await cleanup 后测试精确红。全量 123 files / 1451 passed / 3 skipped。**下一批**：P2-08/09、P2-10/11/12。 |
| v39 | 2026-10-20 | **P2-08 Windows 进程树确认闭环（commit 9201e30）**。根因：Windows 终止只等待直接 ChildProcess exit；taskkill /T 启动后 unref，不能证明后代退出，父进程退出即可误报 confirmed。修复：terminateEntry 并发等待直接 exit 与 taskkill /T 子进程退出码；treeConfirmed 必须为 true，非 0/超时/error 走 force 或返回 unconfirmed。新增父进程已退出但 taskkill 树确认失败回归；变异验证移除 treeConfirmed 条件后测试精确红。全量 123 files / 1452 passed / 3 skipped。**下一批**：P2-09、P2-10/11/12、旧 P3。 |
| v40 | 2026-10-20 | **P2-09 Agent 创建取消窗口闭环（commit a73f2d7）**。根因：LLM 分析完成后直接 findUnique/create，stop/delete 在 LLM 或 DB await 期间到达仍继续创建 Agent/成员/消息。修复：入口、LLM 返回后检查取消；Agent+成员+消息同一事务，事务内每个写前复查并抛 SessionCancelledError；取消/失败回滚，不留下半个 Agent，也不再发成功 done。新增 LLM 返回后取消、Agent 创建期间取消两条回归；变异验证移除 LLM 后检查后测试精确红。全量 123 files / 1454 passed / 3 skipped。**下一批**：P2-10/11/12、旧 P3。 |
| v41 | 2026-10-20 | **P2-10 OpenCode 私聊只读提示闭环（commit a45921a）**。根因：群聊创建已有 OpenCode default 只读提示，私聊 ChatFab 无同等提示。修复：新增 OpencodeReadOnlyHint，按 selectedAgent.platform === opencode 在输入区显示只读提示与 /permission auto 切换说明；Agent 接口补 platform。新增 server-render 组件回归（opencode 显示、claude/未选择不显示）；变异验证移除平台门禁后测试精确红。全量 124 files / 1456 passed / 3 skipped。**下一批**：P2-11/12、旧 P3。 |
| v42 | 2026-10-20 | **P2-11 清扫 owner 护栏闭环（commit f889819）**。根因：sweep active 集合只有 DB Agent 行与本进程 ProcessRegistry，其他 AgentHub 实例正在使用的会话级 XDG 目录不可见，会被当孤儿删除。修复：OpenCode 创建 XDG 目录时写 .agenthub-owner.json（pid/updatedAt）；sweep 对非 active 目录检查 owner PID，其他实例存活则保留，owner 为本进程或已退出才清理。新增其他实例存活保留、死 owner 清理、owner 文件写入回归；变异验证删除 owner 检查后测试精确红。全量 124 files / 1458 passed / 3 skipped。**下一批**：P2-12、旧 P3。 |
| v43 | 2026-10-20 | **P2-12 事件 seq / SSE 轮询护栏闭环（commit 61f5b0d）**。根因：event-log 每个 logger 各自从 DB max 起算 seq，同 session 并发 logger 会分配相同 seq，唯一约束失败后被 catch 吞掉导致事件丢失；SSE setInterval 无 in-flight 护栏，慢查询超过 pollMs 时会与下一轮重叠。修复：新增进程内 per-session seq 分配器，并发 createEventLogger 共享一次 DB max 初始化与计数器；写入失败保留 poisoned 状态并显式告警，避免复用已流式发出的 seq；SSE 增加 polling guard，查询完成后检查 closed/abort 再发送。新增并发 seq、初始化降级、失败后不复用、慢查询不重叠回归；变异验证分别精确红。全量 126 files / 1462 passed / 3 skipped。**下一批**：旧 P3（跨实例 seq 原子性仍是残余）。 |
| v44 | 2026-10-21 | **Round 5 复核：P2-08 二次闭环（commit 1fd420e）；P1-03/P2-11/P2-12/P2-13 重开**。P2-08 根因：父进程 exit 时 registry entry 被无条件删除，taskkill /T 未确认的 unconfirmed 状态丢失；修复：cancelled entry 保留 registry、terminationUnconfirmed 持续到确认成功、cleanupIdle 跳过取消中/未确认 entry。Round 5 另行确认：P1-03 永久失败 managed 清理、P2-11 send/retry 资源引用、P2-12 跨 logger 写队列顺序、P2-13 同步清理前缀吞 TimeoutError 仍未闭环。全量 126 files / 1463 passed / 3 skipped。**下一批**：P2-13 → P1-03 → P2-11 → P2-12。 |
| v45 | 2026-10-21 | **P2-13 同步超时前缀闭环（commit cec556f）**。根因：timer 回调先同步执行 runCleanupBounded(onTimeout)，再 reject TimeoutError；清理回调同步 resolve 正在等待的 next(done) 时，next 微任务先入队赢得 race。修复：先 reject 超时结果，再启动有界清理；清理错误仍只 warn。新增同步 resolve next 回归；变异验证恢复清理先行后测试精确红。全量 126 files / 1464 passed / 3 skipped。**下一批**：P1-03 → P2-11 → P2-12。 |
| v46 | 2026-10-21 | **P1-03 终态 managed 清理闭环（commit 325d32d）**。根因：永久失败分支用 registry 重新查 entry；exit handler 已删除 entry 时拿不到原引用，managed md/XDG 的 managedCleanupPending 永远不 finalize。修复：send 保存 lastEntry，永久失败、取消、重试耗尽终态都用原 entry 引用 finalizeManagedCleanup；中间 retry 仍保留配置供重建。新增永久失败 exit→stdout.close 回归；变异验证移除 finalize 后测试精确红。全量 126 files / 1465 passed / 3 skipped。**下一批**：P2-11 → P2-12。 |
| v47 | 2026-10-21 | **P2-11 本进程 retry owner 保护闭环（commit 37473ef）**。根因：sweep 把 owner.pid === process.pid 判为可清理；working 进程 exit 后 send 进入 retry backoff，registry entry 已删除但 XDG 仍会被下一轮复用，正常 GET /api/agents sweep 会删掉它。修复：owner PID 存活（含本进程）一律保留；marker 损坏/不可读也保留；无 marker 的历史 agent-only 目录仍按旧规则清理。新增本进程 retry 目录与损坏 marker 回归；变异验证分别精确红。全量 126 files / 1467 passed / 3 skipped。**下一批**：P2-12。 |
| v48 | 2026-10-21 | **P2-12 per-session 共享写链闭环（commit 1de1fbc）**。根因：seq 计数器已按 session 共享，但每个 logger 仍有独立 writeChain；A 的 1、2 未落完时 B 的 3 可先落库，形成 1、3、2。SSE cursor 到 3 后 2 永远不补发。修复：writeChain 放入 SessionSeqState，所有 logger 按 seq 串行入队；flush 只等待调用时快照，超时仍保留 poisoned 状态。新增实际落库顺序与 SSE 补发 id 2 回归；变异验证恢复 per-logger 写链后两条测试精确红。全量 127 files / 1469 passed / 3 skipped。**P1/P2 全闭环；旧 P3 #19 同步闭环，剩 27 项**。 |
| v49 | 2026-10-21 | **P3 #6 permission requestId 归属校验闭环（commit 2339123）**。根因：permission route 只查 session 存在，respondPermissionByRequestId 只按 requestId 反查 entry；知道其他会话 requestId 时可跨会话批准/拒绝工具请求并提前消费映射。修复：方法增加 expectedOwnerSessionId，比较 entry.ownerSessionId 后才删除映射/唤醒 pending；错误 session 返回 false 且不消费；route 传入当前 sessionId。新增跨会话拒绝与正确会话仍可响应回归；变异验证移除归属检查后测试精确红。全量 127 files / 1470 passed / 3 skipped。**P3 #6/#19 闭环，剩 26 项**。 |
| v50 | 2026-10-21 | **P3 #8 files symlink 路径逃逸闭环（commit b24a6d7）**。根因：isPathSafe 对不存在目标只做 resolve+startsWith，父目录 symlink 可把 accept 新文件写到 workspace 外；download 只用 join+readFile，workspace 内文件 symlink 可读取外部文件。修复：isPathSafe 向上找最近存在祖先并 realpath，悬空 symlink fail-closed；accept 在 mkdir 后 writeFile 前复查；download 读取前 realpath 校验。新增父目录/悬空 symlink、accept 写入与 mkdir 后复查、download 读取回归；父目录、download、post-mkdir 三次变异均精确红。全量 127 files / 1477 passed / 3 skipped。**P3 #6/#8/#19 闭环，剩 25 项**。 |
| v51 | 2026-10-21 | **Round 6 三项补齐**：P2-08 并发取消/容量驱逐（`f873181`）、P2-11 owner 初始化发布窗口（`4092e99`）、P3 #8 固定 session 根 junction（`6e7ea3a`）。新增 terminationInFlight 共享、容量驱逐保护未确认记录、无 marker 24h 发布宽限期、owner 写失败 fail-fast、isPathRootSafe 固定根锚定。审计 Round 6 的 tree/sweep/path fixtures 全部转绿；变异验证各路径精确红。全量 129 files / 1486 passed / 3 skipped。**P1/P2 全闭环；P3 #6/#8/#19 闭环，剩 25 项**。 |
| v52 | 2026-10-21 | **P3 #9 attachments SVG inline 闭环（commit 9931fa8）**。根因：上传白名单允许 `image/svg+xml`，下载路由把所有 `image/*` 设为 inline 且无 nosniff；含 script 的 SVG 可同源执行。修复：规范化 MIME，SVG 强制 `Content-Disposition: attachment`，加 `X-Content-Type-Options: nosniff` 与 CSP `sandbox`；普通图片仍 inline。新增 SVG/PNG 回归；改回 inline 后测试精确红。全量 130 files / 1488 passed / 3 skipped。**P3 #6/#8/#9/#19 闭环，剩 24 项**。 |
| v53 | 2026-10-21 | **P3 #10 临时配置清理闭环（commit 4e869a9）**。MCP 临时文件 0o600，写入/spawn 失败立即 unlink；OpenCode owner 写失败删除新建目录；send 在 registry 建 entry 前失败时清理 XDG 与 agent 文件。Windows ACL 仍依赖 `%TEMP%`/profile ACL（§5 已接受残余）。新增三条回归；去掉对应清理分别精确红。全量 131 files / 1490 passed / 3 skipped。**P3 #6/#8/#9/#10/#19 闭环，剩 23 项**。 |


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
   **正确修法**：保持 `shell:true`，收敛可注入面——prompt 已走 stdin（`promptAsArg` 全仓无人设为 true，已核实），命令行上只剩 `--dir`(workDir) / `--model` / `--tools` / `--allowedTools` / `--disallowedTools` / `--settings` 等字段：对它们做校验/转义，或用 `cmd.exe /d /s /c` 显式包裹并严格引号。注意 Node 的 DEP0190 警告（shell:true + args 数组 = 仅拼接不转义）证实了这个方向。
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

### 3.3 执行中断恢复语义 ✅ 2026-09-21 完成

- ✅ **启动 reconcile**（reconcile.ts + instrumentation 接线）：in_progress 任务条件写置 pending（§3.2 纪律）+ SessionMember.working 无条件清扫（审查 F1：对齐期崩溃/GET 恢复后等场景成员残留不伴随任务残留）+ 按会话汇总留痕。审查者读 Next 16.2.6 dist 源码实证：首个 HTTP 请求阻塞至 register 完成——启动竞态窗口结构性闭合。
- ✅ **与 GET stuck reset 的关系（评估拍板）**：启动收敛=主动无条件（单实例启动时刻必无活跃流）；运行中收敛=被动 5min 阈值+心跳保护。二者互补，周期 reconcile tick **不做**（单实例已闭环，常驻 tick 无对应场景）。
- ✅ **半成品清理不做（拍板）**：AgentHub 无每任务 git 边界（codeg 依赖其 landed commit 结构），无法可靠区分半成品与有效产出；恢复语义=置 pending 重跑、由 agent 覆盖产出。phase 留 execution 不动（ISSUE-011 F2 有意设计）。
- ✅ §3.1 衔接：恢复后续跑走 handleExecution→eventLogger 落库→前端 EventSource 补发（已有机制零改动）。

### 3.4 monitoring 结构化（兼研究变量）✅ 2026-09-21 完成（preflight 命令红绿灯除外）

- ✅ **信号层纯函数**（structured-monitor.ts）：S1 git-truth 完成性（declaredFiles 非空 + batch diff 非空 + 声明∩变更=空 → 声称完成但无产出；防御：diff 空=快照链路故障弃权）+ S2 outputSchema 校验（复用 validateAgainstSchema，no-schema 不参与）。
- ✅ **门控接线**：`EXPERIMENT_STRUCTURED_MONITOR=on`（严格相等，对齐 seqgate 先例）→ 结构化 correction 直接触发纠偏（LLM 不跑，降级第二道）、verdict=pass → LLM 照跑（漏检率数据）；未设（生产默认）→ LLM 路径照旧 + 信号命中记 Task.trace event:'monitor'（反事实对比数据）。纠偏路径统一 applyCorrection 助手（两臂同语义同遏制）。**【2026-09-27 转正更新】**生产默认已反转为未设=on、显式 'off'=转正前行为（见 §6 转正记录与 v12）。
- ✅ **A/B 埋点装置就位**：两臂信号均入 trace，纠偏触发率/重合度/漏检率可从 Task.trace 聚合——**实验本身待跑**（三梯队第 1 项 harness 消费）。
- ⏸ **preflight 命令红绿灯不做**：LLM 输出进命令=RCE 面（spawn 注入同族）+ 需 schema 变更（verifyCommands 来源拍板）——需单独安全设计后再排期。
- 审查实证并修复回归：monitor 埋点曾以过期内存 trace 为基串覆盖 DB 丢 success 事件（B2 后内存未同步）——基串改 successTrace + 同步补齐。

**阶段验收**：断线不丢流（完整重放，含四类过程事件）✓、中断可恢复 ✓、重复执行结构性不可能 ✓（§3.2 B1 互斥闸门）、monitoring 有结构化层 ✓ + A/B 数据（装置就位、实验待跑）；每项先证明会红 ✓（基线红测试 22 用例 + 变异精确红 8 组：§3.2 四组/§3.4 两组/§3.3 两组）。

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
- 实验开关留在生产热路径：现状 `applyTransitionWithOverride` / `isExperimentOff` / `idlePrematureDoneGate` 的调用点在 `chat-router.ts`（`:94/:121/:160`，`:9` 为 import 行；已核实）；v9 起 `isStructuredMonitorOn` 的调用点在 `execution.ts` 监控块（§3.4，同族）；v10 起 `isPreflightVerifyOn` 同在 `execution.ts`（S3 preflight 块，同族）——seqgate/structured-monitor/preflight 转正时移出。**加硬时限：转正条件（可分析会话 ≥20 且命中 ≥5；structured-monitor 为 A/B 实验完成且结论落档；preflight 为采数据支持升级语义拍板）若 3 个月内未满足，也强制移出**，避免"两套机制并存期过长"无人触发。（v11 更新 2026-09-26：structured-monitor 的 A/B 实验已完成且报告落档——结构化对 S1/S2 零漏检零误报 vs LLM 臂 9/13 + G 零检出，转正/移出拍板待用户；preflight 采数据继续。）
- **【转正记录 2026-09-27】structured-monitor 已转正**（用户拍板）：**生产默认反转为未设=on**（结构化先行 + LLM 第二道），显式 'off' = 逃生门 + p5 on-llmmon 对照臂复现转正前行为。**形态拍板**：反转保留开关而非字面删除——"移出"的实质是终结实验姿态悬置，开关剩余两个正当住户（回滚路径 + 对照臂硬需求），字面删除收益为零、代价是破坏装置。依据：report.monitor-2026-09-26/27（S1/S2 40/40 cycle 零漏检、30 run 基线零误报、合并 McNemar E p_exact=0.0625）。**本开关的 3 个月硬时限随之出清**；seqgate/preflight 条款不变。配套：work projectDir git init 隔离（审查者越权代工修复，run-one.ts initWorkGit）。

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
| 3 | 实验开关移出 | 与 seqgate 转正绑定 + 3 个月硬时限（§6）；structured-monitor 已转正出清（2026-09-27），剩余 seqgate/preflight |
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
| 单测 1490 passed / 3 skipped（2026-10-21；2026-09-21 §3.1 后为 1175，v6 1154、v4 1137、初版 1098） | `npx vitest run` | 实跑 |
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
