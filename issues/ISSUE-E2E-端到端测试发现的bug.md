# 端到端测试发现的 Bug
> 创建时间: 2026-06-04 | 状态: 🟡排查中

## Bug 列表

### BUG-001: 私聊创建不添加成员 — 🟢已修复 (2026-06-04)
**严重程度**: 🔴高
**位置**: `src/app/api/sessions/route.ts:48-50`
**问题**: 创建 `type === 'private'` 的会话时，API 直接返回 session，忽略 `agentIds` 参数。导致私聊会话成员数为 0。
**复现**: `POST /api/sessions` with `{"type":"private","agentIds":["xxx"]}` → 成员数为 0
**根因**: 代码 `if (type === 'private') { return NextResponse.json(session) }` 在添加成员之前就返回了。
**修复**: private 分支加入 agentIds 处理；UI 改为一步操作；use-sessions hook 支持 agentIds 参数。
**验证**: 有 agentIds → 1 成员；无 agentIds → 0 成员。553 测试通过，build 成功。

### BUG-002: Agent 创建时 apiKey 未从 Provider 同步
**严重程度**: 🔴高
**位置**: Agent 创建流程
**问题**: 通过 UI 创建 Agent 时选择 Provider，apiKey 未写入 Agent 表。导致 LLM 调用时 apiKey 为空，返回 "[Agent 未返回有效内容]"。
**复现**: 创建 Agent → 选择 Provider → 发消息 → Agent 返回空
**根因**: Agent 表的 `apiKey` 字段默认为空字符串，创建时未从 Provider 表同步。

### BUG-003: 创建群聊 checkbox 点击无效
**严重程度**: 🟡中
**位置**: `src/components/create-group-dialog.tsx:280-286`
**问题**: 直接点击 checkbox 复选框不触发选中（计数不变），必须点击整行才能选中。
**复现**: 创建群聊 → 第二步 Agent 选择 → 直接点击 checkbox → 计数不变
**根因**: checkbox 的 `onChange` 和父 div 的 `onClick` 都调用 `toggleAgent()`，点击 checkbox 时触发两次 toggle，互相抵消。

### BUG-004: 中文标题编码乱码
**严重程度**: 🟡中
**位置**: API 响应层
**问题**: 通过 curl 或 API 创建的中文标题在响应中显示为乱码（如 "测试群聊" → "���Է���"）。浏览器中显示正常。
**复现**: `POST /api/sessions` with `{"title":"测试"}` → 响应中 title 为乱码
**根因**: Windows 终端 GBK 编码问题，非代码 bug。但影响 API 调试和搜索。

### BUG-005: 消息操作菜单 Pin 点击无效
**严重程度**: 🟡中
**位置**: `src/components/chat-area.tsx:172` + `src/components/message-action-menu.tsx:34`
**问题**: 通过 DropdownMenu 点击 "Pin 消息" 菜单项不触发 API 调用。回复/引用/复制菜单正常。
**复现**: 悬停消息 → 点击 "..." → 点击 "Pin 消息" → 无反应
**根因**: DropdownMenu 的 onClick 事件可能未正确传递到 handlePin 回调。需要进一步排查。

### BUG-006: 创建群聊 checkbox 双重触发
**严重程度**: 🟢低（与 BUG-003 同源）
**位置**: `src/components/create-group-dialog.tsx:280-286`
**问题**: 点击 checkbox 行时，checkbox 的 onChange 和父 div 的 onClick 都触发 toggleAgent()，但因为 React 的事件处理顺序，实际只触发一次（行点击正常）。直接点击 checkbox 输入框时，事件冒泡导致双重触发。
**复现**: 直接点击 checkbox 输入框 → 计数不变
**根因**: checkbox 的 onChange 和父 div 的 onClick 都调用 toggleAgent()，点击 checkbox 时先触发 onChange（toggle），再冒泡到父 div 的 onClick（再次 toggle），净效果为 0。

