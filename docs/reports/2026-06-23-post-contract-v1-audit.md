# 6/15 后 15 commit 隐患审查报告

> 创建时间：2026-06-23
> 审查范围：`git log --since="2026-06-15"` 共 23 个提交，剔除 8 个纯 docs 后 **15 个 code commit**
> 审查方法：六层标准（L0 范围 / L1 内在正确性 / L2 契约一致性 / L3 安全 / L4 可观测性 / L5 测试充分），每个疑点必须代码/测试反证消除才算通过
> 当前 HEAD：`b250e06`
> 工作区未提交：`PROGRESS.md`、`docs/discussions/agenthub-contract-v1.md`、未跟踪 `tests/e2e-contract.test.ts`

---

## 审查范围与判定分布

按主题分 3 组：

| 组 | 主题 | commit 数 | hash |
|---|---|---|---|
| A | ProcessRegistry 重构 6 步 | 7 | `6ffb806` `d78b2bc` `846d1b8` `8cc36b0` `8bfb964` `5963771` `3e5f700` |
| B | 安全修复 | 2 | `170d5c0` `b59932d` |
| C | Contract v1 动作 1-8 | 7 | `e851160` `20aeeb9` `92d3654` `a552db3` `d592e1b` `df1a553` `b250e06` |

**判定分布**：✅ 通过 4 / ⚠️ 可疑 11 / ❌ 隐患 1（按"影响升级"实际有 5 条达 ❌ 级）

---

## 判定标准（执行依据）

每个 commit 必须满足六层全部通过，**且每条疑点必须用代码/测试反证消除**才算 ✅。"应该没问题"不算通过。

| 层 | 检查内容 | 通过门槛 |
|---|---|---|
| L0 范围 | 改了哪些文件/函数/公开接口/外部状态 | 能完整列出 |
| L1 内在正确性 | 不变量、错误路径 cleanup、并发交错、边界、资源泄漏 | 每条疑点找到代码反证 |
| L2 契约一致性 | 接口/DB schema 改了，所有调用方/读取方同步 | 跨文件搜过调用方 |
| L3 安全 | 路径穿越、命令注入、SQL、XSS、RCE、越权、敏感泄漏 | 涉及类目必须穿透到边界 |
| L4 可观测性 | 是否吞异常无日志；状态变更可见 | 不允许静默 catch |
| L5 测试充分 | 新代码路径有针对性测试，覆盖错误/并发/边界 | 找到对应测试文件 |

**三档判定**：✅ 通过 / ⚠️ 可疑 / ❌ 隐患

---

# 🔴 必修：❌ 级（5 条）

按严重度排序。这 5 条是明天首先要修的。

## ❌-1 ProcessRegistry 超时杀进程功能完全失效

**严重度**：致命 — 当前主链路核心功能失效，且静默无任何 log
**commit**：`3e5f700` feat(process-registry): 2c.2 配置指纹
**位置**：
- `src/lib/orchestrator/index.ts:442, 541, 599`（三处 `gracefulKillEntry` 调用）
- `src/lib/adapter/process-registry.ts:1153-1174`（`gracefulKillEntry` 实现）

**问题描述**：
3e5f700 把 `effectiveKey` 改成 `key + toolsHash + configHash`，`configHash` 用 SHA-256 摘要 `permissionMode/mcpConfig/apiKey/baseUrl/model/command/args/format/promptAsArg/disallowedTools` 10 个字段。

Entry 由 `ClaudeCodeAdapter.send` → `processRegistry.getOrCreate(key, spawnConfig)` 创建，spawnConfig 是带 apiKey/baseUrl/model/permissionMode/mcpConfig 等的**完整 config**，effectiveKey 是非空尾巴。

但 orchestrator 三处 `gracefulKillEntry` 只传：
- `gracefulKillEntry(registryKey, { workDir: projectDir })` — index.ts:442
- `gracefulKillEntry(registryKey, { workDir: agent.workDir, allowedTools: ... })` — index.ts:541
- `gracefulKillEntry(registryKey, { workDir: projectDir || '' })` — index.ts:599

