# AgentHub 代码审查报告（2026-05-24）
> 创建时间: 2026-05-24 | 审查范围: src/app/api/, src/lib/, src/components/, prisma/, 配置文件, 测试文件

## 审查摘要

4 个 Code Reviewer Agent 并行审查了项目所有代码部分，共发现 **6 类关键问题 + 20+ 重要问题 + 15+ 小问题**。

---

## 🔴 BLOCKER（必须修复）

### B1. 命令注入：ClaudeCodeAdapter 使用 `shell: true`
- **文件**: `src/lib/adapter/claude-code-adapter.ts:39-57`
- **问题**: `spawn` 使用 `shell: true`，`permissionMode` 和 `sessionId` 来自用户/数据库输入，未经清理直接流入 args。Windows cmd.exe 会解释整个命令行，shell 元字符可能导致命令注入。
- **建议**: 验证/清理 `permissionMode` 和 `sessionId`，或改用不带 `shell: true` 的 spawn。

### B2. 命令注入：OpenCodeAdapter 同样使用 `shell: true`
- **文件**: `src/lib/adapter/opencode-adapter.ts:40-58`
- **问题**: 同上，`model`、`sessionId`、`task.systemPrompt` 未经清理。
- **建议**: 同 B1。

### B3. API 密钥多处泄露给客户端
- **文件**: 多处
  - `src/app/api/agents/route.ts:9-13` — GET 返回完整 Agent 对象含 apiKey
  - `src/app/api/agents/[id]/route.ts:9-13` — 同上
  - `src/app/api/providers/route.ts:43-84` — 返回 config.toml 和 settings.json 中完整 apiKey
  - `src/app/api/providers/import/route.ts:25` — 响应回显 apiKey
  - `src/components/provider-import-dialog.tsx:81` — UI 显示 apiKey 前6后4位
- **问题**: API 密钥在 HTTP 响应和前端 JS 内存中完整暴露，任何打开 DevTools 的人可获取。
- **建议**: 服务端返回掩码版本（如 `sk-...w9xz`），客户端不应接收完整密钥。

### B4. 批量赋值：Session PUT 接受任意请求体
- **文件**: `src/app/api/sessions/[id]/route.ts:28-33`
- **问题**: `prisma.session.update({ data: body })` 未做字段白名单过滤，客户端可修改任意字段包括 `id`、`createdAt`，甚至注入嵌套写入。
- **建议**: 解构并白名单化允许更新的字段。

### B5. 任意文件写入：`target=project` 允许覆盖应用源码
- **文件**: `src/app/api/sessions/[id]/files/accept/route.ts:27-36`
- **问题**: 当 `target === 'project'` 时，baseDir 为 `process.cwd()`（应用根目录），路径遍历检查确保路径在根目录内，但客户端可写入 `.env`、`next.config.ts`、API 路由文件等。`SENSITIVE_PATHS` 只检查 `.env`、`.git`、`node_modules`、`.next`，容易被绕过。
- **建议**: 用 `session.projectDir` 作为 baseDir，而非 `process.cwd()`；或大幅扩展敏感路径列表。

### B6. XSS：WebPreview iframe srcdoc 未净化
- **文件**: `src/components/web-preview.tsx:12-16`
- **问题**: `html`/`css`/`js` 直接插入 iframe srcdoc，无 DOMPurify 净化。`sandbox="allow-scripts"` 允许 JS 执行，Agent 输出可能包含恶意 HTML/JS。
- **建议**: 使用 DOMPurify 净化内容，或添加 CSP meta 标签限制权限。

### B7. API 密钥明文存储
- **文件**: `prisma/schema.prisma:38`
- **问题**: `apiKey String @default("") // 服务商 API Key（加密存储）` 注释声称加密存储，实际是普通 String，无加密机制。
- **建议**: 实现加密存储（如 AES-256），或至少更新注释反映真实情况。

### B8. Prisma schema 缺少数据库索引
- **文件**: `prisma/schema.prisma`
- **问题**: 多个频繁查询的外键字段缺少 `@@index`：
  - `SessionMember.sessionId`, `SessionMember.agentId`
  - `Task.assignedAgentId`, `Task.sessionId`
  - `Message.sessionId`, `Message.agentId`, `Message.taskId`, `Message.replyToId`
  - 最关键：`Message(sessionId, createdAt)` 复合索引缺失，聊天路由 `findMany({ where: { sessionId }, orderBy: { createdAt: 'asc' } })` 全表扫描。
- **建议**: 添加 `@@index` 声明。

