# AgentHub 详细测试计划

> 每个测试点都有明确的预期结果，可用于判定 PASS/FAIL。
> 测试前需要：`npm run dev` 启动服务，浏览器访问 `http://localhost:3000`。

---

## 1. 初始化

### 1.1 Setup Wizard 弹出
- **前置条件**：删除 `dev.db`，重启服务
- **操作**：访问 `http://localhost:3000`
- **预期**：
  - 页面显示 Setup Wizard（不是首页）
  - Wizard 第一步标题包含 "CLI" 或 "检测"
- **验证方式**：肉眼观察页面

### 1.2 CLI 检测
- **操作**：Setup Wizard 点击"检测"或自动检测
- **预期**：
  - 显示检测到的 CLI 路径（如 `C:\Users\...\claude.exe` 或 `claude`）
  - 或显示"未检测到"（如果未安装）
- **验证方式**：页面显示路径文本

### 1.3 Orchestrator Agent 自动创建
- **前置条件**：完成 Setup Wizard
- **操作**：`GET /api/agents?preset=true`
- **预期**：
  - 返回数组中包含 `isOrchestrator: true` 的 Agent
  - 该 Agent 的 `name` 非空
- **验证方式**：curl 或浏览器 Network 面板

### 1.4 预设 Agent 数量
- **操作**：`GET /api/agents`
- **预期**：
  - 返回数组长度 ≥ 7
  - 所有 Agent 的 `isPreset` 为 `true`
  - 包含 `name` 为中文的 Agent（如 "前端工程师"、"后端工程师"、"架构师"、"产品经理"、"测试工程师"、"UI 设计师"）
- **验证方式**：curl 返回 JSON

---

## 2. 会话管理

### 2.1 创建 Orchestrator 会话
- **操作**：点击"开始对话"按钮
- **预期**：
  - `POST /api/sessions` 返回 `201`
  - 响应 JSON 包含 `type: "orchestrator"`
  - `phase` 为 `"idle"`
  - `permissionMode` 为 `"default"`
  - 侧栏出现新会话
- **验证方式**：Network 面板 + UI 观察

### 2.2 创建群聊
- **操作**：点击"创建群聊" → 选择 2-3 个 Agent → 确认
- **预期**：
  - `POST /api/sessions` 返回 `201`
  - 响应 JSON 包含 `type: "group"`
  - `GET /api/sessions/[id]/members` 返回的成员数 = 选择的 Agent 数
  - 侧栏显示新会话，头像拼图显示最多 3 个首字母
- **验证方式**：Network 面板返回值

### 2.3 创建私聊
- **操作**：ChatFab → 选择一个 Agent
- **预期**：
  - `POST /api/sessions` 返回 `201`
  - 响应 JSON 包含 `type: "private"`
  - `GET /api/sessions/[id]/members` 返回 1 个成员
- **验证方式**：Network 面板返回值

### 2.4 会话列表显示
- **操作**：创建多个会话后观察侧栏
- **预期**：
  - 会话按时间分组显示：标题为 "今天"、"昨天"、"本周"、"更早"
  - 每个会话显示标题 + Agent 头像拼图
  - `GET /api/sessions` 返回数组，每个元素包含 `members` 数组（含 `agent.name` 和 `agent.accentColor`）
- **验证方式**：UI 观察 + API 返回

### 2.5 会话置顶
- **操作**：对一个会话点击置顶
- **预期**：
  - `PUT /api/sessions/[id]` 请求体包含 `isPinned: true`
  - `GET /api/sessions` 返回中该会话排在最前
  - 侧栏中该会话移到顶部
- **验证方式**：Network 面板 + UI 顺序

### 2.6 删除会话
- **操作**：点击会话的 "x" 按钮 → 确认删除
- **预期**：
  - 弹出确认对话框，文本包含 `确定删除会话「${title}」吗？`
  - `DELETE /api/sessions/[id]` 返回 `{ success: true }`
  - 侧栏中该会话消失
  - `GET /api/sessions` 不再包含该会话
- **验证方式**：对话框文本 + API 返回 + UI

### 2.7 会话标题编码校验
- **操作**：`POST /api/sessions` 发送包含 lone surrogate 的 title
- **预期**：
  - 返回 `400`
  - 响应包含 `error` 字段，内容含 "无效编码" 或 "UTF-8"
- **验证方式**：curl 发送畸形数据

### 2.8 私聊缺少 agentIds
- **操作**：`POST /api/sessions` 发送 `{ type: "private" }` 无 agentIds
- **预期**：
  - 返回 `400`
  - 响应包含 `error: "Private session requires at least one agentId"`
- **验证方式**：curl

---

## 3. 聊天基础

### 3.1 未选会话时显示
- **操作**：访问 `/chat`，不选择任何会话
- **预期**：
  - 聊天区显示文字 `"选择或创建一个会话"`
  - 无输入框
- **验证方式**：肉眼观察

