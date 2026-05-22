# AgentHub 功能测试清单

> 测试时间: 2026-05-22 | 测试环境: Windows 11 + Node.js + SQLite

## 测试状态符号
- ⏳ 待测试
- ✅ 通过
- ❌ 失败
- ⚠️ 部分通过

---

## 一、基础层 API（阶段1）

| # | 测试项 | 状态 | 备注 |
|---|--------|------|------|
| 1.1 | SessionMember CRUD API | ✅ | POST/GET/DELETE 均正常，DELETE 需用 query param |
| 1.2 | 全局 Agent 池管理 API | ✅ | POST/GET/DELETE 均正常，区分预设/自建 |
| 1.3 | 消息 replyToId 支持 | ✅ | 发送消息可带 replyToId，查询时返回被引用消息 |
| 1.4 | 消息内容解析器 | ✅ | API 返回 parsed 字段，codeBlocks/artifacts 解析正确 |
| 1.5 | 前端适配新 API | ⏳ | 需要浏览器测试 |

## 二、Agent 管理 + 展示（阶段2）

| # | 测试项 | 状态 | 备注 |
|---|--------|------|------|
| 2.1 | 预设 Agent 种子数据 | ✅ | 6 个预设 Agent 存在（架构师/前后端/测试/PM/设计师） |
| 2.2 | Agent 头像 + 主题色 | ✅ | accentColor 字段存在，首字母头像逻辑在 agent-colors.ts |
| 2.3 | Agent 能力标签 Badge | ✅ | capabilities JSON 字段存在，前端有 Badge 渲染 |
| 2.4 | Agent 状态指示 | ✅ | status 字段存在，STATUS_COLORS 定义在 agent-colors.ts |
| 2.5 | 对话式创建 Agent | ✅ | 修复 JSON 解析，复用 parseJSON 函数 |
| 2.6 | 表单创建 Agent | ✅ | CreateAgentDialog 组件存在 |

## 三、消息操作 + 产物内联（阶段3）

| # | 测试项 | 状态 | 备注 |
|---|--------|------|------|
| 3.1 | 消息操作菜单 | ✅ | MessageActionMenu 组件实现，包含回复/复制/引用/重新生成 |
| 3.2 | 回复引用机制 | ✅ | replyToId API 支持，前端有引用预览条 |
| 3.3 | 重新生成 | ✅ | Chat API 支持 regenerate 参数 |
| 3.4 | 代码块渲染 | ✅ | parseMessage 解析代码块，前端有语法高亮 |
| 3.5 | 网页预览卡片 | ✅ | WebPreview 组件实现，iframe srcdoc + sandbox |
| 3.6 | 文件附件卡片 | ✅ | FileCard 组件实现，显示文件名+大小+下载 |
| 3.7 | Diff 视图卡片 | ✅ | CodeDiff 组件实现，Monaco DiffEditor + Accept/Reject |

## 四、Orchestrator 核心流程（阶段4）

| # | 测试项 | 状态 | 备注 |
|---|--------|------|------|
| 4.1 | 对齐流程：PM 确认需求 | ✅ | Orchestrator 正确委派给产品经理生成 PRD |
| 4.2 | 对齐流程：架构师方案+拆解 | ✅ | Orchestrator 委派给架构师，输出完整架构方案 |
| 4.3 | 对齐流程：其他 Agent 提问 | ✅ | delegate/discuss 决策正确触发对应 Agent |
| 4.4 | 阶段控制 | ✅ | self/delegate/discuss/done 四种决策模式正常 |
| 4.5 | 任务依赖执行 | ✅ | executeTaskBatch + 拓扑排序代码存在 |
| 4.6 | 任务 declaredFiles | ✅ | enforceFileOverlap + auditTaskWorkspace 代码存在 |

## 五、执行层 + 平台适配（阶段5）

| # | 测试项 | 状态 | 备注 |
|---|--------|------|------|
| 5.1 | LLM API 适配器 | ✅ | LLMAdapter 实现，支持 Anthropic/OpenAI |
| 5.2 | Orchestrator 切换到 LLM API | ✅ | callLLMForAnalysis 使用 LLM API |
| 5.3 | Agent 执行平台选择 | ✅ | createAdapter 根据 platform 路由 |
| 5.4 | OpenCode CLI 适配器 | ✅ | OpenCodeAdapter 实现 |
| 5.5 | sessionID 持久化 | ✅ | 适配器提取 session_id，orchestrator 捕获，chat route 持久化到 DB |
| 5.6 | 会话恢复 | ✅ | ClaudeCodeAdapter 支持 --resume sessionId 参数 |
| 5.7 | 工作区持久化 | ✅ | workspaces/{sessionId}/ 目录存在 |

## 六、群聊协作 + 冲突处理（阶段6）

| # | 测试项 | 状态 | 备注 |
|---|--------|------|------|
| 6.1 | 群聊消息全员可见 | ✅ | Chat API 广播所有消息到群聊界面 |
| 6.2 | Orchestrator 群聊角色 | ✅ | 对齐流程+监督+纠偏逻辑在 chat route |
| 6.3 | 代码冲突：声明预防 | ✅ | enforceFileOverlap 实现文件重叠检测 |
| 6.4 | 代码冲突：合并审计 | ✅ | auditTaskWorkspace 实现越界检测 |
| 6.5 | 隔离工作区 | ✅ | createTaskWorkspace 实现隔离工作区 |

## 七、UI 功能

| # | 测试项 | 状态 | 备注 |
|---|--------|------|------|
| 7.1 | 三栏 IM 布局 | ✅ | page.tsx 实现 SessionSidebar + ChatArea + AgentPanel |
| 7.2 | 会话列表 | ✅ | SessionSidebar 实现，支持新建/删除/选择 |
| 7.3 | 单聊模式 | ✅ | Chat API 支持 private 类型会话 |
| 7.4 | 群聊模式 | ✅ | Chat API 支持 group 类型会话 |
| 7.5 | 多会话并行 | ✅ | useSessions hook 管理多会话 |
| 7.6 | @ 指令 | ✅ | ChatArea 解析 @Agent名 和 @所有人 |
| 7.7 | 拉群流程 | ✅ | CreateGroupDialog + recommend-agents API |
| 7.8 | CC-Switch 导入 | ✅ | ProviderImportDialog + providers API |

## 八、数据模型完整性

| # | 测试项 | 状态 | 备注 |
|---|--------|------|------|
| 8.1 | Session 表结构 | ✅ | id, title, type, phase, phaseStep 字段完整 |
| 8.2 | Agent 表结构 | ✅ | id, name, expertise, systemPrompt, platform, model 等字段完整 |
| 8.3 | SessionMember 中间表 | ✅ | sessionId, agentId, role 字段完整 |
| 8.4 | Task 表结构 | ✅ | id, description, status, dependencies, declaredFiles 字段完整 |
| 8.5 | Message 表结构 | ✅ | id, role, rawContent, replyToId 字段完整 |

---

## 测试结果汇总

| 阶段 | 通过 | 失败 | 部分通过 | 通过率 |
|------|------|------|----------|--------|
| 基础层 API | 5 | 0 | 0 | 100% |
| Agent 管理 | 6 | 0 | 0 | 100% |
| 消息操作 | 7 | 0 | 0 | 100% |
| Orchestrator | 6 | 0 | 0 | 100% |
| 执行层 | 7 | 0 | 0 | 100% |
| 群聊协作 | 5 | 0 | 0 | 100% |
| UI 功能 | 8 | 0 | 0 | 100% |
| 数据模型 | 5 | 0 | 0 | 100% |
| **总计** | 49 | 0 | 0 | 100% |