`toEffectiveKey` 计算：缺失字段全 undefined → `configHash` 命中 `EMPTY_FINGERPRINT` 短路 → 返回 `''` → effectiveKey = 裸 registryKey → `this.registry.get(effectiveKey)` 返回 undefined → 函数静默 no-op return。

**后果**：
- `TIMEOUT.AGENT_TASK`（默认 1 小时）超时时 `onTimeout` 回调形同虚设
- CLI 进程不会被杀，只能等 10 分钟 idle reclaim
- **无任何 log 告知 effectiveKey miss**（额外问题，见 ❌-1b）
- 这是 review #13"配置改动 10 分钟不生效"问题的**反向出现**

**复现路径**：
1. 任何带 apiKey/model 的 agent 触发 `executeSingleAgent`
2. mock 一个长时间不返回的 CLI
3. 等 `TIMEOUT.AGENT_TASK` 超时 → 触发 `onTimeout`
4. 在 `gracefulKillEntry` 加 debug log 验证 `this.registry.get(effectiveKey)` 返回 undefined
5. 检查 `tasklist` / `ps`，CLI 进程仍在跑

**修复方案**：
- **推荐**：让 adapter 暴露 `getRegistryKey()` 和 `getSpawnConfig()`，orchestrator 透传给 `gracefulKillEntry`，避免各自重建
- **兜底**：`gracefulKillEntry` 不传 config 时回落到前缀扫描（类似 `killEntry(key)` 的兼容分支）

**附带 ❌-1b**：`gracefulKillEntry` effectiveKey miss 时静默 return，**无 console.warn**，配合主问题失败完全无声。修复时一并加日志。

**测试增补**：`tests/process-registry-refactor.test.ts` 加集成测：
```ts
processRegistry.getOrCreate('k', { workDir, apiKey: 'x', model: 'y' })
processRegistry.gracefulKillEntry('k', { workDir })
// 当前必红：进程未被杀
expect(entry.alive).toBe(false)
```

---

## ❌-2 redo API 路径完全没有上车 Contract v1

**严重度**：高 — 用户重做失败任务时常用，所有契约保护在该路径形同虚设
**commit**：影响 `20aeeb9 / a552db3 / d592e1b / b250e06` 全部 Contract v1 动作
**位置**：`src/app/api/sessions/[id]/tasks/[taskId]/redo/route.ts:42-65, 169-187`

**问题描述**：
redo 路径走的是 `executeSingleAgent` 而不是 `handleExecution`，导致 Contract v1 全部保护都没生效：

| 契约保护 | 主链路 | redo 路径 |
|---|---|---|
| task.result 持久化（动作 2） | ✅ execution.ts:264 | ❌ 只 update status |
| `<dependency>` 注入（动作 4） | ✅ index.ts:396-406 | ❌ 没拼 priorResults |
| declaredFiles 敏感校验（动作 6） | ✅ execution.ts:222-256 | ❌ 不检查 |
| outputSchema 软校验（动作 5） | ✅ execution.ts:293 | ❌ 不校验 |
| `<authoritative_input>` 包装（动作 8） | ✅ index.ts:411-431 | ❌ 不包装 |
| cliSessionId invalidate（动作 7） | ✅ execution.ts:240, 342 | ❌ 不处理 |

**后果**：
- redo 跑完后 `task.result = null`，下游任务依赖该 task 时 `priorResults` 查不到 → 依赖注入失效
- redo 写入 `.env` 等敏感路径不会被拦
- redo 输出不做 outputSchema 校验
- redo prompt 不被权威包装，可被消息历史污染

**复现路径**：
1. 创建一个有 outputSchema 和 declaredFiles 的 task，跑完
2. 把它标 failed
3. POST `/api/sessions/{id}/tasks/{taskId}/redo`
4. 跑完后查 `prisma.task.findUnique({id: taskId})`，`result` 字段 = null
5. 让下游任务跑，`priorResults.get(taskId)?.result` 为 undefined

**修复方案**：
- **推荐**：redo 路径改走 `handleExecution` 入口（最稳，自动享受所有未来契约改动）
- **次选**：抽公共函数 `executeTaskWithContract(task, context)` 让 redo 和主链路都调
- **临时**：在 redo 路径手动复制 contract v1 的 6 个保护点（不推荐，会出现新旧分支漂移）