### 3.2 发送消息
- **操作**：选择会话 → 输入 "你好" → 点击"发送"
- **预期**：
  - 用户消息立即显示在聊天区，角色标签为 `"You"`
  - `POST /api/sessions/[id]/chat` 返回 `text/event-stream`
  - SSE 流中第一个事件 `type` 为 `"status"` 或 `"text"`
  - 最终收到 `type: "done"` 事件
  - `GET /api/sessions/[id]/messages` 包含新增的 user 消息（`role: "user"`）
- **验证方式**：UI + Network EventStream + API

### 3.3 流式显示
- **操作**：发送消息后观察
- **预期**：
  - Agent 回复逐步出现（不是一次性全部显示）
  - 可能显示 thinking 指示器：`💭 ${agentId} 思考中...`
  - 流结束后 `loading` 状态变为 false
- **验证方式**：肉眼观察流式效果

### 3.4 消息复制
- **操作**：悬停 Agent 消息 → 点击复制按钮
- **预期**：
  - 按钮文字短暂变为 `"已复制"`（约 2 秒后恢复为 `"复制"`）
  - 剪贴板内容 = 消息 rawContent
- **验证方式**：按钮文字变化 + 粘贴验证

### 3.5 引用回复
- **操作**：悬停消息 → 点击回复 → 输入内容 → 发送
- **预期**：
  - 输入框上方出现回复预览条：`回复 ${role}: ${content前60字}...`
  - `POST /api/sessions/[id]/chat` 请求体包含 `replyToId`
  - `GET /api/sessions/[id]/messages` 中新消息包含 `replyToId` 字段
  - 聊天区显示引用预览（灰色小字 + 左边框）
- **验证方式**：UI + API 返回

### 3.6 重新生成
- **操作**：悬停 Agent 消息 → 点击重新生成
- **预期**：
  - `POST /api/sessions/[id]/chat` 请求体包含 `regenerate: "${messageId}"`
  - SSE 流中收到 `type: "status", content: "重新生成中..."`
  - 最终 `type: "done"` 事件包含 `messageId` 字段
  - 原消息内容被更新（不是新增消息）
  - `GET /api/sessions/[id]/messages` 中该 message 的 `rawContent` 已变
- **验证方式**：Network EventStream + API

### 3.7 Pin 消息
- **操作**：悬停消息 → 点击 Pin
- **预期**：
  - `PATCH /api/sessions/[id]/messages/[messageId]` 发送
  - 消息左上角出现 📍 图标（amber 色）
  - `GET /api/sessions/[id]/messages` 中该消息 `isPinned: true`
- **验证方式**：UI 图标 + API 返回

### 3.8 取消 Pin
- **操作**：再次点击 Pin
- **预期**：
  - 📍 图标消失
  - `isPinned` 变为 `false`
- **验证方式**：UI + API

### 3.9 输入框占位符
- **操作**：观察空输入框
- **预期**：
  - 占位符文字为 `"输入消息... (/ 命令，@Agent名 指定执行，@所有人 讨论)"`
- **验证方式**：肉眼观察

### 3.10 发送按钮
- **操作**：观察发送按钮
- **预期**：
  - 文字为 `"发送"`
  - 输入为空时应禁用（或发送后清空输入框）
- **验证方式**：肉眼观察

---

## 4. @提及与讨论

### 4.1 @提及列表弹出
- **操作**：在输入框输入 `@`
- **预期**：
  - 弹出成员列表下拉框
  - 列表包含当前会话的所有非 Orchestrator Agent
  - 底部有 `"所有人"` 选项，子文字为 `"让所有 Agent 参与讨论"`
- **验证方式**：UI 观察

### 4.2 @指定 Agent
- **操作**：`@前端工程师 帮我写一个按钮组件` → 发送
- **预期**：
  - `POST /api/sessions/[id]/chat` 请求体包含 `targetAgent: "前端工程师"`
  - SSE 流中 `agentId` 为 `"前端工程师"`
  - 最终 `type: "done"` 收到
- **验证方式**：Network 面板请求体 + SSE 事件

### 4.3 @所有人
- **操作**：`@所有人 讨论一下项目架构` → 发送
- **预期**：
  - `POST /api/sessions/[id]/chat` 请求体包含 `mentionAll: true`
  - SSE 流中多个 Agent 依次发言
  - `type: "status"` 事件 content 包含 "讨论中"
  - 最终消息内容包含 `[DISCUSSION_SUMMARY]` 前缀（DB 中）
  - 最终 `type: "done"` 事件包含 `data.quality`
- **验证方式**：Network + DB 查询 + SSE

### 4.4 无匹配 Agent
- **操作**：`@不存在的Agent 你好`
- **预期**：
  - `POST /api/sessions/[id]/chat` 请求体 `targetAgent: "不存在的Agent"`
  - SSE 流收到 `type: "error", content: "未找到名为 不存在的Agent 的 Agent"`
