# AgentHub 全量代码审查报告

> **审查日期**: 2026-06-22
> **审查方式**: 6 模块并行 + 对抗性验证（19 agent workflow）
> **审查范围**: `src/` 全量分模块（编排核心 / 适配器层 / API 安全敏感 / API CRUD / lib+MCP / 前端）
> **状态核对日期**: 2026-06-22（ProcessRegistry 6 步重构完成后）

---

## 严重度汇总

| 严重度 | 原始数量 | 已解决 | 未解决 |
|--------|----------|--------|--------|
| 🔴 P1 真高危 | 4 | 4 | **0** |
| 🟠 P2 中等 | 25 | 11 | **14** |
| 🟡 P3 加固 | 19 | 0 | **19** |
| **合计** | **48** | **15** | **33** |

> **数字说明**: 原始报告声明 48 条（4 P1 + 25 P2 + 19 P3）。本报告逐条核对当前代码状态，P2 实际按编号列出至 #43（跨 6 个模块），编号延续至 #62；以原始声明总数为准，逐条状态见下文标注。

> **重构约束**: ProcessRegistry 6 步重构的硬约束是「只动 `process-registry.ts` + 测试 + orchestrator 3 处调用，调用方零改动」。因此非 ProcessRegistry 模块的问题（M3/M4/M5/M6 + M1 编排层的大部分）在 6 步重构中一条未碰，状态核对只需确认 ProcessRegistry 内的条目已解决即可。

---

## 状态标注说明

- ✅ **已解决** + 解决于哪个 commit
- 🔴 **未解决 P1**
- 🟠 **未解决 P2**
- ⚠️ **安全高危**（P2 实为安全级，应优先）
- 🟡 **未解决 P3**

---

# 🔴 P1 真高危（4 项）

### #1 权限响应路由失效 → Agent 永久卡死 ✅ 已解决（第1步 键统一，commit `6ffb806`）
**文件**: `src/lib/adapter/process-registry.ts:341-343, 483, 780-817`
**问题**: registry 用 `effectiveKey`（=key+toolsHash）存进程，但 `requestIdToKey` 存的是未加 hash 的原始 key。配置了 allowedTools + 手动权限模式时，`registry.get(key)` 返回 undefined，批准消息永远写不回子进程 stdin。
**触发**: 任何 Agent 配了工具白名单且权限模式非 auto。
**后果**: 用户点"允许"无效，Agent 干等 60s 超时，重试 3 次全部失败。核心卖点"工具集硬限制"这条路径完全不可用。

### #2 同 key 并发 send 共享进程 → 内容串话 ✅ 已解决（2b entry 互斥锁，commit `8cc36b0`）
**文件**: `src/lib/adapter/process-registry.ts:162-177, 392-420`
**问题**: Claude 持久进程跨请求复用，但 getOrCreate 对同一 key 并发调用返回同一 entry，无 busy 锁。两路 send 各写同一 stdin、监听同一 stdout，事件互相串。
**触发**: ① 任务运行 >60s（session-lock 超时）时的第二条消息；② `executeTaskBatch` 把同 agent 的两个无依赖任务并行派发（根本不过锁）。
**后果**: 回答错发对象、result 提前结束、sessionId 归属错。数据正确性级 bug，用户无法察觉。

### #3 sessionId 直接拼路径，无校验 ✅ 已解决（2026-06-22 commit `170d5c0`）
**文件**: `src/app/api/sessions/[id]/files/accept/route.ts:31-42`
**问题**: `baseDir = join(cwd, 'workspaces', sessionId)`，sessionId 来自 URL 段，既无存在性校验也无格式校验。traversal 守卫只检查 filePath 不检查 sessionId。
**后果**: `POST /api/sessions/<任意字符串>/files/accept` 可往任意 sessionId 目录写文件，无归属校验。若 Next 路由层不严，还能向上穿越。

### #4 敏感路径拦截可绕过 ✅ 已解决（2026-06-22 commit `170d5c0`）
**文件**: `src/app/api/sessions/[id]/files/accept/route.ts:6, 44-50`
**问题**: `SENSITIVE_PATHS = ['.env','.git','node_modules','.next']`，用 `includes(part)` 精确分段匹配。
**绕过方式**:
- `.env.local` / `.env.production` / `.env.development` —— 段不等于 `.env`
- `.github/workflows/*.yml` —— `.github` 不在列表（CI 投毒）
- Windows 下 `.ENV` —— 大小写不匹配但文件系统不敏感
**且** `target:'project'` 时 baseDir 是 `process.cwd()`（应用源码树），前端 Accept 用 `force:true` 可覆盖已存在文件。
**后果**: 覆盖 `.ts` 路由文件 → Next dev 模式热重编译 → **RCE**。
**攻击链**: #3 + #4 可拼成完整 RCE 链，本地用户也建议立即修。

