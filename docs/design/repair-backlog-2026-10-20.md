# AgentHub 修复待办总表（2026-10-20）

> 状态：**active**（压缩上下文后的唯一待办权威清单）
> 代码 HEAD：`4a7efec`；文档：本清单所在提交（见 `git log`）
> 回归基线：`123 files / 1447 passed / 3 skipped`，`next build` 通过，改动文件 eslint 0 error
> 工作区：clean；未 push
> 来源：① 原始 36 项审查；② 2026-10-20《AgentHub 已修部分质量复核》；③ 2026-10-20 Round 2 复核；④ 当前代码复核

本文只记录**尚未闭环**的事项。已完成且不应回退的基线见 §1；P1-01 的嵌套 `.env` 与 Windows `.ENV` 大小写均已补齐；P2-06/P2-07 保留完成记录；P2-03 F5 由 `95e0755` 补齐；P2-04 F2/F3/F6/R2 由 `351cdbe` 补齐，done 恢复由 `52d66c9` 补齐，但问句批准、取消窗口、Q&A 批准保存仍未闭环；P1-03 F4 与 P2-13 R1 仍未闭环（见 §2.1）；旧 36 项中已修/部分修的映射见 §4。

---

## 0. 使用规则

1. 一次只做一个最小项；先写失败测试，再改代码，做完停车给 diff/测试/全量回归。
2. 每项必须做一次“回退修复 → 测试精确红 → 还原”的变异验证。
3. 全量跑 `npx vitest run`、`npx next build`、改动文件 `npx eslint`。
4. 不修改历史 migration；数据库变更走 `npx prisma db push`，且先征得用户同意。
5. 不 push、不合并，除非用户明确要求。
6. 不恢复 `--bare`、`OPENCODE_CONFIG`、`OPENCODE_PERMISSION`、`--permission-mode auto`。
7. 不把“低层 helper 测试通过”当作完整调用链验收；恢复、取消、stop/delete 等必须补路由级/集成测试。

---

## 1. 已修基线（不要重做）

| commit | 已确认能力 | 关键不变量 |
|---|---|---|
| `b6b2deb` | 会话锁 FIFO waiter 队列 + chat 统一释放 | 等待者超时/abort 移除自身；release 幂等；持有者 abort 不直接放锁 |
| `c5930d3` | 取消全链路 + 进程真实退出 + 有界清理 | `cancellation.ts` 单一取消源；`ownerSessionId` 归属；stop/delete 等真实退出；onTimeout/flush 有界 |
| `55d5012` | 执行恢复 + 任务/verify 单事务 | `transitionPhase` 关键路径检查；事务失败不推进 phase、不发 plan/done |
| `e75339d` | 批次审计三态 + 批次级归责 + 共享目录停止自动删除 | `pass/violation/unavailable`；审计失败不发布 success；普通越界只告警；敏感越界整批失败 |
| `4774de6` | 双维度权限模型 + CLI 探针 | Claude `--tools` 可用性 + default 审批；OpenCode agent frontmatter tools/permission；default 只读 |
| `ca020b8` | OpenCode 配置清扫前缀 hotfix | active 集合按完整目录名比较，不再误删活跃目录 |
| `be969e0` | 任务结果发布门禁 | completed CAS 成功后才写 `allResults`；纠偏退回 pending 删除旧结果 |
| `0dd751a` | 审计内容证据 | `GitEvidence` 按内容 hash + key 存在性比较；覆盖已脏同路径再改、忽略 `.env`、删除；失败仍 `unavailable` |
| `ce2703b` | 忽略目录 `.env` 补漏 | pathspec glob 枚举 `**/.env*`，覆盖被 `--directory` 折叠的忽略目录 |
| `a5e6991` | 主批次工具白名单 | 批次映射保留 `tools`；两条入口共用 `parseAgentTools`，非空透传 `allowedTools` |
| `ae39e00` | OpenCode 会话隔离 | 文件名/XDG 加 chatSessionId+权限/配置指纹+实例 nonce；退出/取消清理，retry 保留，sweep 保护活跃目录 |
| `a24ca60` | Claude MDS 隔离 | `CLAUDE_CODE_DISABLE_CLAUDE_MDS=1` 与 provider 分支解耦，所有 spawn 注入 |
| `ff53430` | timeout return 有界 | `iterator.return` 走 `runCleanupBounded`；return 挂起/抛错不覆盖 `TimeoutError` |
| `74bda96` | regenerate 取消安全 | regenerate 传 `chatSessionId`/`workDir`；返回后复查取消，不写回、不发成功 done |
| `31c5946` | stop/delete 生命周期屏障 | `session-lifecycle` deleting 标记；DELETE 取消前 mark、删库后清，失败 finally 清；stop 对 deleting 不清取消；chat 拿锁前后拒绝 |
| `6292cdd` | 恢复计划审批关联 | 计划消息写任务集 plan ID；恢复要求计划已呈现且之后有用户消息；缺失时重展示到 align_arch，不自动执行 |
| `7520866` | SSE body cancel 安全 | safeEnqueue 捕获推流异常；ReadableStream cancel 置关闭标记并清超时；后台执行与锁释放不变 |
| `61c7218` | 嵌套 `.env` 敏感分类 | 任意目录层级 `.env`/`.env.*` 命中敏感规则；真实影 Git 审计返回 violation |
| `d2fb158` | 拿锁后重读会话快照 | 排队请求使用锁内最新 phase/phaseStep/decisionTrace/permissionMode/projectDir/type；重读 null 回 404 |
| `95e0755` | 并发 DELETE 所有权 | 已 deleting 时第二个 DELETE 直接 409，不 mark、不在 finally 清首个删除者的标记 |
| `351cdbe` | 计划批准绑定 plan ID | 明确肯定文本写 system 审批记录；拒绝/澄清失效；align_pm 真实恢复；全任务展示集一致；取消复查 |
| `ec756f0` | 文档同步 | 本清单、PROGRESS、roadmap v19、handoff |