**测试增补**：在 `tests/api-task-redo.test.ts` 加：
- redo 后 task.result 应持久化
- redo 写敏感路径应失败
- redo 应注入 dependency / 包装 authoritative_input

---

## ❌-3 shadow-git 无界增长，无清理调用点

**严重度**：高 — 运维炸弹，长期使用必爆
**commit**：`e851160` feat: 影子 git 模式追踪 workDir 变更（动作 1）
**位置**：`src/lib/services/shadow-git.ts:111`

**问题描述**：
`cleanupShadowGit` 函数定义后**全仓 grep 无任何调用点**（`grep -rn "cleanupShadowGit" src/` 只命中定义本身）。

每个 session 都会在用户 `projectRoot/.agenthub/shadow-git/<sessionId>/` 写一个 bare git 仓库 + 追踪所有 workDir 变更，**永久驻留**：
- 跑 100 session → 100 个 bare 仓库
- 每个仓库随 session 内 git commit 次数线性膨胀
- 长期使用占用磁盘 GB 级

**附带问题（同源）**：
用户的 `projectRoot/.gitignore` 不包含 `.agenthub/`，shadow-git 自己也不在创建时往 projectRoot 或 `.agenthub/` 下写 `.gitignore`。如果 projectRoot 本身是 git 仓库：
- `.agenthub/shadow-git/<sessionId>/` 会出现在用户 `git status` 中
- 可能被用户误 `git add .` 一并提交

**复现路径**：
1. 跑 N 个 session
2. `ls projectRoot/.agenthub/shadow-git/ | wc -l` → 等于 N
3. 在 git 仓库的 projectRoot 跑 session 后 `git status` 可见 `.agenthub/`

**修复方案**：
1. **清理调用点**：
   - `session.delete` 时调
   - `session.isArchived = true` 时调
   - 加个定期 GC 脚本/定时任务清理 N 天未活跃的 shadow 仓库
2. **防误提交**：
   - 在 `shadow-git.ts:32` `git init --bare` 之后，往 `projectRoot/.agenthub/` 下写一个 `.gitignore` 内容 `*`（自排除整个目录）
   - 或：在 ensureShadowInit 时检测 projectRoot 是否是 git 仓库，是的话加 warning 提示用户

**测试增补**：
- session 删除后 shadow 目录应消失
- 重复 ensureShadowInit 应幂等

---

## ❌-4 E2E 测试硬编码真实 API Key

**严重度**：高 — 一旦推送到公开 repo 即泄漏
**commit**：未提交（工作区未跟踪文件）
**位置**：`tests/e2e-contract.test.ts:39`

**问题描述**：
明文写死真实 MIMO API Key（已脱敏，原 key 已 revoked）：`tp-c****fogf4`

当前文件状态：**未跟踪（Untracked）**，未进 git。但 26 个本地提交还没推 `origin/master`，下次 `git add .` 容易顺手带进去。

**复现路径**：
- `git status` 看到 untracked
- `git log -S 'tp-cs010019'` 当前查不到（还没 commit），commit 后能查到

**修复方案**：
1. **立刻**：撤换该 API Key（去 MIMO 控制台 revoke + 重新生成）
2. 改环境变量注入：`process.env.MIMO_TEST_API_KEY`，测试里 `it.skipIf(!process.env.MIMO_TEST_API_KEY)`
3. `.env.example` 加占位
4. 该文件路径加入 `.gitignore`，或确保用环境变量后再 commit

**额外**：用 `gitleaks` 之类工具扫一遍历史，确认其他地方没漏。

---

## ❌-5 CLI 命令注入（Windows shell:true + 用户可控字段）

**严重度**：高 — 前提是 Agent 配置可被攻击者控制（多用户场景）
**commit**：3e5f700 强化（不是新引入，但 model 现在是显式 entry 身份字段，强化了"用户必然控制 model"的假设）
**位置**：`src/lib/adapter/process-registry.ts:339-351`

**问题描述**：
`shell: config.shell !== false` 默认 true。`args` 数组里包含：
- `model`（agent 配置，用户可改）
- `allowedTools.join(',')`（用户可改）
- `workDir`（agent 配置 或 session.projectDir，可控）