- **验证方式**：SSE 事件内容

---

## 5. 权限系统

### 5.1 default 模式权限请求
- **前置条件**：会话 permissionMode 为 "default"
- **操作**：发送触发工具调用的消息
- **预期**：
  - SSE 流收到 `type: "permission_request"` 事件
  - 事件 `data` 包含 `requestId`, `toolName`, `toolInput`
  - 聊天区显示权限横幅：`"Agent 请求使用 "` + 粗体工具名
  - 显示 `"允许"` 和 `"拒绝"` 按钮
- **验证方式**：SSE 事件 + UI

### 5.2 允许操作
- **操作**：点击"允许"
- **预期**：
  - `POST /api/sessions/[id]/permission` 发送，请求体包含 `requestId` 和 `result: "allow"`
  - 权限横幅消失
  - Agent 继续执行
- **验证方式**：Network + UI

### 5.3 拒绝操作
- **操作**：点击"拒绝"
- **预期**：
  - `POST /api/sessions/[id]/permission` 发送，`result: "deny"`
  - 权限横幅消失
  - Agent 收到拒绝，可能显示错误或停止
- **验证方式**：Network + UI

### 5.4 /permission 命令
- **操作**：发送 `/permission auto`
- **预期**：
  - SSE 流收到 `type: "text"` 事件，content 为 `"已切换到自动模式，Agent 操作将自动执行，无需确认。"`
  - 随后收到 `type: "done"` 事件
  - `GET /api/sessions/[id]` 的 `permissionMode` 变为 `"auto"`
- **验证方式**：SSE + API

### 5.5 /permission 参数错误
- **操作**：发送 `/permission abc`
- **预期**：
  - SSE 流收到 `type: "text"` 事件，content 包含 `"用法：/permission auto 或 /permission default"`
- **验证方式**：SSE 事件内容

---

## 6. 文件附件

### 6.1 上传图片
- **操作**：点击 📎 → 选择 PNG 图片
- **预期**：
  - `POST /api/sessions/[id]/attachments` 返回 `201`
  - 响应包含 `id`, `filename`, `mimeType: "image/png"`, `size`
  - 输入框上方显示图片缩略图
- **验证方式**：Network + UI

### 6.2 上传文件
- **操作**：上传 TXT 文件
- **预期**：
  - 返回 `201`
  - `mimeType: "text/plain"`
  - 显示文件卡片（文件名 + 大小）
- **验证方式**：Network + UI

### 6.3 大文件拒绝
- **操作**：上传 >10MB 文件
- **预期**：
  - 前端校验拦截，显示 toast 错误：包含 `"超过 10MB 限制"` 或类似文字
  - 不发送请求到后端
- **验证方式**：UI toast

### 6.4 附件发送
- **操作**：上传附件 + 输入消息 → 发送
- **预期**：
  - `POST /api/sessions/[id]/chat` 请求体包含 `attachmentIds` 数组
  - `GET /api/sessions/[id]/messages` 中该消息的 `attachments` 数组非空
- **验证方式**：Network + API

### 6.5 图片预览
- **操作**：点击聊天区中的图片附件
- **预期**：
  - 新窗口打开 `/api/attachments/${att.id}`
  - 图片正常显示
- **验证方式**：新窗口

### 6.6 文件下载
- **操作**：点击文件卡片
- **预期**：
  - 触发下载或打开 `/api/attachments/${att.id}`
- **验证方式**：下载行为

---

## 7. Agent 管理

### 7.1 创建 Agent
- **操作**：Agent 页面 → 点击"+ 创建 Agent" → 填写表单 → 提交
- **预期**：
  - `POST /api/agents` 返回 `201`
  - 响应包含 `id`, `name`, `isPreset: false`
  - Agent 列表出现新 Agent
- **验证方式**：Network + UI

### 7.2 Agent 名称重复
- **操作**：创建与已有 Agent 同名的 Agent
- **预期**：
  - 返回 `409`
  - 响应包含 `error: "Agent name already exists"`
- **验证方式**：Network

### 7.3 Agent 名称含 HTML 标签
- **操作**：创建 name 为 `<script>alert(1)</script>` 的 Agent
- **预期**：
  - 返回 `400`
  - 响应包含 `error: "Agent name must not contain HTML tags"`
- **验证方式**：Network

### 7.4 编辑 Agent
- **操作**：Agent 详情页 → 修改 name → 点击保存
- **预期**：
  - `PUT /api/agents/[id]` 发送
  - 返回 `200`
  - `GET /api/agents/[id]` 的 `name` 已更新
- **验证方式**：Network + API

### 7.5 删除 Agent
- **操作**：删除一个非预设 Agent
- **预期**：
  - `DELETE /api/agents/[id]` 返回 `200`
  - `GET /api/agents` 不再包含该 Agent
- **验证方式**：API