**额外已确认但不要误改：**

- Claude 禁止 `--bare`（实测只暴露 Bash/Edit/Read 且忽略 `--tools`）。
- Claude CLI 始终 `--permission-mode default`；auto 由 ProcessRegistry 的 `entry.permissionMode === 'auto'` 分支 allow。
- OpenCode v2.0.27 的 `OPENCODE_CONFIG` / `OPENCODE_PERMISSION` 不生效；权限只信 agent md frontmatter。
- OpenCode headless `ask` 会被 CLI 自动拒绝；default = 只读，auto 才允许写/执行。
- `Bash` 同时映射 OpenCode `bash` 与 `execute`。
- `.env` 读取审批必须保留，不能因权限重构退化成 `read: allow`。
- phase 写入只能经 `transitionPhase`；Task 状态写带 status 前置条件。
- Contract v1 的 `task.result` / `declaredFiles` / `outputSchema` 语义继续有效。

---

## 2. P1（P1-01/02 已闭环；P1-03 核心隔离已完成，F4 资源清理尾项未闭环）

### ✅ P1-01 审计内容证据：已脏路径再次修改 / 被忽略的 .env 会漏检

**状态：** ✅ 已修（commit `0dd751a` + `ce2703b` + `61c7218` + `4a7efec`，2026-10-20）。Round 2 F1：嵌套 `secrets/.env` 原先未被判敏感，导致审计 pass；`61c7218` 已补任意层级 `.env`/`.env.*` 模式并加真实影 Git 审计回归。F11：Windows 上 `.ENV` 与 `.env` 是同一文件，`4a7efec` 给该模式加大小写不敏感标志，并补 `.ENV`/`.Env.Local` 回归。
**旧编号：** 原 36 项 #2（原“部分修”，现已闭环）
**位置：**
- `src/lib/services/shadow-git.ts:111` `getGitSnapshotDetailed`
- `src/lib/services/shadow-git.ts:116` `git diff --name-only HEAD`
- `src/lib/services/shadow-git.ts:119` `ls-files --others --exclude-standard`
- `src/lib/services/shadow-git.ts:141` `getChangedFilesDetailed`
- `src/lib/services/execution.ts:522` `auditBatchChanges`

**现状：**
快照仍是“路径 Set”，结束时只取 `after - before`：

```ts
return { ok: true, files: [...snapshot.files].filter(f => !before.has(f)) }
```

**已复现的漏检：**
1. `package.json` 在批次开始前已脏；本批再次修改同一路径，结束差集为空。
2. `.env` 被 `.gitignore` 忽略，不进 initial `git add`，也不进 `ls-files --others --exclude-standard`；修改后仍返回空。
3. 已跟踪文件被删除、或路径内容变化但路径不变，同样可能漏检。

两者都会让 `auditBatchChanges` 返回 `pass`，继续发布 result/completed。

**根因：**
审计只比较“脏路径集合”，没有保存批次开始/结束的内容证据；忽略文件不在 Git 的未跟踪列表里。

**最小修法：**
- 新增按内容的证据快照（建议 `getGitEvidenceDetailed`）：
  - 记录 `{ exists, hash, kind }`，覆盖：
    - tracked dirty 路径；
    - untracked 非忽略路径；
    - 被忽略的敏感文件（至少 `.env` / `.env.*`，用 `ls-files --others --ignored --exclude-standard` 过滤或文件系统扫描）。
  - 批次开始保存 before evidence；结束时对 `before ∪ after` 的并集重算，按 hash/存在性比较，而不是按路径差集。
  - 证据读取失败必须返回 `{ok:false, reason}`，不得降级为空集合。
- 删除/重命名要能被识别为变化；被忽略的 `.env` 读取失败应 `unavailable`。
- 保持现有 `getGitSnapshotDetailed` 兼容，或让审计切换到新 API；不要只改名字不改语义。

**必须新增测试（真实临时 Git 仓库）：**
1. 已脏 `package.json` → 批次中再次修改 → 变化必须包含它。
2. 已忽略 `.env` → 批次中修改 → 变化必须包含它。
3. 已跟踪文件删除 → 变化必须包含它。
4. Git/证据读取失败 → `unavailable`，不得 `pass`。
5. 正常未变化路径 → 不误报。

**验收：**
`auditBatchChanges` 对以上场景不再 `pass`；失败仍走批次 failed，不发布 result/completed。

---

### ✅ P1-02 主批次执行入口丢失 Agent 工具白名单