### B9. v2_schema 迁移破坏性删除 Message.content
- **文件**: `prisma/migrations/20260521093512_v2_schema/migration.sql`
- **问题**: 迁移删除 `Message.content` 列，`INSERT INTO "new_Message"` 不迁移 content → rawContent，所有现有消息内容永久丢失。`Task.updatedAt` 也无默认值。
- **建议**: 在迁移中添加数据迁移逻辑（content → rawContent）。

### B10. prisma.config.ts 引用 dotenv 但未安装
- **文件**: `prisma.config.ts:3`
- **问题**: `import "dotenv/config"` 但 `dotenv` 不在 package.json 依赖中，`prisma db seed` 会崩溃。
- **建议**: 安装 dotenv 或移除该导入。

### B11. 所有 API 端点无认证
- **文件**: 所有 16 个 API 路由文件
- **问题**: 无任何认证/授权检查。任何人可读取 API 密钥、修改 Agent 配置、删除数据、写入文件系统。
- **建议**: 如果计划公开部署，必须添加认证中间件。

---

## 🟡 IMPORTANT（建议修复）

### I1. killProcessTree 不等待完成
- **文件**: `src/lib/adapter/claude-code-adapter.ts:155-180`, `opencode-adapter.ts:132-151`
- **问题**: `spawn('taskkill', ...)` 不等待完成就设 `this.process = null`，进程可能未真正终止。
- **建议**: 用 `spawnSync` 或等待退出事件。

### I2. SSE 流中泄露 API 密钥（错误消息）
- **文件**: `src/app/api/sessions/[id]/chat/route.ts:168,358`
- **问题**: 适配器产生 `type: 'error'` 块时，错误内容可能含 API 密钥（如 401 错误），直接流式传输到客户端。
- **建议**: 清理错误消息中的敏感信息。

### I3. parseJSON 无运行时验证
- **文件**: `src/lib/orchestrator/index.ts:67-104`
- **问题**: LLM 输出解析为泛型类型无验证。`action` 字段应为 4 个字面量之一，但 LLM 可返回任意值导致静默失败。`generateRoles` 返回 `systemPrompt` 可被 LLM 操控。
- **建议**: 使用 zod 或手动检查验证解析后的 JSON 结构。

### I4. callLLM/callLLMForAnalysis 适配器泄露（无 finally 清理）
- **文件**: `src/lib/orchestrator/index.ts:13-37,39-65`
- **问题**: `adapter.send()` 抛错时 `adapter.close()` 永不调用。
- **建议**: 用 `try/finally` 确保 `adapter.close()`。

### I5. executeTaskBatch 竞态：并行任务读取部分结果
- **文件**: `src/lib/orchestrator/index.ts:157-201`
- **问题**: `Promise.all` 并行运行所有任务，但依赖任务可能在依赖项写入 `results` Map 前读取空值，违背依赖系统设计。
- **建议**: 按 batch 分组顺序执行，每批内并行。

### I6. LLMAdapter AbortController 实例级共享
- **文件**: `src/lib/adapter/llm-adapter.ts:8`
- **问题**: `abortController` 初始化一次，`close()` 后信号永不恢复，并发调用共享同一 AbortController。
- **建议**: 在 `send()` 开头创建新 AbortController。

### I7. LLMAdapter 错误作为流块而非抛出
- **文件**: `src/lib/adapter/llm-adapter.ts:56-58`
- **问题**: 错误 yield 为 `{ type: 'error' }`，chat 路由将其与 text 内容混合存储为"Agent 结果"。
- **建议**: 统一错误处理方式。

### I8. Session Lock 超时竞态条件
- **文件**: `src/app/api/sessions/[id]/chat/route.ts:19-45`
- **问题**: 前一请求超时后继续执行，但超时 Promise 仍在运行；`setTimeout` 未清理；abort 处理器释放锁会绕过序列化保证。
- **建议**: 超时时清理 abort 监听器；清除超时计时器；abort 不应释放锁。

### I9. request.json() 在锁获取后调用
- **文件**: `src/app/api/sessions/[id]/chat/route.ts:47`
- **问题**: 无 try/catch 包裹，客户端中止时 JSON 解析失败导致未处理的 Promise 拒绝，锁不释放。
- **建议**: 在 try/catch 中包裹，出错时释放锁。

### I10. 竞态条件：useChat 重复发送
- **文件**: `src/lib/hooks/use-chat.ts:36-133`
- **问题**: `send` 函数无防重复发送守卫，两次快速点击创建两个 fetch，导致消息重复和流文本交错。
- **建议**: 用 `useRef<boolean>` 作为同步守卫。

