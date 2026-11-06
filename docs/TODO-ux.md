# AgentHub UX TODO

> 创建时间: 2026-11-03 | 状态: 🟢 完成（U1–U13）| 范围: 体验层，不含架构重构
> 来源: 本地 dev server 实测 30 个会话 + 1 个 14 条消息 / 3 个任务的真实执行会话 + 创建群聊与智能体页走查

## 0. 使用原则

- 先做「让演示不像调试台」的 5 件事，再做「让产品好用」的 8 件事。
- 本次不碰：多租户 / 认证 / DB 级锁 / 隔离工作区 / 任务级回滚 / 插件市场。
- 每个条目以「验收」为准，不靠「看起来好了」。
- 优先级：**P0 演示阻断 > P1 产品感 > P2 架构遗留**。
- 每个条目独立 commit，提交信息带编号，例如 `fix(ux): U1 渲染 markdown 并过滤协议标记`。
- UI 改动附 before/after 截图；改完跑 `npm test`，涉及主链路的补 E2E。
- 需要改 Prisma schema 时用 `npx prisma db push`，不要跑 `migrate dev`（项目约定）。

## 1. 总览

| ID | 优先级 | 任务 | 估时 | 状态 |
|---|---|---|---|---|
| U1 | P0 | 消息渲染：Markdown + 协议标记过滤 | 0.5–1d | ✅ |
| U2 | P0 | 会话 Header：上下文 + 阶段 stepper | 1d | ✅ |
| U3 | P0 | 系统事件抽屉 + 严重级别 | 1–2d | ✅ |
| U4 | P0 | Task 面板：批次 / 进度 / 详情分层 | 1–2d | ✅ |
| U5 | P0 | OpenCode 权限默认修正 | 2–4h | ✅ |
| U6 | P1 | 角色身份约束 | 0.5–1d | ✅ |
| U7 | P1 | 会话管理 + 信息架构 | 1–2d | ✅ |
| U8 | P1 | 视觉层级与文案统一 | 1–2d | ✅ |
| U9 | P1 | Agent 状态一致性 | 0.5d | ✅ |
| U10 | P1 | 耗时 / 等待状态可见 | 1d | ✅ |
| U11 | P1 | 首次使用引导 | 1d | ✅ |
| U12 | P1 | 历史消息卫生 | 0.5d | ✅ |
| U13 | P1 | Golden path 回归 + demo 脚本 | 1d | ✅ |
| U14 | P2 | 隔离工作区 / 任务级回滚 | 3–5d | ⬜ |
| U15 | P2 | auth + DB 锁/队列 + migration | 2–3w | ⬜ |

---

## 2. P0：演示前必须清掉（约 4–6 天）

### U1. 消息渲染：Markdown + 协议标记过滤

`P0` · `0.5–1d` · 无依赖 · **✅ 已完成（2026-11-04）**

**问题**
Agent 消息里的 `**完成了什么**`、`##`、反引号、`[DISCUSSION_SUMMARY][STATUS:success]` 原样显示；`message-parser.ts` 只抽代码块和 artifact，不渲染 Markdown。第一眼像调试输出。

**动作**
- [x] `MessageContent` 接入 `react-markdown` + `remark-gfm`（不启用 raw HTML，保持默认转义）
- [x] 渲染前过滤内部协议前缀：`[DISCUSSION_SUMMARY]`、`[STATUS:...]`、`[REPLAN]`、`[REPLAN-EXHAUSTED]`、`[PLAN_APPROVED]`、`[系统验证任务]`
- [x] 任务卡描述走同一过滤器
- [x] 不改数据库 `rawContent`，只在渲染层处理（审计 / 回放仍要原文）

**验收**
- [x] 完成报告正常显示粗体、列表、代码块
- [x] 聊天消息正文里搜不到 `**`、`##`、`[STATUS:`
- [x] 数据库中 `rawContent` 仍完整，回放不丢内容

**落地**
- 新增 `src/components/markdown-message.tsx`：`react-markdown` + `remark-gfm`，链接新窗口打开，Markdown 图片不加载（避免远程请求）
- `src/lib/message-parser.ts` 新增 `stripProtocolMarkers()`，`parseMessage()` 抽完代码块/artifact 后清理前缀
- 用户消息保持纯文本，不重解释用户输入；代码块与 Diff/预览/文件卡仍走原有组件
- 新增 `tests/markdown-message.test.ts` + `message-parser` 协议过滤用例
- 验证：`npm test` **1577 passed / 3 skipped**，`npm run build` 通过，改动文件 ESLint 0 error
- 说明：工具调用卡里的原始 JSON / `list_files` 输出仍可能包含 Markdown 源文本，这是原始工具输出，不在本条目范围内

**涉及**
`src/components/chat-area.tsx`、`src/components/markdown-message.tsx`、`src/lib/message-parser.ts`、`src/components/agent-panel.tsx`、`src/app/globals.css`

---

### U2. 会话 Header：上下文 + 阶段 stepper

`P0` · `1d` · 无依赖 · **✅ 已完成（2026-11-04）**

**问题**
聊天头部只显示「群聊」。项目目录、权限模式、当前批次、当前任务、已耗时都不在视野里。真实会话里出现过 Agent 把文件写到 `D:\tmp-agenthub-i028` 而不是项目根目录，用户只能从一条纠偏消息里发现。

**动作**
- [x] Header 常驻显示：`projectDir`（hover 全路径 / 一键复制）、权限模式、当前阶段
- [x] 阶段 stepper：对齐 → 拆解 → 执行 → 完成，标出当前步（审计无独立 phase，作为执行期常驻标记「每批审计」，不伪造状态）
- [x] 显示当前执行 Agent + 当前 task（从 tasks API 取，活跃阶段 5s 轮询，页签隐藏时暂停）
- [x] 显示已耗时 + 停止按钮
- [x] 合并底部那条小的 phase 提示，避免两处重复

**验收**
- [x] 不进详情页就能回答：写哪、什么权限、到哪步、谁在干、跑了多久
- [x] 切换项目目录 / 权限模式后 Header 立即更新（`/permission` 本地立即更新，目录在重新进入会话时刷新）