**状态：** ✅ 已修（commit `a5e6991`，2026-10-20）。保留本节作为验收记录；P1-03 已随后修复（`ae39e00`）。
**旧编号：** 审查报告 P1 #3
**位置：**
- `src/lib/services/execution.ts:433` 批次 agent 映射
- `src/lib/orchestrator/index.ts:365` `executeTaskBatch` agent 类型
- `src/lib/orchestrator/index.ts:443` `adapter.connect`
- `src/lib/orchestrator/index.ts` 的 `executeSingleAgent`（已解析 tools，可复用）

**现状：**
`executeSingleAgent` 会把 `agent.tools` 解析成 `allowedTools`；但主批次 `executeTaskBatch` 的 agent 映射没有 `tools` 字段，`connect` 收到 `allowedTools = undefined`。

**后果：**
- Claude：`--tools default`，Agent 配置只有 `Read` 也会暴露全部工具。
- OpenCode：失去 tools 边界，auto 下还会自动批准更多工具。
- 这是 4774de6 声称的硬工具边界在主执行路径上的缺口。

**最小修法：**
- 在 `execution.ts` 的批次 agent 映射中加入 `tools`（保留原始 JSON 字符串或解析后的数组，选一种全链一致的类型）。
- `orchestrator/index.ts` 的 agent 类型与 `connect` 统一解析/透传 `allowedTools`。
- `executeTaskBatch` 与 `executeSingleAgent` 共用同一个 `parseAgentTools` 纯函数，避免两套语义。
- 明确空列表语义：空 = 不限制（当前 Claude `--tools default` / OpenCode 不写 tools），不要意外变成“全部 deny”。

**必须新增测试：**
1. 批次 Agent 配置 `tools: ["Read"]` → adapter.connect 收到 `allowedTools: ["Read"]`。
2. 单 Agent 路径同样收到 `["Read"]`（防止只修一条入口）。
3. 空/缺失 tools → 保持既有“不限制”语义。
4. auto 模式下 `--allowedTools` 不得因透传修复被扩大。

**验收：**
两条执行入口在 connect 边界的 `allowedTools` 一致，且不改变 default/auto 审批语义。

---

### ⚠️ P1-03 OpenCode 不同会话覆盖同一权限文件（核心隔离已修；F4 资源清理未闭环）

**状态：** 核心隔离 ✅ 已修（commit `ae39e00`，2026-10-20）；但 Round 2 F4 发现正常 `exit → stdout.close` 顺序下，生成的 md/XDG 清理被跳过，P1-03 尚不能整体闭环。详见 §2.1 F4。P2-05 已由 `a24ca60` 修复。
**旧编号：** 原 36 项 #13（原“未修”，现已闭环）；审查报告 P1 #4
**位置：**
- `src/lib/adapter/opencode-adapter.ts:149` `ensureAgentConfig`
- `src/lib/adapter/opencode-adapter.ts:153` agent md 文件名
- `src/lib/adapter/opencode-adapter.ts:215` XDG 配置目录
- `src/lib/adapter/opencode-adapter.ts:270` `--agent` 引用
- `src/lib/adapter/opencode-adapter.ts:285` `--auto`

**现状：**
agent 文件名只含 `projectDir + agentId`，XDG 目录只含 `agentId`：

```ts
const agentFile = join(agentDir, `agenthub-${sanitizeOpencodeAgentId(this.agentId)}.md`)
const configDir = join(tmpdir(), opencodeCfgDirName(this.agentId || 'default'))
```

同一目录、同一 Agent 的 default 会话与 auto 会话写同一个文件；B 会话会把 A 会话的 `deny`/`ask` 覆盖成 `allow`。进程 key 含会话，不代表配置文件隔离。

**最小修法：**
- 生成文件名与 XDG 目录名加入隔离键：至少 `chatSessionId`；建议再加 `permissionMode` 与配置指纹（tools/model/baseUrl 的 hash）。
- `--agent` 引用使用同一个隔离后的名字。
- 明确生命周期：进程退出/会话删除时清理对应 agent 文件与 XDG 目录；sweep 只清无运行引用的孤儿。
- systemPrompt 若按 Agent 共享，需确认是否也要按会话隔离；至少权限/tools 不得共享。

**必须新增测试：**
1. 两个 adapter、同一隔离 workDir、同一 agentId，一个 default/Read，一个 auto/Read+Bash；生成两个不同文件，default 文件中的 `bash/execute` 仍为 deny/ask，auto 不覆盖它。
2. `--agent` 参数与生成文件名一致。
3. 会话结束/进程退出后清理不会误删另一个会话的文件。

**验收：**
两个并发会话的权限文件互不覆盖；真实 CLI 加载哪一版可预测。

**Round 2 F4 遗留：** `ProcessRegistry` 在 exit 时先 `cleanupEntry(entry, true)`（保留 managed 资源以便 retry）并从 registry 删除 entry；随后 NDJSON 收到 stdout close 正常完成，`killEntryIfCurrent` 因 entry 已不在 registry 直接返回，最终无人删除 `managedAgentFile`/`managedConfigDir`。修复方向：拆分进程级清理与 managed 资源释放，明确 retry 持有者与最终成功/永久失败/取消的最终 owner，覆盖 exit/close 两种顺序。

---

## 2.1 Round 2 复核遗留（2026-10-20）

Round 2 报告与复现：`<home>\.codex\visualizations\2026\10\20\01a157b9-2549-7321-a5a8-9a46eeb05ea4\agenthub-repair-quality-review-round2.md`。