### 7.6 预设 Agent 不可删除
- **操作**：尝试删除预设 Agent
- **预期**：
  - 如果有 UI 保护：删除按钮不可见或禁用
  - 如果直接调 API：返回 `400` 或 `403`
- **验证方式**：UI 或 API

### 7.7 Agent 颜色
- **操作**：创建 Agent 时选择 accentColor
- **预期**：
  - `GET /api/agents/[id]` 的 `accentColor` 与选择一致
  - 聊天中该 Agent 气泡颜色使用该 accentColor
- **验证方式**：API + UI 颜色

### 7.8 暗色模式下 Agent 颜色
- **操作**：切换到暗色模式 → 查看 Agent 气泡
- **预期**：
  - Agent 气泡为深色背景 + 浅色文字（不是浅色背景 + 深色文字）
  - 文字可读（对比度足够）
- **验证方式**：肉眼观察

### 7.9 Agent 推荐
- **操作**：创建群聊时输入任务描述
- **预期**：
  - `GET /api/sessions/recommend-agents?query=...` 返回 Agent 列表
  - 列表始终包含 Orchestrator
  - 推荐的 Agent 与任务描述相关
- **验证方式**：API 返回

### 7.10 对话式创建 Agent
- **操作**：在聊天中发送 "帮我创建一个数据分析 Agent"
- **预期**：
  - Orchestrator 识别创建意图（正则匹配 "创建" + "Agent"）
  - 调用 `handleCreateAgent`
  - SSE 流中收到 Agent 配置信息
  - `POST /api/agents` 被调用，新 Agent 创建成功
- **验证方式**：SSE + API

---

## 8. Provider 管理

### 8.1 Provider 列表
- **操作**：`GET /api/providers`
- **预期**：
  - 返回数组，包含来自 4 个源的 Provider
  - 每个 Provider 包含 `name`, `baseUrl`, `apiKey`（掩码）, `category`
  - 按 baseUrl 去重
- **验证方式**：API 返回

### 8.2 创建 Provider
- **操作**：Provider 页面 → 创建 → 填写 → 提交
- **预期**：
  - `POST /api/providers/db` 返回 `201`
  - Provider 列表出现新条目
- **验证方式**：Network + UI

### 8.3 apiKey 掩码
- **操作**：查看 Provider 列表中的 apiKey 字段
- **预期**：
  - apiKey 只显示前 4 位 + 后 4 位，中间为 `****`
  - 如 `sk-a123****xyz9`
- **验证方式**：API 返回

### 8.4 测试连接
- **操作**：填写 Provider 信息 → 点击"测试连接"
- **预期**：
  - `POST /api/config/test-connection` 发送
  - 返回连接成功或失败的结果
  - UI 显示对应提示
- **验证方式**：Network + UI

---

## 9. Orchestrator 编排

### 9.1 闲聊（self）
- **操作**：发送 "今天天气怎么样"
- **预期**：
  - Orchestrator 自己回答（不委派给其他 Agent）
  - SSE 流中 `agentId` 为 Orchestrator 的 name
  - 最终 `type: "done"` 收到
- **验证方式**：SSE 事件

### 9.2 委派（delegate）
- **操作**：发送 "帮我用 React 写一个登录表单"
- **预期**：
  - Orchestrator 决策 action 为 `"delegate"`
  - SSE 流中 `agentId` 变为被委派的 Agent（如 "前端工程师"）
  - Agent 执行后收到 `type: "done"`
- **验证方式**：SSE 事件 agentId 变化

### 9.3 对齐流程 - PM 确认（align_confirm）
- **操作**：发送一个开发任务（如 "开发一个待办事项应用"）
- **预期**：
  - SSE 流收到 `type: "phase_transition", content: "alignment"`
  - `GET /api/sessions/[id]` 的 `phase` 变为 `"alignment"`，`phaseStep` 为 `"pm_confirm"`
  - PM Agent 回复需求确认，内容包含 "以上理解是否正确" 或类似确认语
  - 收到 `type: "awaiting_user_input", content: "pm_confirm"`
  - UI 显示等待输入指示：`"产品经理已确认需求，请查看并回复"`
- **验证方式**：SSE + API + UI

### 9.4 对齐流程 - 架构师拆解（align_decompose）
- **操作**：确认 PM 需求后
- **预期**：
  - SSE 流收到 `type: "phase_transition", content: "alignment"`
  - 架构师 Agent 回复任务拆解方案
  - `GET /api/sessions/[id]/tasks` 返回 Task 数组
  - 每个 Task 包含 `description`, `status: "pending"`, `dependencies`, `declaredFiles`
  - 收到 `type: "awaiting_user_input", content: "architect_plan"`
  - UI 显示：`"架构师已出方案，请查看并确认"`
- **验证方式**：SSE + API tasks + UI