### BUG-007: Pin 不存在的消息返回 400 而非 404 — 🟢已修复 (2026-06-04)
**严重程度**: 🟡中
**位置**: `src/app/api/sessions/[id]/messages/[messageId]/route.ts:16-19`
**问题**: 当会话已有 10 条 Pin 消息时，尝试 Pin 不存在的消息返回 400 "每会话最多 Pin 10 条消息"，而非 404 "消息不存在"。
**复现**: 创建会话 → Pin 10 条消息 → PATCH /messages/nonexistent {isPinned:true} → 400 "每会话最多 Pin 10 条消息"
**根因**: Pin 数量限制检查（第16行）在消息存在性检查（第23行 catch）之前执行。当会话已满 10 条 Pin 时，先触发限制检查返回 400，永远到不了存在性检查。
**影响**: 错误信息误导用户，用户以为是 Pin 数量问题，实际消息根本不存在。
**修复**: 将消息存在性检查移到 Pin 数量限制检查之前。先 findFirst 确认消息存在，再检查 Pin 限制。
**验证**: 0 条 Pin 时 Pin 不存在消息 → 404；10 条 Pin 时 Pin 不存在消息 → 404；10 条 Pin 时 Pin 存在消息 → 400。571 测试通过。

### BUG-009: 进程注册表未清除系统 ANTHROPIC_BASE_URL 导致 CLI 调用错误端点 — 🟢已修复 (2026-06-04)
**严重程度**: 🔴高
**位置**: `src/lib/adapter/process-registry.ts:222-228`
**问题**: 当 Agent 没有配置 baseUrl 时，进程注册表不注入 `ANTHROPIC_BASE_URL`，CLI 继承系统环境变量（如 `https://token-plan-cn.xiaomimimo.com/anthropic`），用 Agent 的 apiKey 调用错误端点，返回 "API Error: 400 Param Incorrect"。
**复现**: 系统设 ANTHROPIC_BASE_URL → 创建无 baseUrl 的 Agent → 发消息 → 400
**根因**: `if (config.baseUrl) providerEnv.ANTHROPIC_BASE_URL = config.baseUrl` 只在有 baseUrl 时注入，但不清除系统环境的同名变量。CLI 的 `env: { ...process.env, ...providerEnv }` 会继承系统的 ANTHROPIC_BASE_URL。
**修复**: 无 baseUrl 时显式注入空字符串清除系统变量。同步更新测试。571 测试通过。
**验证**: Orchestrator 不再报 "API Error: 400 Param Incorrect"，正确分析任务并委派给子 Agent。

### BUG-010: Orchestrator Agent 模型 claude-sonnet-4-20250514 不被 CLI 识别 — 🟢已修复 (2026-06-04)
**严重程度**: 🟡中
**位置**: `src/lib/app-config.ts:56`
**问题**: Orchestrator Agent 的 `model: claude-sonnet-4-20250514` 不被 Claude Code CLI 识别，返回 "API Error: 400 Param Incorrect"。
**复现**: CLI 直接 `--model claude-sonnet-4-20250514` → 400；不指定 model → 正常
**根因**: CLI 的模型名体系与 Anthropic API 不同，`claude-sonnet-4-20250514` 是 API 模型名不是 CLI 模型名。
**修复**: 默认 model 改为空字符串，CLI 用自身默认模型。已有 Orchestrator Agent 的 model 也清空。571 测试通过。
**验证**: Orchestrator 不再报模型错误，正确完成任务分析。