| ID | 严重度 | 状态 | 位置 | 未闭环问题 |
|---|---|---|---|---|
| F1 | P1 | ✅ 已闭环 `61c7218` | `sensitive-paths.ts:27` | 嵌套 `secrets/.env` 未判敏感，审计 pass；已补任意层级 `.env`/`.env.*` |
| F2 | P2 | ✅ 已闭环 `351cdbe` | `alignment.ts:627`、`chat-router.ts:273` | 明确肯定文本写 system 批准记录并绑定 plan ID；拒绝/澄清/旧批准失效；gate 要求记录在计划后、所有 user 之后 |
| F3 | P2 | ✅ 已闭环 `351cdbe` | `alignment.ts:458`、`:752`、`chat-router.ts:231` | align_pm + 已有任务的真实 POST 走受约束恢复入口；缺计划/未批准只重呈，无任务仍拒绝 |
| F4 | P2 | 🔴 未闭环 | `process-registry.ts:438`、`:552`、`:1390` | 正常 exit→stdout.close 顺序下，OpenCode 生成的 md/XDG 最终清理丢失 |
| F5 | P2 | ✅ 已闭环 `95e0755` | `session-lifecycle.ts:12`、`sessions/[id]/route.ts:143`、`stop/route.ts:36` | 并发 DELETE 共用无 owner 的 Set；已改为第二个 DELETE 直接 409，首个删除者独占 finally |
| F6 | P2 | ✅ 已闭环 `351cdbe` | `alignment.ts:444`、`:471`、`:737` | plan ID、展示摘要、恢复/执行统一使用 session 全任务集；旧 pending/blocked 任务也展示 |
| R1 | P2 | 🔴 未闭环 | `timeout.ts:73`、`:99` | `onTimeout` 清理期间底层 `next` 先完成时，可能吞掉 `TimeoutError`；与已修的 `iterator.return` 有界性独立 |
| R2 | P2 | ✅ 已闭环 `351cdbe` | `alignment.ts` needsPlan 分支 | ensure 等待后、重呈 helper 的 phase/消息副作用前均补取消复查 |
| F7 | P1 | ✅ 已闭环 `52d66c9` | `alignment.ts:725` | done + 已提交任务 + 计划未展示时，ensure 在计划 gate 前直接返回 ok，拒绝消息也会进入执行；已改为 done 先过计划 gate |
| F8 | P2 | 🔴 未闭环 | `alignment.ts:80` | `执行？` 的问号被 normalize 删除，命中批准集合；应保留问号并拒绝 |
| F9 | P2 | 🔴 未闭环 | `alignment.ts:746` | 已批准恢复在查询后先写 align_decompose/execute，期间取消要到调用方才发现；phase 写入前缺取消复查 |
| F10 | P2 | 🔴 未闭环 | `chat-router.ts` align_qa 分支 | 明确“确认执行”被路由到 Q&A 时不保存批准；QA 无问题后仍要求再次确认（保守拒绝，非越权） |
| F11 | P1 | ✅ 已闭环 `4a7efec` | `sensitive-paths.ts:41` | Windows `.ENV` 与 `.env` 同一文件；已给 `.env` 模式加 `i` 标志并补回归 |

> F4 属于 P1-03 的资源生命周期；F8/F9/F10 是最新一轮复核项；P2-04 在 F8/F9/F10 修完前不能整体标 ✅。P1-01 与 P2-03 F5 已闭环。

---

## 3. P2 待修

### ✅ P2-01 `iterator.return()` 无上限，超时可能仍不兑现

**状态：** ✅ 已修（commit `ff53430`，2026-10-20）。`iterator.return` 与 onTimeout 共用有界 cleanup；P2-02 随后修复（`74bda96`）。
**位置：** `src/lib/orchestrator/timeout.ts:86-90`
**现状：** `onTimeout` 已用 `runCleanupBounded` 包住，但 `finally` 中 `await iterator.return?.()` 仍无上限。真实 async generator 卡在永不完成的 `await/next` 时，`return()` 排队，调用方可能永远收不到 `TimeoutError`，继续占会话锁。
**最小修法：**
- `iterator.return()` 也走 `runCleanupBounded`（建议同一 `cleanupTimeoutMs`）。
- 超时后调用方必须先收到 `TimeoutError`；底层 generator 的迟到写入需要 generation/abort 标记防护，不能靠 `return()` 一定成功。
- 不要删除现有 `onTimeout` 上限逻辑。
**测试：** 非合作 async generator（`next()` 永不 resolve）+ 受控时钟；超时后 promise 必须在有界时间内 settle，且 cleanup 超时只 warn。
**注意：** 如果现有接口无法取消非合作 generator，明确记录“wrapper 有界返回，底层工作可能仍在运行”，并用取消标记阻止其迟到写。

### ✅ P2-02 regenerate 漏传 chatSessionId，stop 找不到进程