**落地**
- 新增 `src/components/session-header.tsx`：stepper、项目目录复制、权限模式、待批数量、当前任务/Agent、耗时、停止
- `src/components/chat-area.tsx`：接入会话快照、成员 id→name、任务轮询、`awaitingInput` 实时子步骤、底部重复 phase 条移除
- 刷新后 `useChat.phase` 可能停在 idle，用 `/api/sessions/[id]` 的 `phase/phaseStep` 快照兜底
- 任务计时用 `in_progress` 任务的 `updatedAt`；无活跃任务时显示「等待下一批 / N 个待执行」
- 新增 `tests/session-header.test.ts`（stepper 映射、耗时格式、三种 Header 渲染）
- 验证：`npm test` **1583 passed / 3 skipped**，`npm run build` 通过，改动文件 ESLint 0 error（2 条既有 img warning）
- 备注：1024px 宽度下 Header 会换行，已验证无横向溢出

**涉及**
`src/components/chat-area.tsx`、`src/components/session-header.tsx`、`tests/session-header.test.ts`

---

### U3. 系统事件抽屉 + 严重级别

`P0` · `1–2d` · 依赖 U1 的过滤规则 · **✅ 已完成（2026-11-04）**

**问题**
warning / audit / schema / correction 和用户任务、Agent 交付物是同样权重的聊天气泡。一个 3 任务会话里连续 4 条紫色警告，真正交付被淹没。

**动作**
- [x] 新增系统事件分类（客户端 classifier，覆盖 audit / schema / correction / replan / timeout / error）
- [x] 聊天里只留一行摘要，例如：「系统事件 · 6 条 · 执行纠偏 · 查看全部」
- [x] 详情进右侧「系统事件」抽屉：时间、类型、严重级别、任务、Agent、证据、原始消息
- [x] 同类告警合并计数；只有 error 用红色高亮，warn 用琥珀色
- [x] 审计证据不丢，只是从主聊天流里降噪；`rawContent` 原样保留

**验收**
- [x] 正常 3 任务跑完，聊天里系统事件 ≤ 2 条（实测该会话从 4 条紫色警告合并为 1 行）
- [x] 所有 warning / audit / schema 都能在抽屉里追到（本会话 9 条，含任务轨迹）
- [x] 用户不需要读内部字段就能知道「发生了什么事、要不要处理」；内部标签从展示文本移除，原文留在「原始内容」

**落地**
- 新增 `src/lib/system-events.ts`：`classifySystemMessage` / `collectSystemEvents` / `groupMessagesForChat`
- 新增 `src/components/system-event-notice.tsx`：连续系统事件合并为一行，显示条数、最新标题/摘要、查看全部
- 新增 `src/components/system-event-drawer.tsx`：右侧 Sheet，按时间倒序，含严重级别、类型、时间、Agent、task、详情、原始内容
- `SessionHeader` 增加「系统事件 N」入口；`chat-area.tsx` 用 `groupMessagesForChat` 替换原始消息流，抽屉汇总消息事件 + `Task.trace` 异常（去重）
- 新增 `tests/system-events.test.ts`、`tests/system-event-notice.test.ts`，并扩展 Header 测试
- 验证：`npm test` **1599 passed / 3 skipped**，`npm run build` 通过，改动文件 ESLint 0 error（2 条既有 img warning）
- 备注：聊天行的「N 条」是当前连续块的消息事件数；抽屉的「共 N 条」还包含任务轨迹，二者口径不同

**涉及**
`src/lib/system-events.ts`、`src/components/system-event-notice.tsx`、`src/components/system-event-drawer.tsx`、`src/components/chat-area.tsx`、`src/components/session-header.tsx`、`tests/system-events.test.ts`、`tests/system-event-notice.test.ts`

---

### U4. Task 面板：批次 / 进度 / 详情分层

`P0` · `1–2d` · 依赖 U3 的事件分类 · **✅ 已完成（2026-11-04）**

**问题**
`[系统验证任务] 验证以下代码任务...` 整段 prompt 被做成任务卡；`trace(6)` 里是巨大的 `list_files` 输出；3 个任务没有批次和总进度，只有零散卡片；默认 tab 还是 Agents，Tasks 藏在第二个 tab。

**动作**
- [x] 按 batch 分组，顶部显示 done / failed / blocked / pending 总数（batch 从 `dependencies` 推导，不新增 schema）
- [x] 任务卡只显示标题（`line-clamp-2`），点击展开完整描述 + 声明文件 + 依赖
- [x] `trace` 进 Dialog，默认折叠，最多渲染 120 条 + 下载 JSON
- [x] 系统验证任务按 `[系统验证任务]` 前缀识别，单独放「系统校验」区，不计入用户任务进度
- [x] 默认 tab 改为 Tasks

**验收**
- [x] Tasks tab 一眼看懂 `1/2`、失败 1、批次 1/2、系统校验 0/1
- [x] 不再出现整段系统 prompt 作为任务卡；折叠标题为「产出物验证 · N 项」
- [x] trace 不再撑爆面板，长轨迹可下载
- [x] 系统校验与用户任务视觉上可区分（虚线卡片 + 系统校验 badge）

**落地**
- 新增 `src/lib/task-board.ts`：系统任务识别、标题截断、依赖解析、容错拓扑分批、用户/系统任务拆分、进度统计
- 新增 `src/components/task-card.tsx`：折叠标题、展开详情、声明文件/依赖、trace 入口、重做
- 新增 `src/components/task-trace-dialog.tsx`：人类可读轨迹（最多 120 条）+ 下载 JSON
- `src/components/agent-panel.tsx`：默认 Tasks、批次分组、顶部进度、系统校验独立区、trace 改 Dialog
- `src/components/chat-area.tsx` / `session-header.tsx`：Header 进度只算用户任务，系统校验单独显示（`任务 1/2 · 系统校验 1`）
- 新增 `tests/task-board.test.ts`、`tests/task-card.test.ts`；扩展 Header 测试
- 验证：`npm test` **1612 passed / 3 skipped**，`npm run build` 通过，改动文件 ESLint 0 error（2 条既有 img warning）
- 备注：依赖缺失/环依赖时 fail-open 到同批，不阻塞任务板渲染；未修改 Prisma schema