### BUG-008: LLM 适配器对 Anthropic 格式 baseUrl 误用 OpenAI SDK — 🟢已修复 (2026-06-04)
**严重程度**: 🔴高
**位置**: `src/lib/adapter/llm-adapter.ts:23-25`
**问题**: 当 Agent 配置了 `baseUrl` 时（如 DeepSeek 的 `https://api.deepseek.com/anthropic`），LLM 适配器始终使用 OpenAI SDK 发送请求。但 DeepSeek 的 `/anthropic` 端点期望 Anthropic 格式，导致返回 "[Agent 未返回有效内容]"。
**复现**: 创建 Agent (platform=llm, baseUrl=https://api.deepseek.com/anthropic, model=deepseek-v4-pro) → 发消息 → 返回 "[Agent 未返回有效内容]"
**根因**: `const useOpenAI = baseUrl ? true : ...` 逻辑假设所有自定义 baseUrl 都是 OpenAI 兼容格式，但 DeepSeek 的 `/anthropic` 端点使用 Anthropic 消息格式。
**验证**: 直接用 curl 调用 DeepSeek Anthropic 端点返回 200 正常，说明 API 本身可用，是适配器选择错误。
**修复**: 新增 `detectUseAnthropic()` 函数，通过 URL 路径 `/anthropic` 检测格式。Anthropic 分支增加 `baseURL` 参数支持。导出函数供独立测试。
**验证**: DeepSeek 端到端返回 "Hello! How can I assist you today?"。18 个 URL 检测单元测试全通过。571 测试全通过。

---

## 已验证通过的功能（2026-06-04 二次 E2E 测试）

### 会话 CRUD（23 项全通过）
- [x] 创建 group 会话 — 自动添加预设 Agent 成员
- [x] 创建 private 会话（带 agentIds）— 成员数 = 1
- [x] 创建 private 会话（无 agentIds）— 成员数 = 0
- [x] 创建 orchestrator 会话 — type 正确
- [x] 归档会话 — 默认列表隐藏，归档列表可见
- [x] 置顶会话 — isPinned = true
- [x] 删除会话 — 返回 success，后续 GET 返回错误
- [x] 会话详情 — 包含 members/tasks/messages 数组
- [x] 成员数匹配 — detail.members.length = members API 返回数

### Agent CRUD（18 项全通过）
- [x] 创建 Agent — 所有字段正确存储
- [x] 重复名称 — 409 冲突
- [x] 按 ID 获取 — 包含 systemPrompt
- [x] 更新 Agent — 字段部分更新
- [x] 删除 Agent — 成功删除
- [x] 预设保护 — 403 禁止删除
- [x] 缺少必填字段 — 400 验证
- [x] HTML 标签注入 — 400 拒绝

### 消息系统（7 项全通过）
- [x] 创建 user 消息 — role/rawContent/id/createdAt
- [x] 创建 agent 消息 — agentId 存储
- [x] 获取消息 — 包含 parsed 解析结果
- [x] 回复消息 — replyToId 正确关联
- [x] 回复引用 — replyTo 嵌套返回 rawContent
- [x] 无效 replyToId — 400 拒绝
- [x] 缺少 role — 400 验证

### Pin 消息（5 项全通过 + 1 bug）
- [x] Pin 消息 — isPinned = true
- [x] Unpin 消息 — isPinned = false
- [x] Pin 上限 10 — 第 11 条返回 400
- [x] isPinned 类型验证 — 非 boolean 返回 400
- [ ] Pin 不存在的消息 — 返回 400 而非 404（BUG-007）

### 成员管理（8 项全通过）
- [x] 添加成员 — 201 + agent 数据
- [x] 重复成员 — 409 冲突
- [x] 不存在的 Agent — 404
- [x] 缺少 agentId — 400
- [x] 移除成员 — success
- [x] Orchestrator 保护 — 403 禁止移除
- [x] 移除不存在的成员 — 404
- [x] 缺少 query 参数 — 400

### Provider 系统（5 项全通过）
- [x] 创建 Provider — 201 + 字段正确
- [x] 重复名称 — 409
- [x] 列表查询 — 数组 + 包含新创建
- [x] 更新 Provider — model 字段更新
- [x] 删除 Provider — success

### 配置系统（5 项全通过）
- [x] 写入配置 — success
- [x] 读取配置 — 值正确
- [x] API Key 掩码 — 包含 *** 不显示完整值
- [x] 单 key 读取 — 值正确
- [x] 单 key 掩码 — apiKey 字段掩码

### 最近目录（5 项全通过）
- [x] 创建目录 — path + useCount = 1
- [x] Upsert — useCount 递增
- [x] 列表查询 — 包含 + useCount 正确
- [x] 删除目录 — success
- [x] 空路径拒绝 — 400

### 其他功能（17 项全通过）
- [x] 部署端点 — 模拟 URL + https
- [x] 平台检测 — has platform + cliAvailable
- [x] 推荐 Agent — recommendedIds + allAgents 数组
- [x] 空任务描述 — 400
- [x] 会话 Agent 列表 — 包含 status = idle
- [x] 未知 Provider 导入 — 404
- [x] Chat 空消息 — 400
- [x] Chat 缺少 message — 400
- [x] Chat 非字符串 — 400
- [x] Chat 不存在的会话 — 404
- [x] Chat 无效 JSON — 400
- [x] /permission auto — SSE + 持久化
- [x] /permission default — SSE + 持久化
- [x] /permission invalid — 帮助信息
- [x] Permission API 缺少字段 — 400
- [x] Permission API 不存在的会话 — 404
- [x] 消息长度 100KB — 接受 + 内容完整

### 二次测试总计
- **117 项检查通过，0 项真实失败**
- **发现 2 个新 Bug**（BUG-007, BUG-008）
- **3 项测试期望错误**（非 Bug：中文默认标题、空 systemPrompt 拒绝、parsed 是对象非数组）