**状态：** ✅ 已修（commit `74bda96`，2026-10-20）。regenerate 传会话归属并在发布前复查取消；P2-03 后续由 `31c5946` 闭环。
**位置：** `src/app/api/sessions/[id]/chat/route.ts:163`
**现状：** regenerate 调 `executeSingleAgent` 时 `chatSessionId` 仍为 `undefined`；`ProcessEntry.ownerSessionId` 为空，`cancelByOwnerSession` 选不中该进程。返回后也没有取消复查就更新原消息/发 done。
**最小修法：**
- 传当前 `sessionId` 作为 `chatSessionId`。
- 在写回原消息、发 done 之前检查 `isSessionCancelled(sessionId)`；取消则不发布。
- 与 stop/delete 的进程归属测试联动。
**测试：** regenerate 期间 stop → `ownerSessionId` 能命中；取消后不得更新消息/发 done。

### ✅ P2-03 stop 与 DELETE 的取消屏障竞态（F5 已闭环）

**状态：** 单 DELETE 由 `31c5946` 修复；Round 2 F5 由 `95e0755` 闭环：同一 session 已有 deleting 时第二个 DELETE 直接 409，不 mark、不进入 finally，因此不会清掉首个删除者的标记；stop 在首个删除完成前仍返回 202 并保留取消。详情见 `docs/design/handoff-2026-10-20-p2-03.md`。

### ⚠️ P2-04 执行恢复没有“同一获批计划”关联（F2/F3/F6/R2/F7 已闭环；F8/F9/F10 未闭环）

**状态：** 基础机制由 `6292cdd` 落地；Round 2 补项由 `351cdbe` 闭环；done 恢复绕过由 `52d66c9` 闭环。**最新复核仍有 F8（问句算批准）、F9（恢复 phase 写入前取消窗口）、F10（Q&A 分支不保存明确批准）**，P2-04 暂不能整体标 ✅。
- F2：只有明确肯定文本（如“确认执行”）写 `[PLAN_APPROVED]plan-<id>` system 记录；拒绝/澄清/普通消息不写；gate 要求记录在计划之后且在所有 user 消息之后，旧批准会被后续拒绝作废。
- F3：任务已提交且 phase=`align_pm` 时，真实 POST execute 走受约束恢复入口；缺计划/未批准只重呈计划，无任务仍按非法转移拒绝。
- F6：plan ID、计划展示摘要、恢复/执行统一使用 session 全任务集，旧 pending/blocked 任务也会展示。
- R2：ensure 等待后、重呈 helper 的 phase/消息副作用前均补取消复查。
- system 审批记录不回聊天 UI、不进模型上下文；服务端 gate 直接查 DB。

**已知残余：** plan ID 仍只 hash 任务 ID；同一 ID 的 description/dependencies/declaredFiles 内容变化不会自动使旧批准失效（Round 2 报告列为进一步版本关联风险，未在本项扩 scope）。多实例/跨进程的审批记录一致性也不在 P2-04；P2-03 F5 的 deleting 所有权仍是进程内语义。

### ✅ P2-05 Claude 无 provider 配置时未注入项目指令隔离开关

**状态：** ✅ 已修（commit `a24ca60`，2026-10-20）。MDS 开关与 provider 分支解耦，所有 Claude spawn 注入；P2-01 已随后修复（`ff53430`）。
**位置：** `src/lib/adapter/claude-code-adapter.ts:115`
**现状：** `CLAUDE_CODE_DISABLE_CLAUDE_MDS=1` 只在 `ensureClaudeConfigDir` 返回非空时注入；使用已有登录认证、缺 baseUrl/apiKey 的路径跳过该分支，`--bare` 移除后 workDir 的 CLAUDE.md 自动发现可能未被隔离。
**最小修法：** 把 `CLAUDE_CODE_DISABLE_CLAUDE_MDS=1` 与 provider 凭据分支分离，所有 Claude spawn 都注入；保留 `CLAUDE_CONFIG_DIR`/`--settings` 仅在凭据存在时使用。
**测试：** 无 baseUrl/apiKey 的 adapter 到 registry config 边界仍含该 env。

### P2-06 HTTP body cancel 未保护 enqueue ✅

**状态：** ✅ 已闭环（commit `7520866`，2026-10-20）。统一 `safeEnqueue` 捕获 enqueue 异常并停止推流；`ReadableStream.cancel()` 置 `streamClosed` 并清理 60min 超时；后台执行继续，锁仍由 `stream.start` 的 finally 释放。新增 body cancel 后继续发事件、cancel 清理定时器回归。

### ✅ P2-07 拿锁前读取的会话快照可能过期

**状态：** ✅ 已闭环（commit `d2fb158`，2026-10-20）。拿锁后重新读取 `currentSession`；null 回 404；重新检查取消/删除；用新快照派生 `permissionMode`/`workDir`，并把最新 `phase/phaseStep/decisionTrace/type` 用于后续分支。新增权限/目录、phase/trace、等待中删除、等待中 stop 四条并发排队回归；变异验证移除重读后 3 条新测试精确红。
**位置：** `src/app/api/sessions/[id]/chat/route.ts:29`
**原现状：** 拿锁前读取 session 的 phase/permissionMode/projectDir；排队等锁期间可能被其他请求修改，拿锁后只检查取消，没有重读。
**测试：** 请求 A 持锁并改 permission/phase；请求 B 排队后拿到锁，使用新值。

### P2-08 Windows 进程树退出确认不足