### 9.5 对齐流程 - Agent Q&A（align_qa）
- **操作**：确认架构师方案后，如果有 Agent 提问
- **预期**：
  - 收到 `type: "awaiting_user_input", content: "agent_qa"`
  - UI 显示：`"Agent 有问题需要你回答"`
  - 各 Agent 的问题显示为消息
- **验证方式**：SSE + UI

### 9.6 执行阶段（execute）
- **操作**：对齐完成后
- **预期**：
  - SSE 流收到 `type: "phase_transition", content: "execution"`
  - `GET /api/sessions/[id]` 的 `phase` 变为 `"execution"`
  - Tasks 状态从 `pending` 变为 `in_progress` 再变为 `completed`
  - SSE 流中收到多个 `type: "task_status"` 事件
- **验证方式**：SSE + API tasks 状态变化

### 9.7 任务完成（done）
- **操作**：所有任务执行完成
- **预期**：
  - `GET /api/sessions/[id]` 的 `phase` 变为 `"done"`
  - SSE 流收到 `type: "done"` 事件
  - UI 阶段指示器显示 `"已完成"`
- **验证方式**：API + UI

### 9.8 阶段显示
- **操作**：观察聊天区
- **预期**：
  - alignment 阶段：显示 `"对齐中"` 标签
  - execution 阶段：显示 `"执行中"` 标签
  - done 阶段：显示 `"已完成"` 标签
- **验证方式**：UI

---

## 10. 任务执行

### 10.1 任务状态变化
- **操作**：观察 Agent 面板 Tasks 标签
- **预期**：
  - 任务从 `⬜ pending` → `🔄 in_progress` → `✅ completed`
  - 状态图标对应：pending=⬜, in_progress=🔄, completed=✅, failed=❌, blocked=⏸
- **验证方式**：UI 图标

### 10.2 任务 Trace
- **操作**：点击任务的 `trace(N)` 按钮
- **预期**：
  - 展开 trace 查看器
  - 显示 trace 条目：`▶ ${agent} 开始执行`, `✓ 完成 (Xms)`, `✗ 失败: ${message}` 等
  - 按钮文字变为 `"收起"`
- **验证方式**：UI

### 10.3 任务结果持久化
- **操作**：任务完成后
- **预期**：
  - `GET /api/sessions/[id]/tasks` 中该任务的 `result` 字段非空
  - `status` 为 `"completed"`
  - `correctionCount` 为 `0`（如果没有纠偏）
- **验证方式**：API

### 10.4 任务依赖执行
- **操作**：架构师创建有依赖关系的任务（A→B）
- **预期**：
  - A 的 `status` 先变为 `completed`
  - B 的 `status` 在 A 完成后才变为 `in_progress`
  - B 的 prompt 中包含 `<dependency>` 标签（含 A 的结果）
- **验证方式**：API 状态变化顺序

### 10.5 任务重做
- **操作**：任务 failed/blocked 后 → 点击"重做"
- **预期**：
  - 重做按钮只在 `status === 'failed' || status === 'blocked'` 时可见
  - 弹出对话框：标题 `"重做任务"`，描述 `"可以修改任务描述后重新执行，也可以不改直接提交。"`
  - 确认按钮 `"确认重做"`，取消按钮 `"取消"`
  - `POST /api/sessions/[id]/tasks/[taskId]/redo` 发送
  - 任务状态重置为 `pending`
  - 下游 blocked 任务解锁
- **验证方式**：UI + API

---

## 11. 纠偏与审查

### 11.1 监控审查
- **操作**：任务执行完成后观察
- **预期**：
  - Orchestrator 自动审查结果（SSE 流中 agentId 为 Orchestrator）
  - 审查通过：任务保持 `completed`
  - 审查不通过：任务退回 `pending`
- **验证方式**：SSE + API tasks

### 11.2 纠偏重试
- **操作**：审查发现问题时
- **预期**：
  - SSE 流收到 `type: "text"` 事件，content 包含 `"Orchestrator 纠偏："`
  - 随后收到 `type: "task_status"` 事件，content 包含 `"status":"pending"`
  - `GET /api/sessions/[id]/tasks` 中该任务 `correctionCount` 增加
  - `trace` JSON 中新增 `event: "correction"` 条目
- **验证方式**：SSE + API

### 11.3 纠偏上限
- **操作**：连续纠偏 2 次后
- **预期**：
  - 第 3 次保持 `completed` 状态
  - SSE 流收到 `type: "text"` 事件，content 包含 `"纠偏重试已达上限(2次)"`
- **验证方式**：SSE + API

### 11.4 质量标记
- **操作**：delegate 路径完成后
- **预期**：
  - 最终 `type: "done"` 事件的 `data` 包含 `quality` 字段
  - `quality` 为 `"good"` 或 `"poor"`
- **验证方式**：SSE 事件 data

---

## 12. 消息解析与渲染

### 12.1 代码块渲染
- **操作**：Agent 返回包含代码块的消息
- **预期**：
  - 代码块有语言标签（如 "javascript"）
  - 有"复制"按钮
  - 代码有语法高亮（暗色背景）