**涉及**
`src/lib/task-board.ts`、`src/components/task-card.tsx`、`src/components/task-trace-dialog.tsx`、`src/components/agent-panel.tsx`、`src/components/chat-area.tsx`、`src/components/session-header.tsx`、`tests/task-board.test.ts`、`tests/task-card.test.ts`

---

### U5. OpenCode 权限默认修正

`P0` · `2–4h` · 无依赖 · **✅ 已完成（2026-11-04）**

**问题**
创建群聊默认选中「默认模式」，但灰色小字写着：OpenCode 在 headless 下无法弹确认，写文件 / 执行命令会被拒绝，要写文件得选自动模式。默认路径直接通向失败。

**动作**
- [x] 选中 OpenCode Agent 时强制切 auto；默认模式按钮直接禁用，不是只留小字
- [x] 创建群聊页在 Agent 行展示 `OpenCode · 自动` badge；选中后展示风险说明
- [x] 在 Header 常驻显示当前权限模式（U2）
- [x] 文案明确说明：自动模式会直接写文件/执行命令，不再逐次确认
- [x] 已有会话如果「默认模式 + OpenCode 成员」，聊天页常驻风险条 + 一键切换自动模式
- [x] 新增/编辑/导入 Agent 后触发 `agenthub:members-changed`，风险条即时刷新

**验收**
- [x] 选 OpenCode + 默认模式不会静默写失败：默认按钮禁用，创建请求强制 `permissionMode: auto`
- [x] 用户明确知道自己在授权什么：Agent badge、风险 banner、创建按钮都显示「自动模式」
- [x] 已有会话切换 Agent 平台时给出同样提示：默认/OpenCode 会话顶部风险条可直接切换

**落地**
- `src/lib/permission-mode.ts`：`isOpenCodePlatform` / `requiresAutoForOpenCode` / `resolveSessionPermissionMode` / `needsOpenCodePermissionWarning`
- `src/components/create-group-dialog.tsx`：OpenCode badge、默认模式禁用、自动模式强制、风险 banner、创建按钮显示实际模式
- `src/components/chat-area.tsx`：默认 + OpenCode 成员时显示风险条；「切换自动模式」PUT `/api/sessions/[id]` 并同步 Header
- `src/components/agent-panel.tsx`：新增/编辑/导入 Agent 后派发 `agenthub:members-changed`；ChatArea 监听并刷新成员
- 新增 `tests/permission-mode.test.ts`；UI 接线守卫增加 U5 断言
- 验证：`npm test` **1618 passed / 3 skipped**，`npm run build` 通过，改动文件 ESLint 0 error（2 条既有 img warning）
- 实测：创建群聊选中 OpenCode Orchestrator → 风险 banner + `创建群聊 (1 人 · 自动模式)`；把测试会话切到 default → 聊天顶部风险条出现，点击切换后 DB 回到 auto、风险条消失
- 未改 Prisma schema，权限仍是 Session 级字段

**涉及**
`src/lib/permission-mode.ts`、`src/components/create-group-dialog.tsx`、`src/components/chat-area.tsx`、`src/components/agent-panel.tsx`、`tests/permission-mode.test.ts`

---

## 3. P1：产品感与信任（约 6–9 天）

### U6. 角色身份约束

`P1` · `0.5–1d` · **✅ 已完成（2026-11-04）**

**问题**：群里有前端 / 后端 / Orchestrator，但 Agent 第一句是「我是 opencode，一个命令行 AI 编程助手」，CLI 默认自我介绍压过角色 system prompt。

**动作**
- [x] 在 system prompt 最前面加 `<identity>` 块，强制角色名、职责、禁止自称 CLI
- [x] 新会话首条消息按角色名自我介绍（prompt 约束 + 展示层兜底）
- [x] 切换平台 / 角色 / systemPrompt 时 invalidate `cliSessionId`，避免旧身份残留
- [ ] 用 3 个全新会话回归（Claude Code / OpenCode 各至少 1 个）——未跑真实 CLI，避免消耗额度；已用 prompt 组装单测 + 旧会话展示回归覆盖
- [x] 讨论路径补上 systemPrompt（根因：`runDiscussion` 之前只传 user prompt，OpenCode agent 文件被写成空提示）

**验收**：新群聊第一条 Agent 消息不再出现「我是 opencode」；角色名与群成员一致。旧会话展示层也已把已知 CLI 自我介绍改写为角色名。

**落地**
- 新增 `src/lib/orchestrator/agent-identity.ts`：`buildAgentIdentity` / `buildAgentSystemPrompt`，身份块放在 behavior 与角色 prompt 之前
- 新增 `src/lib/agent-identity.ts`：`normalizeAgentSelfIntro` 展示层兜底，只改写消息开头的 CLI 自我介绍，raw 原文不变
- `src/lib/orchestrator/index.ts`：
  - `executeTaskBatch` / `executeSingleAgent` 使用 `buildAgentSystemPrompt`
  - `runDiscussion` 把 `systemPrompt` 传给 adapter（修复 OpenCode agent 文件空提示的根因）
  - behavior 规则改为「初次对话时用角色名介绍，不要自称 CLI」
- `src/app/api/agents/[id]/route.ts`：名字/systemPrompt/platform 变更时调用统一入口 `invalidateAgentCliSessions`
- `src/lib/services/cli-session.ts`：新增 `invalidateAgentCliSessions`，事务内清 SessionMember + Task 的 `cliSessionId`；架构守卫通过
- 新增 `tests/agent-identity.test.ts`、`tests/api-agents-identity-invalidation.test.ts`、`tests/cli-session-agent-invalidation.test.ts`；扩展 `runDiscussion` 回归
- 验证：`npm test` **1632 passed / 3 skipped**，`npm run build` 通过，改动文件 ESLint 0 error（4 条既有 warning：2 条 img + 2 条 orchestrator/index 未使用符号）
- 实测：旧会话 `3aed...` 的「我是 opencode」已显示为 `Orchestrator：我能帮你：...`，无 console error
- 建议：提交前各跑一次 Claude Code / OpenCode 新会话冒烟，确认实际模型输出也遵守身份块