**位置：** `src/lib/adapter/process-registry.ts:1261`
**现状：** `taskkill` 启动后 `unref`，退出等待只观察直接 `ChildProcess`；不能证明所有后代退出。当前停止/删除的“真实退出”承诺对进程树不完整。
**最小修法：** 使用 `taskkill /T` 并验证进程树（或 Job Object）；无法确认后代退出时返回 `unconfirmed`，不要假报成功。
**测试：** 真实/模拟父子进程；父退出但子存活时不得报 confirmed。若无法稳定集成测试，至少记录证据限制，不要宣称整树退出。

### P2-09 Agent 创建取消窗口

**位置：** `src/lib/services/agent-factory.ts:26`
**现状：** 分析完成后的 DB await 之后缺少取消复查；取消请求到达后仍可能继续创建 Agent/成员/消息。stop 会等待锁，但没有证据表明这些写入一定晚于 stop 成功响应。
**最小修法：** 每个 DB 写前/写后检查 `isSessionCancelled`；已创建的部分要么不提交（事务），要么在取消时清理/标记。
**测试：** 分析完成后取消 → 不创建 Agent/成员/消息，或全部回滚。

### P2-10 OpenCode 只读提示只覆盖群聊创建

**位置：** `src/components/chat-fab.tsx`（私聊路径）
**现状：** 群聊创建 UI 有 default 只读提示；私聊 ChatFab 仍默认 default，没有同等提示。
**最小修法：** 私聊也展示“default 只读，需写操作请切 auto”的提示；不要改默认策略。
**测试：** UI 文案快照/组件测试或人工验收记录。

### P2-11 配置清扫 owner/实例/运行引用护栏

**位置：** `src/lib/services/claude-cfg-maintenance.ts`
**现状：** `ca020b8` 只修了目录名前缀比较。active 集合仍基于 Agent 行，不包含运行中进程的实际 owner/实例引用；多实例/并发 sweep 仍可能删掉另一实例正在用的目录。
**最小修法：**
- active 集合并入 ProcessRegistry 的运行 owner（或写实例租约文件/心跳）。
- sweep 只清“无 DB active + 无运行引用 + 无实例租约”的目录。
- 加多实例/并发 sweep 测试；失败时宁可不删。

### P2-12 事件 seq 不可变 + 单 logger + SSE 轮询重叠

**位置：** `src/lib/services/event-log.ts:69`、`:109`；`src/app/api/sessions/[id]/events/route.ts:93`
**现状：**
- seq 起点从 DB max 恢复，每个 logger 自己 `++seq`；并发 logger 冲突时 `agentProcessEvent.create` 失败被 catch 吞掉，事件丢失。
- SSE 的 `setInterval(async () => ...)` 没有 in-flight 保护；查询超过 poll 间隔时会重叠，可能重复发送/游标竞争。
- 已有：持久化、重放、前端 seq 去重、flush 5s 上限。
**最小修法：**
- 同一 session 只允许一个 logger 负责 seq 分配；或把 seq 分配放到 DB 原子序列/事务。
- 冲突不得通过重读 max+1 改号破坏已发帧身份；失败要显式记录/告警，不能静默丢。
- SSE 轮询加 `inFlight` 守卫，上一轮未完成不启动下一轮。
**测试：** 并发 sendEvent/flush；唯一约束冲突；慢查询下轮询不重叠。

### P2-13 timeout 清理期间 next 完成，可能吞掉 TimeoutError（R1）

**位置：** `src/lib/orchestrator/timeout.ts:73`、`:99`
**现状：** 定时器回调先 await `onTimeout` 再 reject；该清理等待中底层 `next()` 若先返回 `done:true`，`Promise.race` 会先选 next，包装器正常完成；若返回 value，会迟到 yield。此问题早于 `ff53430`，与“`iterator.return` 有界”独立。
**最小修法：** 超时标志在进入 `onTimeout` 前先胜出（优先 reject），清理只作为后台收尾；不得让 `next()` 的完成覆盖已触发的超时语义。
**测试：** 延迟 next、等待 `onTimeout` 开始，再 resolve `next(done:true)`；drain 必须仍抛 `TimeoutError`。

---

## 4. 旧 36 项未闭环映射

> 已修/已关闭：#1 越界自动删除、#2 审计内容证据（`0dd751a`/`ce2703b`）、#4 OpenCode 默认权限、#7 删除停止 CLI、#11 锁、#13 OpenCode 会话隔离（`ae39e00`）、#20 timeout cleanup、#35 Tailwind 动态色。
> **注意：** 原 36 项 #2 是“审计漏报/失效放行”，已由 P1-01/`0dd751a`+`ce2703b` 闭环；质量复核报告里的第 2 项是“completed CAS 后成功摘要”，已由 `be969e0` 修复，两者编号相同但内容不同。
> 下表的“部分”表示主要风险已缓解但仍有明确缺口。

| 旧# | 状态 | 位置 | 缺口 / 最小动作 |
|---|---|---|---|
| 3 | 未修 | API 路由 / README | 无认证；README 已明确仅本机。若产品化/暴露局域网，必须加 Bearer/token |
| 5 | 部分 | `sessions/route.ts:22`、`[id]/route.ts:71` | API 未校验 `permissionMode ∈ {default,auto}`；CLI 已固定 default，不能绕过，但非法值会静默按 default |
| 6 | 未修 | `permission/route.ts:22` | 只查 session 存在，未校验 requestId 所属 session；改为按 key/owner 校验 |
| 8 | 部分 | `path-safety.ts:20`、files accept/download | 已存在路径有 realpath；新文件父目录 symlink 未校验；下载仍 `join + readFile` |
| 9 | 未修 | attachments 上传/下载 | SVG 仍允许并 `inline` 返回；改 `attachment` 或加 CSP/sandbox |
| 10 | 部分 | `arg-safety.ts:8`、`opencode-adapter.ts:246` | Windows cmd 元字符已挡；POSIX 字符未覆盖（Windows-only 接受）；临时配置中的 API key 仍未做 ACL/清理 |
| 12 | 部分 | `alignment.ts:83,421`、`execution.ts:819`、`chat-router.ts:289` | 仍有 4 处 `transitionPhase` 返回值未检查；补检查/测试 |