Windows cmd shell 解析特殊字符：`& | ; > " ^ \``，将这些字符注入 args 字段会被解释执行。

`3e5f700` 把 model 显式纳入 effectiveKey 的 configHash，**强化了"用户必然控制 model"的假设**——之前可能是 hardcoded，现在明确是 per-agent 可配。

**复现路径**（Windows）：
1. DB 改 agent.model = `"sonnet & calc.exe"`
2. 触发 spawn
3. 观察 calc 是否启动

**修复方案**：
- **推荐**：默认 `shell: false`（直接 spawn 二进制，不走 shell）
- **如必须 shell:true**：对所有 args 字段做 shell-escape（Windows 用双引号包裹 + 转义内部双引号；POSIX 用单引号）
- 同时校验 model/allowedTools 字段（白名单字符 `[a-zA-Z0-9._-]`），拒绝特殊字符

**测试增补**：
- 用恶意字符的 model 跑 spawn，预期：被拒 或 不执行注入命令
- 加 fuzz 测试覆盖 args 字段

---

# 🟡 应修：⚠️ 级（共 16 条）

按主题分组。这些建议在下一个 PR 里清掉。

## 安全相关（6 条）

### ⚠️-S1 orchestrator POST 接受掩码污染 apiKey

**位置**：`src/app/api/config/orchestrator/route.ts:42-44`
**commit**：未在 b59932d 修复范围内（同源问题被遗漏）
**问题**：与 `#34 apiKey 明文` 同源。POST 直接写 `body.apiKey` 无 mask 检测：
```ts
if (body.apiKey !== undefined) updateData.apiKey = body.apiKey
```
GET 已 mask（line 11/23），前端拿到 `***xxxx` 后编辑提交，会把 orchestrator apiKey 污染成 `***xxxx`。
**后果**：Orchestrator 后续调 LLM 全部 401，主链路瘫痪。
**修法**：抄 b59932d 的 providerRef 方案；或加 `if (body.apiKey?.startsWith('***')) return 400`。
**测试增补**：`api-config-orchestrator.test.ts` 加"POST 掩码值应被拒/忽略"。

### ⚠️-S2 path-safety symlink 跨界 acknowledged 未关闭

**位置**：`src/lib/path-safety.ts:17-29`（注释自承）+ accept 路由
**commit**：`170d5c0` 已 ack 但未修
**问题**：`realpathSync` 对**已存在路径**生效，新建文件 fallback 到裸 `resolve+startsWith` → 不能识别 symlink。
Agent 在自己 workspace 通过 Bash 工具执行 `ln -s /etc workspaces/<id>/evil`，再 POST `/api/sessions/<id>/files/accept` body `{filePath: 'evil/passwd_overwrite', content: 'pwned'}` → writeFile 跟随 symlink 写到 `/etc/passwd_overwrite`。
**修法**：
- 写入前对**父目录**做 realpathSync 校验（父目录已存在）
- 或写入后立刻校验 realpath，发现越界立刻 unlink + 报错
- 或禁止 agent 创建 symlink（适配器层拦 ln 命令）

### ⚠️-S3 accept 路由敏感列表与 services/sensitive-paths.ts 双重维护

**位置**：`src/app/api/sessions/[id]/files/accept/route.ts:12-18` vs `src/lib/services/sensitive-paths.ts`
**commit**：`170d5c0` 修了 accept，但没复用统一规则
**问题**：accept 路由的 `SENSITIVE_NAMES` 局部数组只有几条；`services/sensitive-paths.ts` 有完整 regex 名单（`/^vite\.config\.[a-z]+$/` 等）覆盖 `tsconfig.build.json` / `vite.config.*` / `middleware.ts` / `.envrc` / `instrumentation.ts`。
当前 `target === 'project'` 已 403 不可达，**但一旦未来恢复该 target，立刻 RCE**。
**修法**：accept 路由 import `isSensitivePath` 复用，删 `SENSITIVE_NAMES` 局部数组。

### ⚠️-S4 attachments 路由未对齐 UUID/realpath 加固