### I11. 对话框关闭时状态未重置（数据泄露）
- **文件**: `src/components/create-agent-dialog.tsx:62-74`
- **问题**: 编辑 Agent A 后关闭，再打开创建新 Agent，表单仍显示 A 的数据含 API key。
- **建议**: 打开且无 editAgent 时调用 reset()。

### I12. useChat SSE JSON.parse 无 try-catch
- **文件**: `src/lib/hooks/use-chat.ts:79`
- **问题**: 格式错误的 JSON 或 SSE 注释行（`:` 前缀）导致 parse 抛出异常，终止整个流。
- **建议**: try-catch 包裹，跳过无法解析的行。

### I13. 消息 role 字段未验证
- **文件**: `src/app/api/sessions/[id]/messages/route.ts:36-54`
- **问题**: `role` 由客户端控制无验证，可伪造 `orchestrator`/`system`。`agentId` 可引用任意 Agent。`taskId` 可跨会话。
- **建议**: 验证 role 为允许值；验证 agentId 为会话成员；验证 taskId 属于此会话。

### I14. delegateToAgent/handleOrchestratorChat 硬编码 permissionMode
- **文件**: `src/app/api/sessions/[id]/chat/route.ts:358,432`
- **问题**: 委派 Agent 和 Orchestrator 聊天都硬编码 `permissionMode: 'default'`，忽略会话实际设置。
- **建议**: 使用 session 的 permissionMode。

### I15. LLM 提示注入
- **文件**: `chat/route.ts:452-456`, `recommend-agents/route.ts:23-36`
- **问题**: 用户消息直接插入 LLM prompt 无转义，恶意用户可覆盖系统指令，控制 Agent 配置/推荐。
- **建议**: 结构化分离用户输入与指令。

### I16. Content-Disposition 头注入
- **文件**: `src/app/api/sessions/[id]/files/[filename]/route.ts:22`
- **问题**: `filename` 直接插入 HTTP 头未转义，可能注入任意头部或响应拆分。
- **建议**: 转义或 URL 编码 filename。

### I17. workspace.ts 审计用 mtimeMs 不可靠
- **文件**: `src/lib/workspace.ts:106-129`
- **问题**: `cpSync` 设置新 mtime，导致所有文件显示为"已修改"；`diffFileLists` 的 `modified` 始终为空。
- **建议**: 用内容 hash 比较而非 mtime。

### I18. ClaudeCodeAdapter.close() 基于子字符串检查删目录
- **文件**: `src/lib/adapter/claude-code-adapter.ts:184`
- **问题**: `workDir.includes('agenthub-')` 是弱启发式，路径中含该字符串的其他目录会被误删。空 `catch {}` 吞噬错误。
- **建议**: 验证路径在 `workspaces` 目录下。

### I19. 提供商导入允许设置任意 Agent 凭证
- **文件**: `src/app/api/providers/import/route.ts:12-21`
- **问题**: 任何客户端可为任何 Agent 设置 baseUrl/apiKey，包括预设 Agent，可重定向 API 调用到恶意服务器。
- **建议**: 验证修改权限；防止修改预设 Agent。

### I20. Scheduler topologicalSort 修改输入数组
- **文件**: `src/lib/orchestrator/scheduler.ts:53-54,108`
- **问题**: 修改传入的 tasks 数组对象属性（batch、dependencies），调用者可能不知对象被修改。
- **建议**: 返回新对象而非修改输入。

### I21. 未使用 handleExecution 函数（~200行死代码）
- **文件**: `src/app/api/sessions/[id]/chat/route.ts:499-698`
- **问题**: 带 eslint-disable 注释的大函数，从未调用。
- **建议**: 移除或移到单独模块标注 TODO。

### I22. useSessions.create/remove 缺少错误处理
- **文件**: `src/lib/hooks/use-sessions.ts:24-39`
- **问题**: create 乐观更新本地状态，服务端失败则出现幽灵会话；remove 有竞态（activeId 从闭包读旧 sessions）。
- **建议**: 检查 res.ok；用 setSessions 函数形式获取更新列表。

### I23. providers/route.ts 使用同步文件系统调用
- **文件**: `src/app/api/providers/route.ts:2-3`
- **问题**: `readFileSync` 阻塞事件循环，高并发时影响性能。
- **建议**: 用 `fs/promises` 异步 API。

### I24. Recent-dirs DELETE 从请求体读 ID
- **文件**: `src/app/api/recent-dirs/route.ts:28-36`
- **问题**: DELETE 请求体是 HTTP 反模式，很多客户端/代理不转发。
- **建议**: 用查询参数或路径参数。

---

## 🔵 SUGGESTION（可选改进）