**涉及**
`src/lib/orchestrator/agent-identity.ts`、`src/lib/agent-identity.ts`、`src/lib/orchestrator/index.ts`、`src/components/chat-area.tsx`、`src/app/api/agents/[id]/route.ts`、`src/lib/services/cli-session.ts`、`tests/agent-identity.test.ts`

---

### U7. 会话管理 + 信息架构

`P1` · `1–2d` · **✅ 已完成（2026-11-04）**

**问题**：30 个会话里大量「新会话」「私聊: 前端工程师」重名；没有重命名、批量归档/删除、按项目分组；点会话卡片进 `/projects/{id}`，点「进入」才进聊天，Session / Project 概念混。

**动作**
- [x] 会话重命名（侧栏/工作区，统一校验：非空、≤120 字符、UTF-8）
- [x] 批量归档 / 删除（两侧栏均支持管理态多选；删除逐条复用现有 DELETE，失败项保留）
- [x] 按项目 / 时间分组，列表密度提高（置顶单独成组；项目按 `projectDir`，空目录归「未绑定项目」）
- [x] 自动标题：首条需求确定性截断，只覆盖占位标题，不覆盖手动改名
- [x] 会话卡片直接进聊天，另设「详情」进 `/projects/{id}`
- [x] 删除仍保留二次确认（Dialog，替代 `window.confirm`）

**验收**：30+ 会话可通过搜索/分组快速定位；重名会话可通过标题、项目、时间区分；卡片主体进聊天、菜单「详情」进项目页，符合直觉。

**落地**
- 新增 `src/lib/session-list.ts`：`deriveSessionTitle`、`isPlaceholderSessionTitle`、`filterSessions`、`groupSessions`（time/project、置顶组、自然日分桶）
- 新增 `src/lib/services/session-title.ts`：首条用户消息自动命名；仅占位标题、仅首条消息、失败不阻塞聊天
- `src/app/api/sessions/[id]/chat/route.ts`：创建用户消息前调用自动命名
- `src/app/api/sessions/[id]/route.ts`：标题 trim/非空/长度/编码校验
- `src/app/api/sessions/route.ts`：修正 `?archived=true` 语义——只返回已归档会话（此前返回全部，导致首页「已归档」计数等于会话总数）
- `src/lib/hooks/use-sessions.ts`：新增 `rename` / `removeMany` / `archiveMany`；监听 `agenthub:sessions-changed`
- `src/lib/hooks/use-chat.ts`：发送成功后派发 `agenthub:sessions-changed`，侧栏立即刷新自动标题
- `src/components/session-sidebar.tsx`：搜索、时间/项目切换、紧凑行、管理态多选、批量归档/删除、操作菜单
- `src/app/(dashboard)/page.tsx`：会话卡片主体进聊天、「详情」菜单进项目页、进行中/已归档双视图、分组、批量操作
- 新增 `session-actions-menu.tsx`、`session-rename-dialog.tsx`、`session-confirm-dialog.tsx`
- 新增 `tests/session-list.test.ts`、`tests/session-title.test.ts`；扩展 `api-sessions-id`、`api-sessions-list`、`ui-regression-guards`
- 验证：`npm test` **156 files / 1652 passed / 3 skipped**，`npm run build` 通过，改动文件 ESLint 0 error
- 实测（Playwright + 临时会话，验证后已删除）：
  - 首页 13 项通过：搜索、项目分组、重命名、卡片进聊天、详情进项目页、批量归档/恢复、删除确认取消/确认
  - 侧栏 10 项通过：搜索、项目分组、重命名、批量归档、首页恢复、单条删除取消、清理
  - 自动标题 DB 冒烟：`新会话` + 首条「帮我写一个 Python 计算器，支持加减乘除」→ 标题同步更新
  - 归档计数：进行中 31 → 30，已归档 0 → 1，删除后回到 30/0
  - 无 console error；dev server 已停止
- 未改 Prisma schema，未改 `Message.rawContent`；未提交

**涉及**
`src/lib/session-list.ts`、`src/lib/services/session-title.ts`、`src/lib/hooks/use-sessions.ts`、`src/lib/hooks/use-chat.ts`、`src/app/api/sessions/route.ts`、`src/app/api/sessions/[id]/route.ts`、`src/app/api/sessions/[id]/chat/route.ts`、`src/components/session-sidebar.tsx`、`src/components/session-actions-menu.tsx`、`src/components/session-rename-dialog.tsx`、`src/components/session-confirm-dialog.tsx`、`src/app/(dashboard)/page.tsx`、`src/app/chat/page.tsx`

---

### U8. 视觉层级与文案统一

`P1` · `1–2d` · **✅ 已完成（2026-11-04）**

**问题**：用户消息是整块高饱和蓝，视觉权重高于 Agent 交付；字体偏小（10–12px）；中英混用（Agents/Tasks/群聊/会话/项目）；没有时间戳；空状态和首次引导弱。

**动作**
- [x] 用户气泡 `max-w` 收到 60%（移动端 85%），降低饱和度
- [x] Agent 气泡加宽到 86%，正文 14px / 代码块独立深色层级
- [x] 补时间戳（消息头显示 HH:mm，hover 显示完整日期时间）
- [x] 字号下限 12px，正文 13–14px；清掉组件内 9/10/11px 正文
- [x] 统一术语：Tasks → 任务、Agents → 智能体；保留 Orchestrator / OpenCode / Claude Code
- [x] 统一空状态：无会话 / 无任务 / 无消息 / 无系统事件都给一句下一步

**验收**：截图看起来像产品而不是调试台；用户消息不再压过交付物。