**位置**：
- `src/app/api/sessions/[id]/attachments/route.ts:18-39`
- `src/app/api/attachments/[id]/route.ts:20-23`
**commit**：`170d5c0` 范围外
**问题**：
- 上传路由 sessionId 不验 UUID（依赖 prisma 404 兜底，契约不一致）
- 下载路由用 `resolve(attachment.path)` + `startsWith(UPLOADS_DIR)` 防越界，**未做 realpath** → 同 ⚠️-S2 的 symlink 风险
**修法**：抄 accept/download 的 UUID 校验 + realpath。

### ⚠️-S5 providerRef 指向空 apiKey 时静默覆盖

**位置**：`src/app/api/agents/[id]/route.ts:70` 和 `agents/route.ts:81`
**commit**：`b59932d`
**问题**：
```ts
resolvedApiKey !== undefined ? { apiKey: resolvedApiKey } : ...
```
当 `provider.apiKey === ""`，`resolvedApiKey = ""`，`!== undefined` 为真，把 agent 的真 apiKey 覆盖为空字符串。
**后果**：可用性 footgun，不是安全洞，但是破坏路径。
**修法**：改成 `resolvedApiKey ? { apiKey: resolvedApiKey } : ...`（非空才更新）。
**测试增补**：`api-agents-provider-ref.test.ts` 加"providerRef 指向空 apiKey 不应覆盖"。

### ⚠️-S6 accept/download 拒绝路径无审计日志

**位置**：`src/app/api/sessions/[id]/files/accept/route.ts` 全部 return 分支 + `[filename]/route.ts`
**commit**：`170d5c0` 范围外
**问题**：拒绝路径直接 return JSON，无 log。攻击者 fuzz UUID/敏感路径**静默失败**，无追踪。
**修法**：所有拒绝分支前加 `console.warn(...)` 或写入 audit table，含 sessionId/path/reason/ip。

---

## ProcessRegistry 相关（4 条）

### ⚠️-P1 respondPermission stdin.write 不在锁内

**位置**：`src/lib/adapter/process-registry.ts:1061-1083`
**commit**：`8cc36b0` 加了 entry 互斥锁，但 respondPermission 路径未纳入
**问题**：HTTP `respondPermissionByRequestId` 调 `entry.stdin.write(buffer)` 不持 entry 锁；同时 readRound 内部 onData 处理 `control_request` auto-allow 时也写 stdin（process-registry.ts:711），三路（send 主流程 / auto-allow / HTTP respond）**并发写同一 stdin**，依赖 PassThrough/Pipe 的 chunk 原子性。
**后果**：在大 buffer 写入时可能字节交错，CLI 收到损坏 JSON 行报解析错。
**复现思路**：同 entry 触发两个并发 permission_request → 前端几乎同时 respond → 加 auto 模式 → 三路并发写 stdin。
**修法**：在 respondPermission 内部 await acquireLock + finally releaseLock。

### ⚠️-P2 send catch 退避期持锁与 commit message 不符

**位置**：`src/lib/adapter/process-registry.ts:597-605`
**commit**：`8cc36b0` message 写"退避期释放锁"，代码实际仍持锁
**问题**：`await new Promise(resolve => setTimeout(resolve, delay))` 在 catch 块（finally 之前），实际退避期 `busy` 仍 true。当前因为先 `killEntryIfCurrent` 杀 entry 所以无害（其他 send 拿不到此 entry），**但实现与 commit 声明不符是埋雷**。
**修法**：把 setTimeout 移出 finally 之外，或在 setTimeout 之前显式 releaseLock 再获取。
**测试增补**：注释掉 `killEntryIfCurrent`，断言 backoff 期 `entry.busy === false`。

### ⚠️-P3 cleanupIdle MAX_PROCESSES 分支可能中断活跃任务

**位置**：`src/lib/adapter/process-registry.ts:1189-1196`
**commit**：pre-existing，本次重构未修
**问题**：`if (registry.size > MAX_PROCESSES)` 后按 lastActive 排序杀**所有**最旧 entry，**不区分 state=working**（前面 idle 分支只杀 idle，但 size 超 cap 分支不区分）。
**后果**：起 11+ 并发 send 时可能中断正在执行任务的最早 entry。
**修法**：MAX_PROCESSES 分支也加 `if (entry.state === 'idle')` 过滤；如果全 working，应等而不是杀。