| 14 | 未修 | `attachments/route.ts:34` | 先全量 `formData()`；无总数量/总大小；中途 413 留下已写文件和记录 |
| 15 | 部分 | `chat/route.ts:109` | `POST /messages` 已校验 replyTo；`POST /chat` 未校验 |
| 16 | 未修 | `redo/route.ts:83,95` | `transitionPhase` 后才 `trim()`；非字符串 → 500。先校验类型再推进 |
| 17 | 未修 | `sessions/route.ts:26,49` | 先 `session.create` 再校验 private agentIds；失败留空会话。先校验/事务 |
| 18 | 未修 | `messages/[messageId]/route.ts:23` | Pin 数量 `count` 后 `update`；并发可超 10。用事务/短锁/条件写 |
| 19 | 部分 | `event-log.ts`、events route | 见 P2-12：seq 冲突吞掉、SSE 轮询重叠；已有持久化/重放/前端去重 |
| 21 | 未修 | `use-chat.ts:43` | 切 session 不清 messages/pending/loading，不 abort 旧 fetch；只有 seq gate/EventSource 重置 |
| 22 | 未修 | `projects/[id]/page.tsx:94` | 只处理 done；无 permission_request 批准入口 |
| 23 | 未修 | `attachment-input.tsx:44,68` | 闭包 `attachments` 覆盖；并发上传互相覆盖；上传未完成发送仍带占位 ID |
| 24 | 未修 | `setup-wizard.tsx:101,118` | 不检查 `res.ok`；连接测试前先保存；失败仍可能完成 |
| 25 | 未修 | `provider-import-dialog.tsx:41` | `toast.success`/关闭早于异步导入结果；改为 await 成功后再提示 |
| 26 | 部分 | `chat-area.tsx:537` 等 | 项目页 Agent 名称映射已修；diff 接受失败仍只 `console.error`、+添加无 onClick、Dialog 无 focus/aria、移动端侧栏无入口 |
| 27 | 未修 | `task-poller.ts:13,47` | 快照只有 id/status/trace；description/dependencies 变化不刷新 |
| 28 | 未修 | `mcp-config.ts:14` | MCP 仍硬编码 `cwd/dev.db`；主进程用 `DATABASE_URL` |
| 29 | 未修 | `mcp-server/index.ts:125` | `asc + take 50` 读最旧 50 条；改最新 50 后反序 |
| 30 | 未修 | `prisma/seed.ts:140` | `.catch(console.error)` 不设 exitCode；失败仍成功退出 |
| 31 | 未修 | `prisma/migrations` | 历史 v2 migration 对已有数据失败；当前 `db push` 规避，若走 migrate 需单独修 |
| 32 | 未修 | `experiments/p5/config.ts:52`、`run.test.ts` | 路径写死 `D:/...`；metrics 清理仍在测试 setup；README 直跑配置未说明 |
| 33 | 未修 | `.github/workflows/ci.yml` | CI 跑 `vitest run`，不跑 coverage；阈值只在 `npm test` 生效 |
| 34 | 部分 | `README.md`、roadmap | Node 20.19+/1444 已更新；README 未再写 API 路由总数；E2E 文档需继续核对 |
| 36 | 未修 | `message-parser.ts:30,34,46` | 只匹配 `\n` 不匹配 CRLF；`lineStart` 是块计数器不是真实行号；metadata 用 `split('=')` 截断含 `=` 的值 |

---

## 5. 已接受风险 / 不纳入本批

以下不是“忘了修”，而是当前明确接受或有前置条件；不要在没有用户确认时自行扩大范围：

1. **API 无认证**：项目定位本机单用户；`dev` 绑 `127.0.0.1`。生产/局域网暴露前必须补认证。
2. **历史 migration 缺陷**：推荐路径是 `prisma db push`；不执行历史 migration。若用户要求 migrate deploy，再单独立项。
3. **Windows-only 参数安全**：`assertSpawnSafe` 只覆盖 cmd 元字符；POSIX 字符不在目标平台威胁面。临时配置 API key 仍是残留风险。
4. **共享 projectDir 的外部并发修改**：可能落入本批审计 diff；逐任务硬边界需要 worktree 隔离，当前未启用。
5. **OpenCode default 只读**：headless `ask` 自动拒绝是 CLI 行为；不擅自改成默认 auto。
6. **事件重放是 best-effort**：flush 有 5s 上限；写入失败不阻塞主流程。
7. **普通 retry/idle cleanup**：仍用 `killEntryIfCurrent`，不等待真实退出；stop/delete/cancel 已走 `terminateEntry`。
8. **fast LLM 决策**：HTTP fetch 未绑定会话 AbortSignal；stop/delete 撞上时可能 15/30s 后返回 202/409。