**落地**
- 新增 `src/components/empty-state.tsx`：统一「现状 + 下一步」空状态
- 新增 `src/lib/message-time.ts`：消息时钟与完整时间格式化
- `chat-area.tsx`：
  - 用户气泡改用低饱和蓝灰、桌面 60% / 移动 85%
  - Agent 气泡桌面 86%、`rounded-xl`、细边框；消息头带时间戳
  - 正文 `text-sm leading-relaxed`，代码块保留独立深色边框层级
  - 聊天区 `max-w-4xl`，消息间距加大
  - 无会话 / 无消息空状态；成员名优先显示中文名
- `agent-panel.tsx`：Agents/Tasks → 智能体/任务；空状态统一；批/系统校验字号 12px
- `task-card.tsx` / `task-trace-dialog.tsx`：`trace(n)` → `轨迹 n`；字号 12px
- `system-event-notice.tsx` / `system-event-drawer.tsx`：字号 12px、`task` → `任务`、空状态统一
- `session-sidebar.tsx` / 工作区：空状态统一，侧栏元信息字号 12px
- `chat-fab.tsx` / `message-action-menu.tsx`：术语统一；Pin → 置顶
- `create-group-dialog.tsx` / `create-agent-dialog.tsx` / `setup-wizard.tsx`：可见文案 Agent → 智能体
- `session-header.tsx` / `projects/[id]/page.tsx`：Agent → 智能体，补 hover 完整时间
- 验证：`npm test` **157 files / 1658 passed / 3 skipped**，`npm run build` 通过，改动文件 ESLint 0 error（3 条既有 warning：2 img + 1 unused）
- 实测：1440×1000 截图检查消息气泡宽度/字号/时间戳/空状态；`Agents`/`Tasks` 已消失，`time` 元素 hover title 为完整时间；无 console error
- 未改 `Message.rawContent` / Prisma schema；未跑真实 Agent 对话

**涉及**
`src/components/chat-area.tsx`、`src/components/empty-state.tsx`、`src/lib/message-time.ts`、`src/components/agent-panel.tsx`、`src/components/task-card.tsx`、`src/components/task-trace-dialog.tsx`、`src/components/system-event-notice.tsx`、`src/components/system-event-drawer.tsx`、`src/components/session-sidebar.tsx`、`src/components/chat-fab.tsx`、`src/components/message-action-menu.tsx`、`src/components/session-header.tsx`、`src/components/create-group-dialog.tsx`、`src/components/create-agent-dialog.tsx`、`src/components/setup-wizard.tsx`、`src/app/(dashboard)/page.tsx`、`src/app/(dashboard)/projects/[id]/page.tsx`、`src/app/(dashboard)/analytics/dfg-graph.tsx`

---

### U9. Agent 状态一致性

`P1` · `0.5d` · **✅ 已完成（2026-11-04）**

**问题**：智能体页的「状态」列用的是 `agent.status`，`schema.prisma` 里已标 `@deprecated`，真实状态在 `SessionMember.status`；所以页面上全是「空闲」，即使某个 Agent 正在会话里干活。

**动作**
- [x] 智能体页不再读 `agent.status`
- [x] 改为「当前会话」：优先显示工作中的会话，否则显示最近更新的会话
- [x] 与右侧 Agent 面板的 per-session 状态口径统一
- [x] API 列表/详情不再返回 deprecated `Agent.status`

**验收**：同一个 Agent 在会话中工作时，智能体页与会话右侧面板状态一致，不再一边「工作中」一边「空闲」。

**落地**
- 新增 `src/lib/agent-presence.ts`：聚合 `SessionMember.status`，输出 `currentSession` / `workingSessionCount` / `sessionCount`；工作会话优先于最近空闲会话
- `/api/agents` 移除 `status` select，改为查询 `memberships.status + session{id,title,updatedAt}`，返回 presence 投影
- `/api/agents/[id]`、`POST /api/agents`、`/api/sessions/recommend-agents` 同步移除 deprecated `status`
- 智能体页「状态」列改为「当前会话」：
  - 工作中：绿点 + 会话标题（点击进聊天）
  - 空闲/完成/异常：gray/blue/red 点 + 状态
  - 未加入会话：明确文案
  - 多个会话显示 `共 N 个会话`
- AgentPanel 的 status 改为可选；session 成员仍显示 `SessionMember.status` 圆点，全局 fallback 不再伪造状态
- `useChatFab` / 智能体详情页移除未使用的 `status` 字段
- 新增 `tests/agent-presence.test.ts`；扩展 `recommend-agents-visibility` 与 `ui-regression-guards`
- 验证：`npm test` **158 files / 1664 passed / 3 skipped**，`npm run build` 通过，改动文件 ESLint 0 error
- 实测：临时会话把 UI 设计师的 `SessionMember.status` 置 working → 智能体页显示「工作中 + 会话标题」，右侧面板同 Agent 圆点为绿色；删除临时会话后恢复 30 个进行中 / 0 个归档
- 未改 Prisma schema，未改 `Agent.status` 列（仅停止读取）

**涉及**
`src/lib/agent-presence.ts`、`src/app/api/agents/route.ts`、`src/app/api/agents/[id]/route.ts`、`src/app/api/sessions/recommend-agents/route.ts`、`src/app/(dashboard)/agents/page.tsx`、`src/app/(dashboard)/agents/[id]/page.tsx`、`src/components/agent-panel.tsx`、`src/lib/hooks/use-chat-fab.ts`、`tests/agent-presence.test.ts`

---

### U10. 耗时 / 等待状态可见

`P1` · `1d` · **✅ 已完成（2026-11-04）**

**问题**：长任务只有 spinner；3 分钟无输出、15 分钟单任务、50 分钟会话上限，用户不知道在等什么；没有耗时/费用感。