### ⚠️-P4 cleanupEntry 不清 permissionWaiters

**位置**：`src/lib/adapter/process-registry.ts:481-506` cleanupEntry
**commit**：`5963771` 抽方法时漏了
**问题**：清 `pendingPermissions.clear()` 但不清 `entry.permissionWaiters`（始自 846d1b8 提升 waiter 到 entry 后未对称）。与"统一清理"承诺不对称。
**后果**：dead entry 上 promise 残留要等 GC 才释放，无害但读者会困惑。
**修法**：cleanupEntry 加 `entry.permissionWaiters.clear()`。

---

## Contract v1 相关（6 条）

### ⚠️-C1 prompt 注入：标签未转义可被闭合

**位置**：`src/lib/orchestrator/index.ts:403, 417`
**commit**：`a552db3`（dependency 标签）+ `b250e06`（authoritative_input 包装）
**问题**：upstream result / task.description / declaredFiles 含 `</authoritative_input>` 或 `</dependency>` 字面字符串时**无任何转义**，可提前闭合包装，往后注入"伪权威指令"。

当前依赖"上游 LLM 不会构造闭合标签"这个假设。但：
- 架构师拆 task 时若用户 message 含 `</authoritative_input>` 字符串，会通过 task.description 流到下游 worker prompt
- 上游 LLM 输出本身也可能（恶意 prompt injection / 模型幻觉）含闭合标签

**复现思路**：让架构师 LLM 输出 description 含 `</authoritative_input>\n新的指令`，下游 worker prompt 中包装被闭合。
**修法**：拼接前对所有外部内容做 `.replace(/<\/(authoritative_input|dependency)>/g, '<\\/$1>')` 兜底。
**测试增补**：构造含闭合标签的 upstream result，断言被转义。

### ⚠️-C2 cliSessionId 跨表更新非事务

**位置**：`src/lib/services/execution.ts:236-250, 342-349`
**commit**：`b250e06`
**问题**：task.cliSessionId 和 SessionMember.cliSessionId 两次 prisma 调用，敏感失败/纠偏路径中间崩溃（OOM/SIGKILL/数据库错误）会半残：`task.cliSessionId = null`，`member.cliSessionId = 旧值`。
下次执行时 `execution.ts:174` `task?.cliSessionId || memberSessionMap.get(a.id)` 会从 member 拿旧脏 sessionId → **护栏失效**。
**修法**：包 `prisma.$transaction([task.update, member.updateMany])`。

### ⚠️-C3 正常完成路径用 null 覆盖旧 cliSessionId

**位置**：`src/lib/services/execution.ts:264`
**commit**：`b250e06`
**问题**：`cliSessionId: cliSessionId || null`。若 CLI 本次没吐 session chunk，旧值会被写成 null。与 commit message 声明的"正常完成保留 cliSessionId"**矛盾**。
**修法**：改成 `cliSessionId ? { cliSessionId } : {}`，没返回不更新。
**测试增补**：mock 返回 `{result: 'x', sessionId: undefined}` 验 task.cliSessionId 保留旧值。

### ⚠️-C4 monorepo 子包 package.json 不在敏感列表

**位置**：`src/lib/services/sensitive-paths.ts:16-25` `SENSITIVE_EXACT`
**commit**：`d592e1b`
**问题**：精确匹配 `package.json`，monorepo 子包如 `apps/web/package.json`、`packages/*/package.json` 不命中 → Agent 偷改子包依赖会被放行。
**修法**：加 regex 兜底 `/(^|\/)package\.json$/` 匹配任意层；或维护 `SENSITIVE_BASENAME` 集合按 basename 匹配。

### ⚠️-C5 中文文件名 git 八进制转义漏匹配

**位置**：`src/lib/services/sensitive-paths.ts:46-48` normalize 函数
**commit**：`d592e1b`
**问题**：git 默认 `core.quotePath=true`，含非 ASCII 字符的文件名输出形如 `"\345\207\244.ts"`（带双引号 + 八进制）。
`normalize` 函数不解析这种转义格式 → 中文 `.env` 类文件名漏匹配敏感列表。
**修法**：
- `git -c core.quotePath=false diff ...` 强制关闭转义
- 或 normalize 函数加 unquote 逻辑（剥双引号 + 解八进制）