### 5.1 其他已记录但未展开

| 项 | 位置 | 动作 |
|---|---|---|
| `--settings` 路径含空格被 `assertSpawnSafe` 拒绝 | `process-registry.ts` / `arg-safety.ts` | 统一短路径/转义策略，或把路径放到无空格受管目录；补含空格工作区测试 |
| 刷新后恢复仍有效的权限请求 | `GET /api/sessions/[id]/runtime`（未实现） | 从 ProcessRegistry 快照返回 pending permissions，前端恢复确认框；测试刷新恢复 |
| E2E 与 `migrate deploy` 文档/路径不一致 | `docs/test-plan-detailed.md`、E2E 配置 | 统一为 `db push` 或明确 CI 的 migrate 路径；更新命令与断言 |
| MCP `since` 分页 | `src/mcp-server/index.ts` | 最新 50 条 + `since` 游标（与旧 #29 合并处理） |
| OpenCode 私聊只读提示 | `chat-fab.tsx` | 见 P2-10，私聊与群聊一致提示 |

---

## 6. 建议执行顺序

1. ~~P2-07 拿锁前旧快照~~（`d2fb158` 已闭环）
2. ~~P2-04 F2/F3/F6/R2~~（`351cdbe` 已闭环）
3. ~~P2-03 F5 并发 DELETE~~（`95e0755` 已闭环）
4. ~~F7 done 恢复绕过审批~~（`52d66c9` 已闭环）
5. ~~F11 Windows `.ENV` 大小写审计~~（`4a7efec` 已闭环）
6. **F8：问句不得算批准**
7. **F9：恢复 phase 写入前取消复查**
8. **F10：Q&A 分支保存明确批准**
9. **P1-03 F4：OpenCode managed 资源最终清理**
10. **P2-13 R1：onTimeout 与 next 的超时优先级**
11. **P2-08/09 进程树/Agent 创建取消**
12. **P2-10/11/12 提示/清扫/事件**
13. 旧 36 项 P3 表按风险分批；Pin、MCP、附件、UI 可各自独立提交。

每项完成后更新 `PROGRESS.md`、`docs/design/roadmap-to-excellence.md`、`docs/design/handoff-2026-10-19-batch0.md`，并在本文件把对应项标记为 ✅（或删除已闭环项）。

---

## 7. 验证模板

```powershell
# 1. 针对性测试（先红后绿）
npx vitest run tests/<target>.test.ts

# 2. 全量
npx vitest run

# 3. 构建
npx next build

# 4. 改动文件 lint（0 error；warning 记录但不阻塞）
npx eslint <changed-files>
```

**当前基线：** `123 files / 1447 passed / 3 skipped`；build 通过；未 push。

**变异验证模板：**
1. 先写失败测试，确认失败原因正确。
2. 改代码 → 测试绿。
3. 临时回退关键行 → 测试必须精确红。
4. 还原 → 全量绿。
5. 记录实际输出，不用“应该可以”代替。

---

## 8. 审查复现材料

2026-10-20 质量复核报告与复现文件（仓库外，可能随临时目录清理）：

- Round 2 报告：`<home>\.codex\visualizations\2026\10\20\01a157b9-2549-7321-a5a8-9a46eeb05ea4\agenthub-repair-quality-review-round2.md`
- Round 2 复现：同目录 `review-round2-nested-env.test.ts`（F1，已由 `61c7218` 修复）、`review-round2-plan.test.ts`（F2/F3）、`review-round2-managed-exit.test.ts`（F4）、`review-round2-delete.test.ts`（F5）、`review-round2-timeout-race.test.ts`（R1）
- 初轮报告：同目录 `agenthub-repair-quality-review.md`；6 条独立复现 `review-quality-repros.test.ts`；B2 CAS 摘要 `review-cas-repro.test.ts`（已由 `be969e0` 修复）

使用方式：复制到仓库 `tests/` 的**唯一新文件**，用现有 Vitest alias 运行；不要覆盖原有测试。复现预期失败，直到对应缺口被修复。

---

## 9. 本次审查的结论摘要

- 锁队列、chat 常规异常释放、任务/verify 单事务、OpenCode 目录名 hotfix：可独立认可。
- 最新复核后 P1-01 已由 `4a7efec` 补齐 `.ENV` 大小写；P2-04 的问句批准（F8）、取消窗口（F9）、Q&A 批准保存（F10）仍未闭环。
- 最危险的剩余项：**F8 问句批准、F9 恢复取消窗口、F10 Q&A 批准保存**；随后 P1-03 F4、P2-13 R1、P2-08/09、P2-10/11/12。
- 已独立认可：P2-05 Claude MDS `a24ca60`、P2-01 iterator.return `ff53430`、P2-02 regenerate `74bda96`、P2-06 SSE cancel `7520866`、P1-02 tools `a5e6991`、P1-01 根/忽略目录 `.env` + 嵌套 `.env` `0dd751a`/`ce2703b`/`61c7218`。
- 质量复核报告第 2 项“completed CAS 拒绝后仍发布成功摘要”已由 `be969e0` 修复；不要重复修。原 36 项 #2（审计内容漏检）已由 `0dd751a`+`ce2703b` 修复，原 #13（OpenCode 会话隔离）核心已由 `ae39e00` 修复。