- **验证方式**：UI

### 12.2 代码块复制
- **操作**：点击代码块的"复制"按钮
- **预期**：
  - 按钮文字变为 `"已复制"`（约 2 秒后恢复）
  - 剪贴板内容仅为代码部分（不含语言标签）
- **验证方式**：按钮文字 + 粘贴

### 12.3 Web Preview 渲染
- **操作**：Agent 返回包含 HTML artifact 的消息
- **预期**：
  - 渲染 iframe 预览
  - iframe 有 `sandbox` 属性
  - HTML 内容被 DOMPurify 清理
- **验证方式**：UI + iframe 属性

### 12.4 Diff 渲染
- **操作**：Agent 返回包含 diff artifact 的消息
- **预期**：
  - 显示 Monaco DiffEditor
  - 有 "接受" 和 "拒绝" 按钮
- **验证方式**：UI

### 12.5 Diff Accept
- **操作**：点击"接受"
- **预期**：
  - `POST /api/sessions/[id]/files/accept` 发送
  - 返回 `200`
  - 按钮区域变为 `"✓ 已接受"`（绿色文字）
  - 文件实际写入项目目录
- **验证方式**：Network + UI + 文件系统

### 12.6 Diff Reject
- **操作**：点击"拒绝"
- **预期**：
  - 按钮区域变为 `"✗ 已拒绝"`（灰色文字）
  - 不发送请求
  - 文件不被修改
- **验证方式**：UI + 文件系统

### 12.7 File Card 渲染
- **操作**：Agent 返回包含 file artifact 的消息
- **预期**：
  - 显示文件卡片：文件名 + 文件大小
  - 有下载链接
  - 下载 URL 经过安全校验（`isValidDownloadUrl`）
- **验证方式**：UI

### 12.8 消息渲染错误兜底
- **操作**：手动在 DB 中插入格式异常的 rawContent 消息
- **预期**：
  - 该消息区域显示 `"消息渲染失败"`（红色文字，浅红背景）
  - 其他消息正常显示
  - 页面不白屏
- **验证方式**：UI

---

## 13. 暗色模式

### 13.1 切换暗色模式
- **操作**：点击主题切换按钮
- **预期**：
  - 整体页面切换为暗色背景
  - 所有组件颜色适配（不是简单的反色）
- **验证方式**：UI

### 13.2 跟随系统
- **操作**：选择"系统"主题
- **预期**：
  - 跟随 OS 设置切换
- **验证方式**：切换 OS 主题后观察

### 13.3 Agent 颜色暗色适配
- **操作**：暗色模式下查看 Agent 气泡
- **预期**：
  - 气泡为深色背景 + 浅色文字
  - 动态 HSL 颜色亮度降低（~18%）
  - 文字清晰可读
- **验证方式**：肉眼观察

### 13.4 持久化
- **操作**：设置暗色模式 → 刷新页面
- **预期**：
  - 仍然是暗色模式
- **验证方式**：刷新后观察

---

## 14. 断点续跑

### 14.1 自动恢复
- **前置条件**：有一个 `in_progress` 状态且 `updatedAt` 超过 5 分钟的任务
- **操作**：`GET /api/sessions/[id]`
- **预期**：
  - 响应包含 `recoveredTaskCount > 0`
  - 该任务的 `status` 已从 `in_progress` 变为 `pending`
- **验证方式**：API

### 14.2 恢复提示 UI
- **操作**：前端加载有恢复任务的会话
- **预期**：
  - 弹出 Dialog
  - 标题：`"发现未完成的任务"`
  - 描述：`"上次有 ${N} 个任务未完成，已自动恢复为待执行状态。是否继续执行？"`
  - 按钮：`"跳过"` 和 `"继续执行"`
- **验证方式**：UI

### 14.3 继续执行
- **操作**：点击"继续执行"
- **预期**：
  - 发送消息 `"继续执行未完成的任务"`
  - 任务开始执行
- **验证方式**：Network + UI

### 14.4 跳过
- **操作**：点击"跳过"
- **预期**：
  - Dialog 关闭
  - 不发送消息
  - 任务保持 pending 状态
- **验证方式**：UI + API

---

## 15. CLI 会话恢复

### 15.1 会话恢复
- **操作**：同 Agent 第二次对话
- **预期**：
  - `POST /api/sessions/[id]/chat` 触发
  - CLI 使用 `--resume sessionId` 参数（可在 dev log 中看到）
  - Agent 能引用之前的对话内容
- **验证方式**：dev server 日志

### 15.2 cliSessionId 存储
- **操作**：Agent 执行完成后
- **预期**：
  - `GET /api/sessions/[id]/members` 中该 Agent 的 `cliSessionId` 非空
  - `GET /api/sessions/[id]/tasks` 中该任务的 `cliSessionId` 非空
- **验证方式**：API