### ⚠️-C6 schema-validator 不支持嵌套字段路径

**位置**：`src/lib/services/schema-validator.ts:136-145`
**commit**：`df1a553`
**问题**：`presentKeys = Object.keys(parsed)` 只检查顶层。声明 `user.email:string` 会找字面键 `user.email`，nested `{user: {email: 'x'}}` 不命中 → 永远 missing-fields。
**修法**：
- 实现简单 dot-path 解析（`'a.b.c'.split('.').reduce((o,k) => o?.[k], parsed) !== undefined`）
- 或在架构师 prompt 里禁用 dot 字段名（限制 schema 语法）

---

# ✅ 通过：4 条

这 4 个 commit 六层全过且反证齐全，无需补救。

| commit | 主题 | 说明 |
|---|---|---|
| `846d1b8` | permission waiter 提升到 entry | red-green 验证过，size 断言替代永真 timing 断言 |
| `8bfb964` | 测试 hygiene + SIGTERM listener 清理 | afterEach 清 listener 累积，测试 2 走正常路径 |
| `92d3654` | 架构师 prompt + outputSchema 持久化 | parseJSON 多层 fallback + null 防御 + 0 task 兜底，**本批实现质量最高** |
| `df1a553` | outputSchema 软校验 | "软"得彻底，不阻塞下游；多 JSON 块/大小写/缺字段各场景测试齐 |

---

# 建议的修复顺序（明天用）

按"风险大小 + 阻塞推送"双权重排序：

## 第一波：阻塞推送（必须在 push 前修）
1. **❌-4** 撤换 E2E 测试硬编码 API Key（5 分钟，去 MIMO 控制台 revoke + 改环境变量注入）
2. **❌-1** orchestrator gracefulKillEntry 缺 config（**最严重**，超时机制全废，必修）

## 第二波：下一个 PR（核心契约层）
3. **❌-2** redo 路径上车 Contract v1
4. **❌-3** shadow-git 加清理调用 + .gitignore
5. **⚠️-C1** prompt 注入标签转义
6. **⚠️-C2** cliSessionId 跨表更新加事务
7. **⚠️-C3** 正常完成不覆盖 cliSessionId

## 第三波：安全清扫（再下一个 PR）
8. **❌-5** shell:true 改默认 false / args 转义
9. **⚠️-S1** orchestrator POST 接受掩码
10. **⚠️-S2** symlink 跨界关闭
11. **⚠️-S3** 敏感列表合并
12. **⚠️-S4** attachments 加固
13. **⚠️-S5** providerRef 空 apiKey 不覆盖
14. **⚠️-S6** 拒绝路径日志

## 第四波：质量清扫（可缓）
15. **⚠️-P1~P4** ProcessRegistry 小问题
16. **⚠️-C4~C6** Contract 小问题（monorepo / 中文名 / 嵌套 schema）

---

# 附录：审查方法回顾

**用了什么**：
- 3 个 Explore subagent 并行审 3 组 commit
- 每个 commit 走六层标准 + 主动绕过尝试（安全类）+ 设计 vs 实现对照（contract 类）
- 跨文件 grep 找调用方/同类问题
- 测试覆盖度对照（找到对应测试文件，看覆盖了什么/缺什么）

**没做的**（如果明天需要更深入再追加）：
- 真实跑 contract v1 e2e 测试
- 用 gitleaks 扫历史所有 commit 的 secret
- 静态分析工具（CodeQL）跑一遍
- 第三方依赖审计

**为什么没用 100% 标准**：
"完全没有隐患"是不可证伪命题。本报告操作化为"六层全过 + 每个疑点反证 = 实用上的高置信度通过"。剩余的不确定性主要在并发交错的角落场景和未被代码 grep 到的间接调用链。

---

> 报告生成：2026-06-23 22:00
> 审查者：Claude（Explore × 3 subagent）
> 下次更新触发：每条问题修复后在本文件末尾追加 ✅ 修复说明