**动作**
- [x] Header 显示当前会话 elapsed（支持天/时/分/秒）
- [x] 等待时明确原因：等 CLI 输出 / 等权限 / 等用户 / 重试中 / 工具执行中 / 模型思考中 / 接收输出中
- [x] 每个 task 显示耗时：完成态显示总耗时，执行中每秒更新
- [x] token 成本：CLI 无法稳定取到 usage，本轮不伪造数字（留待 CLI usage 稳定后接入）

**验收**：用户随时知道「现在在等什么、等了多久」；不再出现无解释的 3 分钟静默。

**落地**
- 新增 `src/lib/elapsed.ts`：`formatElapsed` 支持 `分:秒` / `时:分:秒` / `天 时:分:秒`
- 新增 `src/lib/waiting-state.ts`：`deriveWaitingReason` 优先级为 权限 → 用户 → 重试 → 工具 → 思考 → 流式输出 → CLI
- 新增 `src/lib/task-timing.ts`：从 Task.trace 的最后一个 `start` 事件取真实开始时间；无 trace 回退 `createdAt`；`getLastTraceEvent` 用于识别重试
- `SessionHeader`：
  - 第二行增加「等待原因 + 等待时长」chip
  - 右侧增加「会话 elapsed」
  - 当前 task 计时改用 trace `start`，不再用 60s heartbeat 的 `updatedAt`
- `ChatArea`：
  - 根据 `loading / pendingPermissions / awaitingInput / thinking / streaming / running tool / retry trace` 推导等待原因
  - 等待开始时记录 `waitingSince`，结束自动清空
- `TaskCard`：
  - 新增 `TaskDuration`；完成/失败/阻塞显示「耗时」，执行中显示「已运行」并每秒刷新
  - pending 不显示耗时，避免把排队等待说成执行耗时
- 验证：`npm test` **160 files / 1675 passed / 3 skipped**，`npm run build` 通过，改动文件 ESLint 0 error（2 条既有 img warning）
- 实测（Playwright，未跑真实 Agent）：
  - 现有会话 Header 显示 `会话 34天 23:42:36`
  - TaskCard 显示 `耗时 0:32`、`耗时 0:22`
  - 拦截 chat POST 保持 pending → Header 显示「等待 CLI 输出 0:01」+ Stop 按钮
  - 随后 abort 测试请求；浏览器记录一次预期的 `Failed to fetch`，请求未到服务端，无 DB 写入
- 未改 Prisma schema / `Message.rawContent`

**涉及**
`src/lib/elapsed.ts`、`src/lib/waiting-state.ts`、`src/lib/task-timing.ts`、`src/components/session-header.tsx`、`src/components/chat-area.tsx`、`src/components/task-card.tsx`、`tests/waiting-state.test.ts`、`tests/task-timing.test.ts`、`tests/task-card.test.ts`、`tests/session-header.test.ts`、`tests/ui-regression-guards.test.ts`

---

### U11. 首次使用引导

`P1` · `1d` · **✅ 已完成（2026-11-04）**

**问题**：新用户进入工作区只看到「创建群聊 / 进入聊天」，不知道先配 CLI、选目录、对齐流程会发生什么。

**动作**
- [x] setup wizard 完成后加 3 步 checklist：配 CLI → 建群 → 说需求
- [x] 空工作区给示例 prompt / 示例项目
- [x] 首次建群时解释「对齐三拍」和「什么时候需要你确认」
- [x] 首次任务完成时提示「Diff / 产物在哪里看」

**验收**：新用户不读 README 也能完成第一个 3 任务群聊。

**落地**
- 新增 `src/lib/onboarding.ts`：3 条示例需求、3 步 checklist、两个 localStorage 提示 key
- Setup Wizard：
  - 「配置完成」不再 1.5 秒自动关闭
  - 展示 3 步 checklist（配 CLI → 建群 → 说需求）
  - 「开始使用」再进入工作区
- 空工作区：
  - 无会话时展示 3 个示例需求按钮
  - 点击示例打开创建群聊并预填需求（`initialTask`）
  - 明确提示项目目录可留空，使用默认工作目录
- 创建群聊：
  - 首次显示「对齐三拍」：产品经理确认需求 → 架构师拆解任务 → 智能体提问澄清
  - 说明哪些节点需要用户确认，以及默认权限模式会询问写文件/执行命令
  - 「知道了」或首次创建成功后写入 localStorage，不再反复提示
- ChatArea：
  - 首次出现已完成任务时显示一次性提示：Diff 可 Accept/Reject、文件卡片可下载、任务卡「轨迹」可看执行记录
  - 点击「知道了」写入 localStorage，刷新后不再显示
- 验证：`npm test` **161 files / 1680 passed / 3 skipped**，`npm run build` 通过，改动文件 ESLint 0 error（2 条既有 img warning）
- 实测（Playwright，全部 API 拦截，无 DB 写入）：
  - 空工作区展示 3 个示例需求
  - 点击示例 → 创建群聊预填需求 + 对齐三拍说明 + 目录提示
  - 关闭并重新打开后流程说明不再出现
  - Setup Wizard 完成页显示 3 步 checklist + 开始使用
  - 首次完成任务提示出现，点击「知道了」刷新后消失
  - 无 console error
- 未改 Prisma schema / `Message.rawContent`

**涉及**
`src/lib/onboarding.ts`、`src/components/setup-wizard.tsx`、`src/components/create-group-dialog.tsx`、`src/components/chat-area.tsx`、`src/app/(dashboard)/page.tsx`、`tests/onboarding.test.ts`、`tests/ui-regression-guards.test.ts`

---

### U12. 历史消息卫生

`P1` · `0.5d` · **✅ 已完成（2026-11-04）**

**问题**：旧会话里还留着「已自动清理」的越界警告，当前代码文案是「共享项目目录不自动删除，请人工确认」。消息落库后不随规则更新，用户看到的行为说明可能和当前版本矛盾。

**动作**
- [x] 采用渲染时重写（不改 DB、不新增 schemaVersion）：`rewriteHistoricalSystemCopy`
- [x] 旧「已自动清理」标成「历史记录，规则已更新」，并补当前规则
- [x] 建立约定：协议/系统提示文案变更时，同步考虑历史消息展示；禁止改 `Message.rawContent`