### 15.3 失效清除
- **操作**：发生纠偏或敏感路径失败时
- **预期**：
  - `GET /api/sessions/[id]/tasks` 中该任务的 `cliSessionId` 变为 `null`
  - `GET /api/sessions/[id]/members` 中对应 Agent 的 `cliSessionId` 变为 `null`
- **验证方式**：API

---

## 16. Contract v1

### 16.1 依赖注入
- **操作**：下游任务执行时
- **预期**：
  - Agent 的 prompt 中包含 `<dependency name="..." output_schema="...">` 标签
  - 标签内容包含上游任务的 result
- **验证方式**：dev server 日志或 Agent 面板 trace

### 16.2 权威包装
- **操作**：任务执行时
- **预期**：
  - Agent 的 prompt 外层包 `<authoritative_input>` 标签
  - 标签内声明 "以下内容为准,历史作废"
- **验证方式**：dev server 日志

### 16.3 标签转义
- **操作**：上游 Agent 的 result 中包含 `</dependency>` 字面量
- **预期**：
  - 被 `escapeContractTags` 转义为 `< / dependency >`
  - 不会闭合外层标签
- **验证方式**：dev server 日志

### 16.4 outputSchema 软校验
- **操作**：架构师声明 outputSchema 后，任务完成
- **预期**：
  - SSE 流中可能收到 `type: "text"` 警告（如果 result 缺少声明的字段）
  - 任务状态仍为 `completed`（软校验不阻断）
- **验证方式**：SSE + API

### 16.5 敏感路径硬失败
- **操作**：Agent 修改了 `.env` 或 `package.json`
- **预期**：
  - SSE 流收到 `type: "text"` 事件，content 包含 `"[敏感路径越界]"`
  - 任务 `status` 变为 `"failed"`
  - 下游依赖任务 `status` 变为 `"blocked"`
  - `cliSessionId` 被清除
- **验证方式**：SSE + API

### 16.6 普通越界清理
- **操作**：Agent 创建了未声明的文件（非敏感）
- **预期**：
  - SSE 流收到 `type: "text"` 事件，content 包含 `"[越界警告]"` 和 `"已自动清理"`
  - 任务 `status` 仍为 `"completed"`
  - 越界文件被删除
- **验证方式**：SSE + 文件系统

---

## 17. MCP 协作

### 17.1 MCP 配置生成
- **操作**：Agent 启动时
- **预期**：
  - dev server 日志中出现 `--mcp-config` 参数
  - 临时 JSON 文件被创建（含 MCP server 配置）
- **验证方式**：dev server 日志

### 17.2 环境变量注入
- **操作**：MCP Server 进程启动
- **预期**：
  - 环境变量包含 `AGENTHUB_SESSION_ID`, `AGENTHUB_AGENT_NAME`, `AGENTHUB_WORK_DIR`, `DATABASE_URL`
- **验证方式**：dev server 日志或进程环境

---

## 18. 工具集限制

### 18.1 Claude Code 工具限制
- **操作**：Agent 配置了 tools 列表
- **预期**：
  - CLI 启动参数包含 `--allowedTools` 或 `--disallowedTools`
  - 只有配置的工具可用
- **验证方式**：dev server 日志

### 18.2 创建时工具选择
- **操作**：创建 Agent 对话框
- **预期**：
  - 工具选择分为 3 组：文件/执行/网络
  - 9 个工具可选
  - 默认全选
- **验证方式**：UI

---

## 19. 错误处理

### 19.1 网络错误
- **操作**：断网 → 发送消息
- **预期**：
  - 聊天区显示错误消息：`"Error: 网络请求失败，请检查连接后重试。(${err.message})"`
  - 消息角色为 Orchestrator
- **验证方式**：UI

### 19.2 API 400 错误
- **操作**：发送空消息（无附件无 regenerate）
- **预期**：
  - 返回 `400`
  - 响应为 `"message is required and must be a string"`
- **验证方式**：Network

### 19.3 Session 不存在
- **操作**：`POST /api/sessions/nonexistent/chat` 发送消息
- **预期**：
  - 返回 `404`
  - 响应为 `"Session not found"`
- **验证方式**：Network

### 19.4 404 页面
- **操作**：访问 `/nonexistent`
- **预期**：
  - 显示 404 页面
  - 不显示白屏
- **验证方式**：UI

### 19.5 Regenerate 消息不存在
- **操作**：`POST /api/sessions/[id]/chat` 发送 `regenerate: "nonexistent-id"`
- **预期**：
  - SSE 流收到 `type: "error", content: "原消息不存在"`
- **验证方式**：SSE

---

## 20. Agent 面板

### 20.1 Agents 标签
- **操作**：点击 Agents 标签
- **预期**：
  - 标签文字：`"Agents (${count})"`
  - 显示当前会话的所有 Agent
  - 每个 Agent 显示名称 + 编辑按钮 + 私聊按钮
  - 私聊按钮文字：`"和 ${agent.name} 私聊"`
  - 空状态：`"还没有 Agent，创建或导入一个"`