### S1. Prisma schema String 字段应改为 enum
- Session.type/phase、Agent.platform/status、Task.status、Message.role 等应使用 Prisma enum 约束有效值。

### S2. JSON 字符串字段未验证
- `tools`/`capabilities`/`dependencies`/`declaredFiles` 存为 JSON String，chat 路由 `JSON.parse` 无 try-catch，格式错误会导致崩溃。

### S3. Schema 缺少字段长度约束
- `systemPrompt`、`rawContent`、`apiKey` 等无最大长度。

### S4. tsconfig target ES2017 过时
- Next.js 16 需要 Node.js 18+，应使用 ES2022+。

### S5. package.json 缺少 test 脚本
- 应添加 `"test": "vitest run"`。

### S6. MessageContent 每次重渲染重新解析消息
- `parseMessage(msg.rawContent)` 在渲染时调用，应 useMemo 或存储解析结果。

### S7. 自动滚动在 SSE 流期间不断触发
- `useEffect([messages, streaming])` 导致持续滚动，用户无法向上阅读。
- 建议：仅在 messages.length 变化时滚动，添加"回到底部"按钮。

### S8. 聊天输入在 SSE 流期间禁用
- IM 界面应允许用户在 Agent 回复时撰写新消息，应分离"发送中"和"流式传输中"状态。

### S9. Dialog 缺少焦点陷阱和 ARIA 属性
- 自定义 Dialog 无 `role="dialog"`、`aria-modal`、焦点陷阱、焦点恢复、滚动锁定。
- 建议：使用 Radix/Aria Dialog 基元。

### S10. Session 侧边栏项不可键盘聚焦
- `<div onClick>` 无 tabIndex、role、onKeyDown，键盘用户无法导航。

### S11. 标签未关联表单控件
- `<label>` 无 htmlFor，点击标签不聚焦输入。

### S12. Agent 面板 Tab 缺少 ARIA 角色
- 无 `role="tablist"`/`role="tab"`/`role="tabpanel"`/`aria-selected`。

### S13. TASK_STATUS_ICONS 用 emoji 代替可访问图标
- 屏幕阅读器读取不可预测的字符名，应加 aria-label。

### S14. CodeDiff 双 Monaco 实例
- 内联 + 全屏对话框各一个 DiffEditor，内存消耗 ~60-100MB。
- 建议：全屏时隐藏内联编辑器。

### S15. database.test.ts 不测试实际数据库操作
- 118 行测试全是字符串/对象验证，无实际 Prisma 查询、约束、级联删除测试。
- **108 测试通过的数据有误导性**。

### S16. adapter.test.ts 不测试实际适配器行为
- 只测试方法存在，不测试输出、错误处理、超时。

### S17. agent-colors.test.ts 复制实现而非导入
- `hashName`/`hexToHsl` 复制到测试文件，测试的是副本而非生产代码。

### S18. 缺少关键模块测试
- 无 workspace.ts、use-chat.ts、use-sessions.ts、API 路由、适配器测试。

### S19. prompts.test.ts 测试字符串内容而非行为
- 验证中文措辞而非结构属性，任何提示修改都会破坏测试。

### S20. vitest globals:true 无 tsconfig 类型声明
- TypeScript 不知全局变量存在，测试文件必须手动导入。

### S21. ESLint 不忽略 src/generated/
- 自动生成代码不应 lint。

### S22. 缺少 .env.example
- 新开发者不知需要哪些环境变量。

### S23. 混合语言错误消息
- 中文和英文错误消息不一致。

### S24. workspace.ts 用同步 readdirSync
- 大项目阻塞事件循环，应改用异步 API。

---

## 按优先级汇总

| 优先级 | 数量 | 关键主题 |
|--------|------|----------|
| BLOCKER | 11 | 命令注入(2), API密钥泄露(3), 批量赋值(1), 任意文件写入(1), XSS(1), 明文存储(1), 缺索引(1), 破坏性迁移(1), dotenv未安装(1), 无认证(1) |
| IMPORTANT | 24 | 进程泄露, 竞态条件, 提示注入, 头注入, 错误处理缺失, 状态泄露, 死代码, 无验证 |
| SUGGESTION | 24 | enum约束, 测试质量, 可访问性, 性能, 类型安全, 配置 |

**最紧迫修复优先级**：
1. 清理 shell:true spawn 的输入或消除 shell:true
2. 停止在 HTTP 响应中返回完整 API 密钥
3. Session PUT 白名单化更新字段
4. WebPreview iframe 内容净化
5. accept 路由用 session.projectDir 替代 process.cwd()
6. 添加数据库索引