**验收**：用户不会因为一条旧消息误以为当前版本会自动删文件。

**落地**
- `src/lib/system-events.ts`：
  - 新增 `rewriteHistoricalSystemCopy`：检测旧「已自动清理」文案，替换为「历史记录，规则已更新：当时提示会自动清理，当前规则为「共享项目目录不自动删除，请人工确认」」
  - `SystemEvent` 增加 `historical?: boolean`
  - 消息与任务 trace 两条来源都走同一改写；`raw` 保留原文
- `SystemEventNotice`：
  - 分组中任一事件为历史记录时显示「含历史记录」badge
- `SystemEventDrawer`：
  - 历史事件显示「历史记录 · 规则已更新」badge
  - 原始内容仍可展开查看
- 约定写入 `CLAUDE.md`「历史系统消息文案」与 `AGENTS.md` 红线
- 验证：`npm test` **161 files / 1684 passed / 3 skipped**，`npm run build` 通过，改动文件 ESLint 0 error
- 实测（真实旧会话 `bfa9...`，库内 2 条旧「已自动清理」）：
  - 系统事件抽屉出现「历史记录 · 规则已更新」
  - 详情显示当前规则「共享项目目录不自动删除，请人工确认」
  - 「原始内容」仍保留旧文案
  - 聊天分组显示「含历史记录」
  - 未改任何 Message.rawContent，无 DB 写入
- 未改 Prisma schema；dev server 已停止

**涉及**
`src/lib/system-events.ts`、`src/components/system-event-notice.tsx`、`src/components/system-event-drawer.tsx`、`tests/system-events.test.ts`、`tests/system-event-notice.test.ts`、`tests/ui-regression-guards.test.ts`、`CLAUDE.md`、`AGENTS.md`

---

### U13. Golden path 回归 + demo 脚本

`P1` · `1d` · 依赖 U1–U11 · **✅ 已完成（2026-11-04）**

**固定 demo 用例**

- 建群：产品经理、架构师、前端工程师、后端工程师、测试工程师、Orchestrator
- 需求：`index.html` + `styles.css` + `app.js` 三个代码任务，禁止额外 PRD 任务
- 对齐：PM 确认 → 架构师拆解 → `确认执行`
- 成功标准：3 个用户任务 + 1 个系统验证任务全部 completed；三个文件可用

**三次连续跑**

| 运行 | 会话 | 项目目录 | 结果 |
|---|---|---|---|
| run1 | `9c8203fb-371d-4d43-a18f-e7894d36a747` | `D:/tmp-agenthub-u13/run1` | 3/3 + 系统校验 completed；index.html / styles.css / app.js |
| run2 | `fc628784-2922-4803-89b2-fd969e66af88` | `D:/tmp-agenthub-u13/run2` | 3/3 + 系统校验 completed；约 17.6 min |
| run3 | `e7b5e21f-77f4-42b0-8718-22dd64080d02` | `D:/tmp-agenthub-u13/run3` | 3/3 + 系统校验 completed；约 16.6 min |

三次都没有手工改文件；Demo 只需三次确认（PM 确认、架构师计划、执行）。生成页面均实测：新增 / 勾选 / 刷新持久化 / 删除通过，无 console error。

> run1 的自动化在重复 architect gate 处错过一次，补发「确认执行」后完成；run2/run3 用修正后的 driver 全程跑完。这是演示脚本问题，不是产品链路失败。

**边界覆盖**

- [x] 敏感路径越界：在 `U13 敏感路径验证` 会话（`e4417cc6...`）中，任务只声明 `config.txt`，但实际写了未声明的 `.env`；trace 记录 `[敏感路径越界] 本批未声明修改了敏感文件：.env。整批任务失败，未发布 result。`，任务 failed，`.env` 保留（当前规则：共享目录不自动删除）
- [x] 失败重做：同一失败任务改描述为 `config.txt` + `config.js`，redo 成功 completed；轨迹保留第一次失败记录
- [x] 权限拒绝：默认模式 + OpenCode 临时会话实测显示「当前会话包含 OpenCode 智能体，默认模式下写文件/执行命令会被拒绝」+「切换自动模式」；未跑真实 CLI
- [x] stop 后恢复：临时会话种子 in_progress 超 5 分钟后实测恢复弹窗（「发现未完成的任务 / 继续执行 / 跳过」）；停止/删除链路由 `session-stop-delete.test.ts`、`chat-recovery-route.test.ts` 自动测试覆盖；未做真实 CLI stop
- [ ] Diff 验收：当前 Agent 没有主动输出 `artifact:diff`，golden path 没有 Accept/Reject 按钮；任务级 diff / 回滚属 U14，记为已知边界

**U13 发现的真实阻塞（已修）**

1. OpenCode v2.2.5 移除 `run --dir`，适配器仍在传 → 所有 CLI 调用失败；删除该参数，改由 `spawn.cwd` + `PWD` 锚定
2. 动态 agent 文件在后台服务缓存中找不到 → 报 `Agent not found`；适配器改为 `--standalone`，每次私有 server 重读配置
3. `getOrchestratorDecision` 调 `executeSingleAgent` 没传 Orchestrator `id` → 不写 agent 文件、系统 prompt 不生效；补 `id`
4. 身份 + behavior 包装会让决策模型进入聊天人格 → `executeSingleAgent` 增加 `rawSystemPrompt`，决策/结构化调用原样使用 system prompt
5. 决策 prompt 太长会被模型忽略 JSON 约束 → 改成短 JSON-only prompt；`normalizeDecision` 容忍缺 `reason/message`、拒绝非法 action
6. 决策/结构化调用在项目目录运行会加载 `AGENTS.md/CLAUDE.md` → 带偏模型；统一使用 `tmpdir()/agenthub-analysis`
7. provider 前缀 model 被 CC-Switch 旧凭据覆盖 → `getOrchestratorAgent` 对 `provider/model` 直接使用本地 CLI 配置
8. Agent 不知道 `outputSchema`，首次不输出 JSON 导致纠偏 → 任务 prompt 增加 `[产出格式]` 提示（减少但未清零纠偏）