---

# 🟠 P2 中等（25 项）

## M1 编排核心

### #5 executeTaskBatch 丢弃 per-task cliSessionId 🟠 未解决
**文件**: `src/lib/orchestrator/index.ts:308-372`
**问题**: execution.ts 为每个 agent 算了 sessionId，但 executeTaskBatch 的 agents 类型没这字段，connect() 也没传。批量任务全部冷启动 CLI 会话。
**后果**: 批量执行/纠偏重试时丢失对齐阶段对话历史，只能靠 prompt 注入的项目背景兜底。

### #6 依赖任务结果恒为空 🟠 未解决
**文件**: `src/lib/orchestrator/index.ts:344-347`
**问题**: `depContext = task.dependencies.map(depId => results.get(depId)?.result)`，但 results 是单次 batch 的局部 Map，下游任务在后续迭代才进入 readyTasks，永远查不到上游。
**后果**: 拓扑依赖功能名存实亡——B 任务永远拿不到 A 任务的产出，只靠 discussionSummary 部分补偿。

### #7 parseJSON 括号配平不跳过字符串字面量 🟠 未解决
**文件**: `src/lib/orchestrator/index.ts:201-221`
**问题**: 逐字符对括号计数时不识别字符串内的括号、不处理转义。LLM 回复含 `}` 或 `]` 的字符串值时 depth 提前归零，截出残缺 JSON。
**后果**: 中文长回复、含 JSON 片段的 message 容易触发，Orchestrator 决策随机解析失败。

### #8 transitionToExecution 空任务兜底后未 return 🟠 未解决
**文件**: `src/lib/services/alignment.ts:269-277`
**问题**: existingTasks 为空时调用 handleArchitectPlan（它会把 phase 设回 'alignment' 等用户确认），但 transitionToExecution 不 return，直接 fall through 到 handleExecution。
**后果**: 绕过用户对方案的确认直接执行刚生成的任务；phase 显示与实际状态错乱。

### #9 同 agent 并行任务 registryKey 冲突 ✅ 已解决（第1步 身份判断 + 2b 锁，commit `6ffb806`/`8cc36b0`）
**文件**: `src/lib/orchestrator/index.ts:14-24, 399, 408`
**问题**: registryKey 不含 taskId。同批中同 agent 的两个无文件重叠任务用同一 key，后注册覆盖先注册，超时 gracefulKill 可能杀错进程。

### #10 监控阶段 Promise.race 超时不取消 executeSingleAgent 🟠 未解决
**文件**: `src/lib/services/execution.ts:240-262`
**问题**: `Promise.race([executeSingleAgent, 2 分钟 reject])`，超时分支先 reject 后，executeSingleAgent 仍后台跑，内部 withTimeout 是 15 分钟才清理。
**后果**: 每次监控超时残留一个孤儿 CLI 进程（permissionMode:'auto'，可能产生真实副作用），最长 15 分钟。

### #11 assignedAgent 匹配失败静默换人 🟠 未解决
**文件**: `src/lib/orchestrator/index.ts:340-341`
**问题**: `agentMap.get(name) || agents[index % agents.length]`，匹配失败时按索引猜一个 agent 执行。
**后果**: 任务被错误的 agent（错 systemPrompt/凭证/平台）静默执行，无告警，极难排查。

## M2 适配器层

### #12 exit 闭包无条件 delete → 误删同 key 新进程 ✅ 已解决（第1步 身份判断，commit `6ffb806`）
**文件**: `src/lib/adapter/process-registry.ts:282-288, 307`
**问题**: exit 处理器闭包捕获 key，无条件 `registry.delete(key)`。竞态窗口下，旧进程的 exit 事件在新 entry 被 set 之后才派发，把新 entry 删了。
**后果**: 新进程脱离 registry 管理 → 既不被 cleanupIdle 回收也不被 gracefulShutdown 杀掉 → 进程泄漏，后续 send 又新 spawn。