- **验证方式**：UI

### 20.2 Tasks 标签
- **操作**：点击 Tasks 标签
- **预期**：
  - 标签文字：`"Tasks (${count})"`
  - 显示当前会话的所有任务
  - 每个任务显示状态图标 + 描述
  - 空状态：`"暂无任务，开始对话后会在这里显示"`
- **验证方式**：UI

### 20.3 任务轮询
- **操作**：任务执行中观察 Tasks 标签
- **预期**：
  - 每 3 秒自动刷新任务状态
  - 状态图标实时更新
- **验证方式**：UI 刷新频率

---

## 21. 上下文构建

### 21.1 Pin 消息优先
- **操作**：Pin 一条消息后发送新任务
- **预期**：
  - Pin 的消息出现在 Agent prompt 的 "重要上下文" 部分
  - 非 Pin 消息在普通历史部分
- **验证方式**：dev server 日志

### 21.2 讨论摘要注入
- **操作**：@所有人 讨论后执行任务
- **预期**：
  - 任务 prompt 中包含 `[项目背景]` 前缀
  - 内容来自讨论摘要（截断到 500 字）
- **验证方式**：dev server 日志

---

## 22. 消息列表 API

### 22.1 消息包含 parsed 字段
- **操作**：`GET /api/sessions/[id]/messages`
- **预期**：
  - 每个消息包含 `parsed` 对象
  - `parsed.text` 为纯文本（去除代码块和 artifact 标记）
  - `parsed.codeBlocks` 为数组，每项包含 `language`, `code`, `lineStart`
  - `parsed.artifacts` 为数组，每项包含 `type`, `content`, `meta`
- **验证方式**：API 返回

### 22.2 消息包含 replyTo
- **操作**：有引用回复时
- **预期**：
  - `GET /api/sessions/[id]/messages` 中引用消息包含 `replyTo` 对象
  - `replyTo` 包含 `id`, `rawContent`, `role`, `parsed`
- **验证方式**：API 返回

### 22.3 消息包含 attachments
- **操作**：有附件的消息
- **预期**：
  - 消息的 `attachments` 数组非空
  - 每个附件包含 `id`, `filename`, `mimeType`, `size`
- **验证方式**：API 返回

---

## 23. 安全

### 23.1 路径遍历防护
- **操作**：`POST /api/sessions/[id]/files/accept` 发送含 `../` 的 filePath
- **预期**：
  - 返回 `403` 或 `400`
  - 文件不被写入
- **验证方式**：Network + 文件系统

### 23.2 敏感文件保护
- **操作**：Accept 写入 `.env` 文件
- **预期**：
  - 返回 `403`
  - 响应包含 "敏感文件" 或 "sensitive" 相关文字
- **验证方式**：Network

### 23.3 URL 安全
- **操作**：创建含 `javascript:alert(1)` 下载链接的 file artifact
- **预期**：
  - `isValidDownloadUrl()` 返回 false
  - 链接不被渲染或被拦截
- **验证方式**：UI 或 API

### 23.4 apiKey 不暴露
- **操作**：`GET /api/agents` 或 `GET /api/agents/[id]`
- **预期**：
  - 响应中**不包含** `apiKey` 字段（被 Prisma select 排除）
- **验证方式**：API 返回字段检查

### 23.5 iframe sandbox
- **操作**：查看 Web Preview 的 iframe
- **预期**：
  - iframe 有 `sandbox="allow-scripts"` 属性
  - 不含 `allow-same-origin`
- **验证方式**：HTML 属性检查

---

## 24. 拉群流程

### 24.1 智能推荐
- **操作**：创建群聊 → 输入任务描述
- **预期**：
  - `GET /api/sessions/recommend-agents?query=...` 被调用
  - 返回推荐的 Agent 列表
  - Orchestrator 始终在列表中
  - Agent 按相关性排序
- **验证方式**：Network + UI

### 24.2 多选 Agent
- **操作**：在推荐列表中选择/取消选择 Agent
- **预期**：
  - checkbox 正确切换（stopPropagation 修复 BUG-003）
  - 选中数量显示正确
- **验证方式**：UI 交互

### 24.3 确认创建
- **操作**：选择 Agent 后点击确认
- **预期**：
  - `POST /api/sessions` 发送，`type: "group"`，`agentIds` 包含选中的 Agent
  - 返回 `201`
  - 侧栏出现新群聊
  - 成员数 = 选中数
- **验证方式**：Network + API + UI

---

## 测试执行记录模板

| # | 测试点 | 结果 | 备注 |
|---|--------|------|------|
| 1.1 | Setup Wizard 弹出 | PASS/FAIL | |
| 1.2 | CLI 检测 | PASS/FAIL | |
| ... | ... | ... | ... |

---

**总计 24 大类、100+ 个可验证测试点。**