**验证**

- `npm test`：**161 files / 1689 passed / 3 skipped**
- `npm run build`：通过（既有 Turbopack NFT warning，数量随构建波动）
- 改动文件 ESLint：**0 error / 16 warning**
- 未改 Prisma schema；未改任何 `Message.rawContent`
- 本机 Agent 配置切换为本地 CLI：opencode 用 `opencode-go/mimo-v2.6-flash`，claude-code 用本机 `~/.claude`；原 tokenrhythm 凭据余额不足，未保留备份，恢复时从 CC-Switch/原 provider 重新取

**Demo 脚本**：`docs/demo-3min.md`；**成片**：`docs/demo/agenthub-demo-3min.mp4`（2:03，中文旁白，封面 `docs/demo/poster.jpg`）

**验收**：3 次连续跑均完成 3/3；演示使用已完成会话，不需要现场解释 `schema`、`declaredFiles`、`rawContent` 等内部字段。

**已知边界**

- Diff Accept/Reject 未在 golden path 触发（Agent 不输出 `artifact:diff`），留给 U14
- schema 纠偏仍会产生 2–6 条系统事件；run2 在聊天内合并为 2 条通知，详情进抽屉
- 单次真实链路约 16–18 分钟，3 分钟 demo 使用预跑会话
- 产品经理预设 tools 只有 `Read/Glob/Grep`；架构师若拆出写 `docs/PRD.md` 的任务会失败。Demo prompt 已明确禁止 PRD 任务；长期应在拆解 prompt 约束只读 Agent 不接写文件任务

**涉及**
`src/lib/adapter/opencode-adapter.ts`、`src/lib/orchestrator/index.ts`、`src/lib/orchestrator/prompts.ts`、`tests/opencode-adapter.test.ts`、`tests/orchestrator-agent.test.ts`、`tests/orchestrator-extended.test.ts`、`docs/demo-3min.md`、`docs/TODO-ux.md`、`PROGRESS.md`、`AGENTS.md`、`CLAUDE.md`、`README.md` / `README.en.md`、`issues/ISSUE-030-opencode-v2.2.5-cli-compat.md`

---

## 4. P2：架构遗留（本次明确不做）

### U14. 隔离工作区 / 任务级回滚

`P2` · `3–5d` · 演示后再说

`workspace.ts` 的 `createTaskWorkspace` / `takeSnapshot` / `auditTaskWorkspace` / `cleanupTaskWorkspaces` 目前生产零调用，所有 Agent 直接写共享 `projectDir`；影子 git 只能“发现越界”，不能回滚。

- [ ] 接上隔离工作区，或明确删除相关死代码
- [ ] 最低限度：给失败任务一个可预览的 diff / 快照恢复
- [ ] 在文档和 UI 里把「预留」标清楚，避免评委发现死代码

### U15. auth + DB 锁/队列 + migration

`P2` · `2–3w` · 产品化门槛

`session-lock` / `cancellation` / `process-registry` 都是进程内 Map；SQLite 单文件；无 auth middleware。本地单用户没问题，多实例 / 多用户需要换控制面。

- [ ] auth + 会话归属
- [ ] DB / Redis 级锁与队列
- [ ] migration 策略（替代 `db push`）
- [ ] 备份 / 数据保留

---

## 5. 排期建议

| 版本 | 内容 | 适合 |
|---|---|---|
| 3 天版 | U1 + U5 + U2 + U3 最小版（只做 warning 折叠） | 演示临近 |
| 6–8 天版 | 3 天版 + U4 + U6 + U9 + U8 的气泡/字号 | 一周内答辩 |
| 10–14 天版 | 全部 P0/P1（含 U13） | 还有两周 |

> 估时按顺利情况计算，不含联调、返工和演示彩排；实际预留 30–50% buffer。

P2 不进入本次排期。

## 6. 完成标准（Definition of Done）

- [x] 新用户从 0 到第一个 3 任务群聊，全程不出现原始 Markdown / 协议标记（run1–run3 实测；代码块内的 `**` 除外）
- [x] 正常跑完，聊天里系统消息 ≤ 2 条，详情可查（run2 为 2 条合并通知；12 条明细在系统事件抽屉）
- [x] Header 能回答「写哪、什么权限、到哪步、谁在干、多久」（项目目录 / 自动模式 / 四步 stepper / 3/3 / 会话耗时）
- [x] Task 面板 3/3 清晰，不再出现系统验证 prompt（系统校验单独分组 1/1）
- [x] OpenCode + 默认模式不再静默失败（风险条 + 一键切自动；headless default 仍只读，符合 U5 设计）
- [x] 连续 3 次 golden path 不翻车，3 分钟 demo 可复现（见 `docs/demo-3min.md`；Diff Accept 为已知边界，见 U13）

## 7. 附：问题 → 条目映射

| 观察到的问题 | 对应条目 |
|---|---|
| `**完成了什么**`、`##`、反引号原样显示 | U1 |
| `[DISCUSSION_SUMMARY][STATUS:success]` 泄漏 | U1 / U12 |
| 项目目录写错到 `D:\tmp-agenthub-i028`，只能从纠偏消息发现 | U2 |
| 连续 4 条紫色 warning，交付物被淹没 | U3 |
| `[系统验证任务]` 整段 prompt 变成任务卡 | U4 |
| `trace(6)` 输出巨大，面板撑爆 | U4 |
| OpenCode 默认模式写文件被拒 | U5 |
| Agent 自称「我是 opencode」 | U6 |
| 30 个重名会话，卡片进项目页而不是聊天 | U7 |
| 用户蓝色大气泡、字体小、中英混用 | U8 |
| 智能体页全部显示「空闲」 | U9 |
| 长任务无耗时、无等待原因 | U10 |
| 新用户不知道先做什么 | U11 |
| 旧「已自动清理」文案与当前规则矛盾 | U12 |
| 架构评审发现的隔离/单进程假设 | U14 / U15 |