### #13 进程复用 key 不含 apiKey/baseUrl/model ✅ 已解决（2c.2 配置指纹，commit `3e5f700`）
**文件**: `src/lib/adapter/process-registry.ts:162-177, 231-240`
**问题**: 复用 key 只看 chatSessionId:agentId:workDir（+toolsHash），环境变量只在 spawn 时注入一次。
**后果**: 同会话内改 Provider/换模型/换 key 后，约 10 分钟内复用旧 env 进程，"改了配置没反应"。10min 后自愈。

### #14 权限批准后事件循环忙等空转 ✅ 已解决（第1步 Set 替换，commit `6ffb806`；2a 行为测试，commit `846d1b8`）
**文件**: `src/lib/adapter/process-registry.ts:588-602`
**问题**: 已 resolved 的 permission promise 仍留在 `pendingPermissionPromises` 数组里被反复 race，绕过 50ms 节流定时器。
**后果**: 任意一次工具权限交互后，该轮剩余时间内事件循环 100% 忙等 → 单进程对话打满一个 CPU 核，多 Agent 并发拖垮服务器。

### #15 进程自然退出时临时配置文件不清理 ✅ 已解决（2c.1 cleanupEntry，commit `5963771`）
**文件**: `src/lib/adapter/process-registry.ts:282-288, 849-855`
**问题**: killEntry 会 unlink mcpConfigFile/openCodeConfigFile，但 exit 处理器（自然退出/崩溃路径）不清理。
**后果**: tmpdir 累积 `agenthub-mcp-*.json` / `agenthub-oc-*.json`，含 MCP 配置和 server env，磁盘+隐私双重隐患。

### #16 超时进程在重试耗尽后不被回收 ✅ 已解决（2c.1 cleanupEntry 统一，commit `5963771`）
**文件**: `src/lib/adapter/process-registry.ts:369-376, 580-586, 882-893`
**问题**: NO_DATA_TIMEOUT 抛错时进程仍存活但 state='working'，readRound 异常退出不复位 state，最后一次失败对 Claude 格式不 killEntry，cleanupIdle 只回收 idle 状态的。
**后果**: 每次超时+重试耗尽都泄漏一个卡死进程，占进程槽（MAX_PROCESSES=10），最终新对话因进程数满失败。

### #17 NDJSON 解析丢弃无结尾换行的最后一行 ✅ 已解决（2c.1 readNdjsonRound flush，commit `5963771`）
**文件**: `src/lib/adapter/process-registry.ts:650-652, 758-761`
**问题**: `split('\n')` 后 `pop()` 保留不完整尾段，流关闭后从不解析它。OpenCode 进程退出前最后一次 flush 常无换行。
**后果**: OpenCode 流最后一段输出或最终 session/error 事件可能丢失，回答被截断或拿不到 sessionID。

### #18 崩溃重试用起始 config.sessionId，丢失已建立的会话 ✅ 已解决（第1步+2a flush，commit `6ffb806`/`d78b2bc`）
**文件**: `src/lib/adapter/process-registry.ts:209, 327-330`
**问题**: 新会话首轮 CLI 已分配 sessionId 并写入 entry.sessionId，但中途崩溃重建时 spawnProcess 用的还是 config.sessionId（null），不 --resume。
**后果**: 新会话首轮崩溃重试后开了全新会话，"重试后失忆"。

### #19 OpenCode 权限白名单只 deny 枚举内工具 🟠 未解决
**文件**: `src/lib/adapter/process-registry.ts:84, 103-112`
**问题**: `buildOpenCodePermission` 只遍历硬编码的 `OPENCODE_ALL_TOOLS` 写 allow/deny，枚举外工具（OpenCode 新增/MCP 注入的）落到默认策略可能被放行。
**后果**: 工具白名单形同部分失效，违背安全隔离预期。

## M3 API 安全敏感

### #20 多个早返回路径不释放 session 锁 🟠 未解决
**文件**: `src/app/api/sessions/[id]/chat/route.ts:15-32, 40-69`
**问题**: `acquireSessionLock` 在函数顶部获取，但 `releaseLock` 只在主 ReadableStream 的 finally 里调。JSON 解析失败/message 校验失败/session 不存在/permission 命令两个 return —— 5 个早返回路径都绕过释放。
**后果**: 该 sessionId 被锁 60s，对同一会话的下一条正常请求要等 60s 超时。`/permission` 切换权限模式是正常功能，每次都泄漏锁。

### #21 SVG 内联 XSS ⚠️🟠 未解决（安全高危）
**文件**: `src/app/api/sessions/[id]/attachments/route.ts:8-12, 55-60`
**问题**: MIME 校验依赖 `file.type`（客户端可伪造），白名单含 `image/svg+xml`。下载路由对 image/* 用 inline 处理，无 nosniff。
**后果**: 含 `<script>` 的 SVG 以 svg+xml 上传 → 同源加载执行脚本。本项目无登录态故无"会话窃取"，但同源任意脚本仍可篡改数据/伪造操作。

### #22 GET 会话时无锁重置卡住任务 🟠 未解决
**文件**: `src/app/api/sessions/[id]/route.ts:28-47`
**问题**: GET 处理器无锁地把 updatedAt 早于 5 分钟的 in_progress 任务重置为 pending。execution.ts 主路径有 60s 心跳保护，但 redo/downstream 路径无心跳。
**后果**: redo 任务跑 >5min 时，任何 GET（刷页面）会让它状态在 in_progress/pending 间抖动。redo 流程结束会自愈。

### #23 session-lock 超时定时器不清理 🟠 未解决
**文件**: `src/lib/session-lock.ts:10-15`
**问题**: `Promise.race([prev, 60s 超时 Promise])`，prev 先 resolve 后超时 Promise 内的 setTimeout 不取消，60s 后仍 reject 已落败 Promise → UnhandledPromiseRejection。
**后果**: 每次正常加锁都留一个 60s 后触发的未处理拒绝 + 悬挂定时器，高并发放大。

### #24 SSE 超时关闭后 finally 重复 controller.close() 🟠 未解决
**文件**: `src/app/api/sessions/[id]/chat/route.ts:105-111, 246-251`
**问题**: 超时设 streamClosed=true 并 close()，finally 又无条件 close()，二次 close 抛 TypeError。streamClosed 不响应客户端断连（request.signal abort）。
**后果**: 超时或客户端中途断连产生未捕获异常，日志噪声，可能影响锁释放。

### #25 path-safety 回退分支不解析 symlink 🟠 未解决
**文件**: `src/lib/path-safety.ts:17-25`
**问题**: 目标存在时用 realpathSync，不存在时回退到普通 resolve（不解析中间目录的符号链接）。
**后果**: 若 workDir 内已存在指向外部的符号链接目录，传 `<symlink>/newfile` 这类最终段不存在的路径可绕过校验写到 workDir 外。利用条件中等。

### #26 下载路由对 sessionId 无校验 ✅ 已解决（2026-06-22 commit `170d5c0`）
**文件**: `src/app/api/sessions/[id]/files/[filename]/route.ts:9-16`
**问题**: filename 拦截了 `..`/`/`/`\`，但 sessionId 直接拼入路径，无存在性/格式校验，无归属校验。
**后果**: 任意人可读取任意 session 工作区文件；若路由段能解码遍历序列还能目录上移。

## M4 API CRUD

### #27 Session PUT/DELETE 缺存在性检查 🟠 未解决
**文件**: `src/app/api/sessions/[id]/route.ts:52-85`
**问题**: 直接 update/delete，id 不存在时抛 P2025 未捕获 → 500。其他 [id] 路由（agents、providers）都做了 findUnique→404，处理不一致。

### #28 DELETE recent-dir 同问题 🟠 未解决
**文件**: `src/app/api/recent-dirs/route.ts:28-37`
**问题**: P2025 未捕获 → 500，前端无法做幂等删除。

### #29 创建消息未校验 sessionId/taskId 外键 🟠 未解决
**文件**: `src/app/api/sessions/[id]/messages/route.ts:53-56`
**问题**: sessionId 来自路径未校验，taskId 来自 body 完全未校验。外键约束失败 P2003 未捕获 → 500。

### #30 添加成员未处理 P2003 🟠 未解决
**文件**: `src/app/api/sessions/[id]/members/route.ts:37-48`
**问题**: 只捕获 P2002（唯一冲突），sessionId 不存在导致的 P2003 被 rethrow → 500。

### #31 Agent PUT 校验弱于 POST 🟠 未解决
**文件**: `src/app/api/agents/[id]/route.ts:31-49`
**问题**: 三个缺陷：① name 无 XSS 标签校验（POST 有，PUT 可绕过）；② 改名撞名 P2002 未捕获 → 500；③ `...(apiKey && { apiKey })` 真值判断 → 空串无法清空 apiKey（其他字段用 `!== undefined` 不一致，无法移除已泄露的密钥）。

### #32 Provider PUT name 校验缺失 🟠 未解决
**文件**: `src/app/api/providers/db/[id]/route.ts:33-44`
**问题**: `name.trim()` 不校验 typeof，非字符串抛 TypeError → 500；空串可通过（POST 禁止）；改名撞名 P2002 未捕获 → 500。

### #33 Pin 数量上限 TOCTOU 🟠 未解决
**文件**: `src/app/api/sessions/[id]/messages/[messageId]/route.ts:24-34`
**问题**: 先 count 判断 >=10 再 update，两步非原子。并发 PATCH 各读到 9 时都通过校验，最终 Pin 数超过 10。

### #34 providers/db 明文返回 apiKey ✅ 已解决（2026-06-22 commit `b59932d`，方案 ④ providerRef）
**文件**: `src/app/api/providers/db/route.ts:4-9` 和 `db/[id]/route.ts:11`
**问题**: select 含 apiKey 且不做任何掩码，明文返回浏览器。而 `/api/providers` 对 settings.json/toml 来源是掩码的，同一份存储两接口不同策略。
**后果**: F12 抓包就能拿到完整 API Key。

### #35 createMany 写成员未防重复 agentId 🟠 未解决
**文件**: `src/app/api/sessions/route.ts:56-62`
**问题**: agentIds 含重复时违反 `@@unique([sessionId, agentId])` P2002 未捕获 → 500，会话已建但成员写失败造成半成功。

## M5 lib + MCP

### #36 孤儿附件清理 TOCTOU 🟠 未解决
**文件**: `src/lib/attachment-cleanup.ts:17-29`
**问题**: findMany 查 messageId=null 的孤儿后 unlink+deleteMany，deleteMany 的 where 不再复查 messageId。若查询和删除之间某条消息把这个附件关联上，文件和 DB 记录被一起删。
**后果**: 竞态下误删已被消息引用的附件 → 数据丢失。

### #37 workspace.ts cpSync 不保留时间戳 🟠 未解决
**文件**: `src/lib/workspace.ts:20-28, 116-122`
**问题**: 复制时不设 preserveTimestamps，auditTaskWorkspace 用 mtime 比对，所有被复制的文件都会被判为已修改。
**当前**: 这套审计函数无任何调用方，属未集成死代码，潜伏 bug。

### #38 buildMCPConfig 硬编码 dev.db 🟠 未解决
**文件**: `src/lib/mcp-config.ts:14`
**问题**: 用 `file:${cwd}/dev.db` 硬编码，不读 DATABASE_URL。db.ts 和 mcp-server 都用 `DATABASE_URL || 'file:./dev.db'`。
**后果**: 配置 DATABASE_URL 指向其他库时，主进程和 MCP 子进程操作不同数据库，Agent 通过 MCP 发的消息查不到。

## M6 前端

### #39 ChatFab 加载中可重复发送 🟠 未解决
**文件**: `src/lib/hooks/use-chat.ts:79-80, 228-229` + `src/components/chat-fab.tsx:43-48, 307-315`
**问题**: useChat.send 每次新建 controller 覆盖 abortRef，不 abort 上次 reader 循环。ChatFab 输入框只 `disabled={!selectedAgent}`，不检查 loading。
**后果**: 流式输出中反复回车触发并发 send，两个 reader 各自写消息 → 消息重复、文本交错、loading 提前清除、旧 reader 泄漏。

### #40 乐观消息用客户端 UUID 🟠 未解决
**文件**: `src/components/chat-area.tsx:137-143, 156-167` + `use-chat.ts:96-101, 137-143, 220-225`
**问题**: send/done/error 给新消息生成 `crypto.randomUUID()`，服务端不存在。handlePin/handleRegenerate 直接用这个假 ID 调服务端。
**后果**: 对刚流式产生、未刷新的消息执行 Pin/重新生成，操作静默失败——Pin 后 loadMessages 拉回未 Pin 状态（用户以为没生效），重新生成无响应。

### #41 附件并发上传丢数据 🟠 未解决
**文件**: `src/components/attachment-input.tsx:25, 44, 68-96`
**问题**: uploadFiles 用 useCallback 捕获 attachments，onAttachmentsChange 调用形式非函数式更新。快速连续上传两批时，两次回调各基于过期闭包写入，后写覆盖先写。
**后果**: 第一批附件静默丢失，用户可能在不知情下发送缺附件的消息。

### #42 任务轮询按索引比较 + 调速清空列表 🟠 未解决
**文件**: `src/components/agent-panel.tsx:95-126`
**问题**: setTasks 按下标比 status/trace，长度不变时漏检测；effect 依赖 [sessionId, redoPollFast]，点击重做翻转 redoPollFast 让 effect 重建，开头执行 `setTasks([])` 把列表清空。
**后果**: 任务面板可能显示过期数据；每次重做开始/结束任务列表闪烁清空。

### #43 file-card downloadUrl 无 scheme 校验 ✅ 已解决（2026-06-22 commit `b59932d`，isValidDownloadUrl 白名单）
**文件**: `src/components/file-card.tsx:26-34` + `src/lib/message-parser.ts:41-52`
**问题**: parseMessage 从 agent 消息解析 `<!-- artifact:file downloadUrl=... -->`，按空格分割，不限制值。FileCard 直接 `<a href={downloadUrl} download>`。Agent 输出可被提示注入，产出 `downloadUrl=javascript:fetch(...)`。
**后果**: 点击下载即在应用同源执行任意 JS，可调用全部 API。存储型/反射型 XSS。

---

# 🟡 P3 加固类（19 项）

| # | 文件 | 一句话 | 状态 |
|---|------|--------|------|
| 44 | permission/route.ts:9-31 | 权限响应未绑 sessionId/agentId，跨会话批准。当前无鉴权层故影响有限，有鉴权后立刻升级 P1 | 🟡 未解决 |
| 45 | attachments/[id]/route.ts | 附件下载无归属鉴权（IDOR），startsWith 缺尾部分隔符，无 nosniff | 🟡 未解决 |
| 46 | deploy/route.ts:3-5 | 桩实现，request.json() 无 try/catch，非法 body → 500 | 🟡 未解决 |
| 47 | mcp-server/index.ts:19-20 | 顶层 realpathSync 无 try，工作目录不存在崩溃。`REAL_WORK_DIR` 是死代码 | 🟡 未解决 |
| 48 | mcp-server/index.ts:58-61 | list_files 用无分隔符 startsWith，可枚举同前缀兄弟目录文件名（只泄露文件名） | 🟡 未解决 |
| 49 | mcp-server/index.ts:137-150 | read_messages 的 since 参数未校验，非法时间字符串产生 Invalid Date | 🟡 未解决 |
| 50 | sessions/[id]/route.ts:60 | lone surrogate 校验仅 POST 有，PUT 改标题/消息内容均未校验 | 🟡 未解决 |
| 51 | execution.ts:165 | 批量 SSE 未过滤 session/error chunk，内部 cliSessionId 泄露前端 | 🟡 未解决 |
| 52 | execution.ts:314-317 | 含 failed 任务的 session 永不进入 done（allDone 只认 completed/blocked） | 🟡 未解决 |
| 53 | index.ts:354, 422 | 同 agent 并行任务先结束的把 SessionMember.status 提前置 idle，前端显示空闲但仍在工作 | 🟡 未解决 |
| 54 | opencode-adapter.ts:84-101 | OpenCode MCP 配置每次新建 XDG_CONFIG_HOME 临时目录从不清理 | ⚠️ 部分解决（见下方说明） |
| 55 | claude-code-adapter.ts:61-74 | 图片附件 readFileSync 无大小上限，大图 base64 内存放大可能 OOM | 🟡 未解决 |
| 56 | message-parser.ts:3, 30-38 | CodeBlock.lineStart 实际是顺序计数器而非行号，字段语义误导 | 🟡 未解决 |
| 57 | db.ts:12-14 | `PRAGMA foreign_keys=ON` 用 fire-and-forget 未 await，首批查询窗口期级联删除可能不生效 | 🟡 未解决 |
| 58 | attachment-input.tsx:42 | URL.createObjectURL 从未 revoke，频繁加图片内存泄漏 | 🟡 未解决 |
| 59 | create-group-dialog.tsx:230-244 | async onClick 无 try/catch，请求失败 loading 永久卡死 | 🟡 未解决 |
| 60 | use-chat-fab.ts:51-83 | selectAgent 串行 await 多个 fetch 无竞态保护，快速切换可能进错会话 | 🟡 未解决 |
| 61 | use-sessions.ts:73-77 | 在 setSessions updater 内调 setActiveId，违反 React 纯更新函数约定 | 🟡 未解决 |
| 62 | agent-panel.tsx:99, 113, 117, 121-124 | 轮询连续失败 5 次后永久停止，无自愈，需切会话恢复 | 🟡 未解决 |

---

# 状态核对（2026-06-22 ProcessRegistry 6 步重构后）

## 已解决 15 条

| # | 严重度 | 问题 | 解决于 | Commit |
|---|--------|------|--------|--------|
| #1 | P1 | 权限路由失效 | 第1步 键统一 | `6ffb806` |
| #2 | P1 | 并发串话 | 2b entry 锁 | `8cc36b0` |
| #9 | P2 | 同 agent 并行 registryKey 冲突 | 第1步+2b（顺带） | `6ffb806`/`8cc36b0` |
| #12 | P2 | exit 误删新进程 | 第1步 身份判断 | `6ffb806` |
| #13 | P2 | 改配置 10 分钟不生效 | 2c.2 配置指纹 | `3e5f700` |
| #14 | P2 | CPU 忙等 | 第1步 Set 替换 | `6ffb806` |
| #15 | P2 | 临时文件泄漏 | 2c.1 cleanupEntry | `5963771` |
| #16 | P2 | 超时进程不回收 | 2c.1 cleanupEntry | `5963771` |
| #17 | P2 | NDJSON 丢尾行 | 2c.1 readNdjsonRound flush | `5963771` |
| #18 | P2 | 崩溃丢 sessionId | 第1步+2a flush | `6ffb806`/`d78b2bc` |
| #3 | P1 | sessionId 无校验/自证守卫 → RCE | 2026-06-22 UUID+isPathSafe+禁用 target | `170d5c0` |
| #4 | P1 | 敏感路径绕过 + target=project RCE | 2026-06-22 前缀匹配+扩展+禁用 target | `170d5c0` |
| #26 | P2 | 下载路由 sessionId 无校验 → 读 .env | 2026-06-22 UUID+findUnique | `170d5c0` |
| #34 | P2 安全 | providers/db 明文返回 apiKey | 2026-06-22 出站掩码+方案 ④ providerRef | `b59932d` |
| #43 | P2 安全 | file-card downloadUrl XSS | 2026-06-22 isValidDownloadUrl 白名单 | `b59932d` |

## ⚠️ #54 诚实修正

之前在 2c.1 commit message 和会话中声称 #54 被 cleanupEntry 解决。**核对代码后确认不准确**：

- `cleanupEntry` 清理的是 `entry.openCodeConfigFile`（权限配置 **文件** `agenthub-oc-*.json`）✅
- 但 #54 说的是 `opencode-adapter.ts:85` 创建的 `XDG_CONFIG_HOME` **目录**（`agenthub-oc-${agentId}-${Date.now()}`）。这个目录只注入到 spawn 的 env，**没有存到 entry**，cleanupEntry 不知道它存在 → **目录仍在泄漏**。

要真正解决 #54，需在 `opencode-adapter.ts` 的 connect 时把 `configDir` 存入 entry（新增字段如 `openCodeConfigDir`），并在 cleanupEntry 里 `rmSync(dir, { recursive: true })`。属 2c 后续小修。

## 未解决 38 条分布

| 模块 | 数量 | 代表问题 |
|------|------|----------|
| M1 编排核心 | 5 | #5 #6 #7 #8 #10 #11（cliSessionId 丢失 / 依赖结果恒空 / parseJSON / 静默换人） |
| M2 适配器层 | 1 | #19（OpenCode 权限白名单） |
| M3 API 安全敏感 | 4 | #20 #22-#25（锁泄漏 / SVG XSS / symlink）— #3#4#26 已于 2026-06-22 修复 |
| M4 API CRUD | 8 | #27-#33 #35（含 #31 PUT 校验弱）— #34 已于 2026-06-22 修复 |
| M5 lib+MCP | 3 | #36-#38（含 #38 主进程与 MCP 操作不同库） |
| M6 前端 | 4 | #39-#42 — #43 已于 2026-06-22 修复 |
| P3 散布 | 19 | #44-#62（含 #54 部分解决） |

## 安全高危（剩 1 个）

| # | 问题 | 风险 |
|---|------|------|
| #21 | SVG 内联 XSS | 同源脚本执行（次要，无登录态故无会话窃取） |

**2026-06-22 已清零**:#3+#4(RCE 链,commit `170d5c0`)、#34(明文 apiKey,commit `b59932d`)、#43(file-card XSS,commit `b59932d`)。仅剩 #21 一项次要高危。

---

## ⚠️ 如果转多用户/网络部署需重评（本地单用户下无害，部署后立刻升级 P1）

这一节专门记录 **"本地评估安全、网络部署立刻变 P1"** 的问题。当前 AgentHub 是本地单用户工具，以下问题在评估时被降级或忽略；如果未来加鉴权层、多用户支持、或对外网络部署，**必须在部署前逐条重评升级**。

| # | 问题 | 本地（当前） | 多用户/网络部署后 |
|---|------|--------------|-------------------|
| #34 | providers/db 明文返回 apiKey | 用户自己看自己的 key | 任意用户读所有用户的 key → P1 凭证泄露 | ✅ 2026-06-22 commit `b59932d`(出站掩码+方案 ④) |
| #44 | permission/route.ts 权限响应未绑 sessionId/agentId | 本地无并发用户 | 任意用户可批准任意会话的工具调用 → P1 | 未修 |
| #45 | attachments/[id]/route.ts 无归属鉴权（IDOR） | 单用户文件随便看 | 任意用户读他人附件 → P1 | 未修 |
| #26 衍生 | accept/download 的 `findUnique` 在所有路径校验**之后**（line 73-81）| SQLite 本地 µs 级查询无压力 | 攻击者构造合法 UUID 批量探测 → 高频 DB 查询 + 时序攻击 → DB 嗅探向量 | 未修 |
| #50 | sessions PUT 缺 lone surrogate 校验 | 自己输入自己看 | 跨用户数据污染 | 未修 |

**关键判断**：这些不是"现在可以不修",而是"现在评估不充分"。AgentHub 在 README 里若宣传"可部署"，本节列出的项必须先修完。本节同时承担"复审增量"角色——SE 单点审查容易聚焦在直接攻击链（如 #3+#4 的 RCE），跨场景的次生风险（如查询顺序变嗅探）需要复审 / 多视角才能抓到，未来类似复审发现请追加到本节。

---

| 状态 | 增量 |
|---|---|
| 已加 | 多用户重评清单加 \"状态\" 列;`#34` 标已解决,commit `b59932d` |
| 仍需 | `#44` `#45` `#26衍生` `#50` 未修 — 网络部署前必修 |

为防止 `#34` 已修后被误以为\"重评清单空了\",**保留条目并标已解决**,而非删除。其他 4 条保持\"未修\"红线警示。

---

# 优先级建议

**今天就修**:
- (空,4 安全高危已 ✅ 3 清零)

**这周修**:
- #21（SVG XSS,唯一剩余高危,次要）
- #20 #23 #24（锁泄漏相关，影响正常请求体验）

**下周修**:
- #6 #7 #8（编排核心功能性 bug）
- #54 小修（opencode-adapter 存 configDir + cleanupEntry rmSync）

**记下但不急**:
- 其余 P2/P3，等顺手重构相关模块时一起带掉

**本轮已修**（2026-06-22）:
- #3 #4（accept RCE 链）+ #26（下载越界读 .env）— commit `170d5c0`
- #34 #43（apiKey 明文 + file-card XSS）— commit `b59932d`

---

# 重构历史参考

ProcessRegistry 6 步重构（2026-06-22）解决了上述 10 条，提交链：

```
3e5f700 feat(process-registry): 2c.2 配置指纹 — 解决 review #13
5963771 refactor(process-registry): 2c.1 清理统一 — cleanupEntry 抽方法
8bfb964 test(process-registry): 2c.0 测试 hygiene
8cc36b0 feat(process-registry): 2b entry 互斥锁 — FIFO baton-passing
846d1b8 test(process-registry): 修测试 5 永真断言
d78b2bc refactor(process-registry): 2a 加固 — 键统一贯通 + bufferStr 抢救
6ffb806 refactor(process-registry): 键统一 + 身份判断 + 修 CPU 忙等
```

详见 `PROGRESS.md` 的修改历史区。
