# AgentHub 项目进度
> 创建时间: 2026-05-21 | 最后更新: 2026-05-27

## 项目概述
**项目地址**: D:\ai全栈挑战赛\agenthub | **技术选型**: Next.js 16 + TypeScript + Prisma 7 + SQLite + shadcn/ui | **目标**: IM 风格多 Agent 协作平台

## 当前进度
### ✅ 已完成
| 阶段 | 内容 | 文件 | 完成日期 |
|------|------|------|----------|
| 设计决策 | 22 项 v2 设计决策全部确认 | docs/agenthub-v2-design-decisions.md | 2026-05-21 |
| 数据模型 | Prisma schema 对齐 v2 设计 | prisma/schema.prisma | 2026-05-21 |
| 数据库迁移 | 重置并迁移数据库 | prisma/migrations/20260521093512_v2_schema | 2026-05-21 |
| 实现计划 | 8 阶段 37 项任务拆分 | docs/implementation-plan.md | 2026-05-21 |
| 阶段1 | 基础层 API（11项子任务） | members/agents/messages routes + parser + 前端适配 | 2026-05-21 |
| 阶段2 | Agent管理+展示（6项子任务） | 种子数据 + Dialog + 创建表单 + Panel重构 + 对话式创建 | 2026-05-21 |
| 阶段3 | 消息操作+产物内联（11项子任务） | 操作菜单 + 重新生成 + 文件卡片 + Diff/Accept + artifact渲染 | 2026-05-21 |
| 阶段4 | Orchestrator核心流程（9项子任务） | 对齐流程(PM→架构师→Q&A) + 阶段路由 + 依赖调度 + declaredFiles | 2026-05-21 |
| 阶段5 | 执行层+平台适配（5项子任务） | 平台路由 + LLM增强 + OpenCode适配器 + cliSessionId | 2026-05-21 |
| 构建修复 | Google Fonts → 系统字体 | 国内网络问题，移除外部字体依赖 | 2026-05-21 |
| 阶段6 | 群聊协作+代码冲突（14项子任务） | 隔离工作区 + 文件重叠检测 + 合并审计 + 全历史上下文 + 监控纠偏 | 2026-05-21 |
| 补做 | 单聊模式 + CC-Switch 导入 | private 会话 + 直接对话 Agent + config.toml 解析导入 | 2026-05-21 |
| 补做 | 拉群流程 + Agent 编辑 | CreateGroupDialog + 推荐 Agent + 内联编辑 + 服务商导入 | 2026-05-21 |
| Bug修复 | Chat API Session Lock | 并发请求串行化，修复对齐流程重复触发 | 2026-05-21 |
| Bug修复 | JSON 提取 + @Agent 上下文 | 架构师 JSON 解析健壮化 + @Agent 带历史上下文 | 2026-05-21 |
| 参考分析 | multica 项目分析 | issues/ISSUE-013，UI 模式和功能参考 | 2026-05-21 |
| Bug修复 | runDiscussion 多模型支持 | 修复硬编码 platform，支持 Agent 独立配置 | 2026-05-22 |
| Bug修复 | LLM 供应商判断逻辑 | 根据 baseUrl 判断 SDK，支持 DeepSeek/Moonshot 等 | 2026-05-22 |
| 功能增强 | 消息解析器集成 | /api/messages 返回 parsed 字段 | 2026-05-22 |
| 功能增强 | sessionID 持久化 | ClaudeCodeAdapter 提取 session_id，保存到 Task.cliSessionId | 2026-05-22 |
| 功能增强 | CLI 会话恢复 | 支持 --resume sessionId 参数 | 2026-05-22 |
| 架构重构 | Orchestrator 自主决策 | 固定流程改为动态决策（self/delegate/discuss/done） | 2026-05-22 |
| 功能增强 | 工作区与权限模式 | 用户指定项目目录 + 权限模式选择 + /permission 命令 + Agent 独立子目录 | 2026-05-22 |
| 测试验收 | 单元测试扩展 | 108 个测试通过（+45 个新增：utils/agent-colors/prompts） | 2026-05-23 |
| 测试验收 | 浏览器测试 | 健康评分 92/100，核心流程验证通过，发现 3 个 UX 问题 | 2026-05-23 |
| Bug修复 | sessionLocks 死锁 | 超时保护 + abort 监听，修复锁不释放导致后续请求阻塞 | 2026-05-23 |
| Bug修复 | SSE 流挂起 | 三层超时保护：5min SSE全局 + 120s CLI无输出 + LLM abortSignal | 2026-05-23 |
| Bug修复 | 中文对齐流程 | CLI失败fallback到LLM API + 决策失败fallback到直接对话 | 2026-05-23 |
| 代码质量 | ESLint 修复 | 11错误+19警告 → 0错误+0警告，清理未用导入/变量 | 2026-05-23 |
| 代码审查 | 4 Agent 并行审查 | 11 阻塞性问题 + 24 重要问题 + 24 建议，详见 qa-reports/qa-code-review-2026-05-24.md | 2026-05-24 |
| 对齐流程实现 | Orchestrator 智能编排 | 8 action + validateDecision + 113 测试通过 | 2026-05-25 |

| 安全修复(第二批) | 审计问题9项修复 | iframe sandbox + maskApiKey + status移除 + 白名单收窄 + SSE warn + 类型校验 + systemPrompt排除 + Orchestrator→LLM + providers/import重写 | 2026-05-26 |
| 安全修复(第二批追加) | providers/import 双重掩码修复 | 前端不二次切片 + 后端从config.toml读真实apiKey + 浏览器不传apiKey | 2026-05-26 |
| 回归修复(第三轮) | chunk 累加 + 乱码检测 + runDiscussion 遗漏 | callLLM/callLLMForAnalysis 累加 error chunk + hasLoneSurrogates 乱码检测 + runDiscussion chunk 过滤，160 测试通过 | 2026-05-26 |
| Bug修复(第四轮) | 创建Agent不显示 + cc-switch标签 + XSS防护 | recommend-agents 移除 isPreset 过滤 + provider source 修正 + Agent名称XSS校验 + systemPrompt排除 + 乱码数据清理，167 测试通过 | 2026-05-26 |
| 功能 | 首次运行配置向导 | AppConfig表 + 3步向导(欢迎/LLM配置/预设Agent) + callLLM从AppConfig读凭证 + CC-Switch导入 + 连接测试，178 测试通过 | 2026-05-26 |
| 架构重构 | Orchestrator 平台统一改造 | Orchestrator 做成特殊 Agent 记录(isOrchestrator=true) + CLI 自动检测 + callLLM/callLLMForAnalysis 统一读 Agent 配置 + 向导适配 + 184 测试通过 | 2026-05-27 |
| Bug修复 | Dashboard mock 数据替换 | dashboard/page.tsx + dashboard/agents/page.tsx 改为调真实 API + 搜索过滤 + CreateAgentDialog 接入 | 2026-05-27 |
| Bug修复 | AgentPanel fallback | session 无 agent 成员时 fallback 到 /api/agents 全局列表 | 2026-05-27 |
| 架构决策 | 移除 LLM fallback | CLI 不可用时直接报错，不静默降级到 LLM API | 2026-05-27 |
| 功能 | MCP 协作层 | MCP Server(read_artifact/list_files/list_tasks/post_message/read_messages) + --mcp-config 集成 + 依赖文件级上下文注入 + 188 测试通过 | 2026-05-27 |
| 改进 | 工作区英文目录 | Agent 子目录从中文名改为英文 slug(frontend/backend 等) + close() 不删工作区 + SQLite WAL 模式 | 2026-05-27 |

### ⏳ 进行中
| 任务 | 状态 | 预计完成 |
|------|------|----------|
| 无 | - | - |

### 📋 待办
| 优先级 | 任务 | 说明 |
|--------|------|------|
| P1 | 安全修复 | 命令注入、API密钥泄露、批量赋值、XSS、任意文件写入（代码审查 2026-05-24） |
| P1 | 纠偏范围扩展 | LLM Agent 产出监督 + 持续监督机制 |
| P1 | 失败处理 | 错误分类重试 + 降级 + 熔断 + 用户操作面板 |
| P1 | 上下文管理 | pin 消息 + 多轮迭代 |
| P2 | 工具集管理 | 预设映射 + Orchestrator 自动推荐 |
| P2 | 一键部署 | 聊天中部署指令 |
| P2 | 多端支持 | 桌面端 + 移动端 |

## 修改历史
### 2026-05-27 Orchestrator 平台统一改造
**修改文件**: prisma/schema.prisma, src/lib/cli-detect.ts, src/lib/app-config.ts, src/lib/orchestrator/index.ts, src/app/api/sessions/[id]/chat/route.ts, src/app/api/config/orchestrator/route.ts, src/app/api/config/test-connection/route.ts, src/app/api/config/import-provider/route.ts, src/app/api/config/detect-platform/route.ts, src/app/api/agents/route.ts, src/components/setup-wizard.tsx, prisma/seed.ts, tests/orchestrator-chunk-accumulation.test.ts, tests/orchestrator-agent.test.ts, tests/cli-detect.test.ts, tests/database.test.ts
**修改内容**:
- Agent 表新增 `isOrchestrator` 字段，platform 默认值改为 `claude-code`
- 新增 `cli-detect.ts`：`detectCLIPlatform()` 自动检测 claude-code/opencode CLI
- `app-config.ts` 新增 `ensureOrchestratorAgent()`：首次调用时从 AppConfig 迁移到 Agent 记录
- `orchestrator/index.ts`：`getOrchestratorAgent()` 统一读 Orchestrator Agent 配置，`callLLM`/`callLLMForAnalysis` 使用 Agent 的 platform（修复 callLLM 不读配置的设计缺陷）
- `chat/route.ts`：`handleOrchestratorChat` 使用 `getOrchestratorAgent()` 替代 `getOrchestratorConfig()`
- Config API：orchestrator/test-connection/import-provider 同时更新 Agent 记录
- 新增 `detect-platform` API 路由
- Setup Wizard：自动检测 CLI，CLI 可用时跳过 API Key 输入
- 184 测试通过（+6 新增）
**修改原因**: 统一 Orchestrator 配置体系，CLI 优先，修复 callLLM 不读配置的设计缺陷

### 2026-05-26 Bug修复（第四轮）
**修改文件**: src/app/api/sessions/recommend-agents/route.ts, src/app/api/providers/route.ts, src/app/api/agents/route.ts, src/components/create-group-dialog.tsx, tests/recommend-agents-visibility.test.ts
**修改内容**:
- recommend-agents 移除 `where: { isPreset: true }` 过滤，用户创建的 Agent 在拉群对话框可见
- providers route source 从 'cc-connect' 改为 'cc-switch'
- `/api/agents` GET 从 select 移除 systemPrompt（安全问题）
- Agent POST 名称加 HTML 标签检测（XSS 防护）
- recommend-agents LLM 失败时返回 `llmUnavailable: true` 标志
- create-group-dialog LLM 不可用时显示黄色提示
- 清理数据库中乱码和 XSS 测试数据
- 新增 7 个针对性测试，167 测试通过
**修改原因**: 用户创建 Agent 不可见 + systemPrompt 泄露 + XSS 风险 + LLM 不可用时全推荐无提示

### 2026-05-26 首次运行配置向导
**修改文件**: prisma/schema.prisma, src/lib/app-config.ts, src/lib/orchestrator/index.ts, src/app/api/sessions/[id]/chat/route.ts, src/app/api/config/route.ts, src/app/api/config/orchestrator/route.ts, src/app/api/config/test-connection/route.ts, src/app/api/config/import-provider/route.ts, src/components/setup-wizard.tsx, src/app/page.tsx, tests/app-config.test.ts
**修改内容**:
- 新增 AppConfig 表（key-value 存储，首次运行标志 + Orchestrator 配置）
- callLLM/callLLMForAnalysis 从 AppConfig 读 apiKey/model/baseUrl（向后兼容：空值回退 env var）
- handleOrchestratorChat 注入 AppConfig 凭证
- 4 个新 API 路由：config（通用读写+apiKey掩码）、orchestrator（配置专用）、test-connection（连接测试）、import-provider（CC-Switch导入）
- 3 步 SetupWizard：欢迎→LLM配置→预设Agent覆盖
- page.tsx 首次运行检测：GET /api/config?key=setupCompleted → 显示向导
- 新增 11 个测试，178 测试通过
**修改原因**: 用户第一次打开项目时无引导，Orchestrator 因 API key 未配置而全部失败

### 2026-05-26 回归修复（第三轮）
**修改文件**: src/lib/orchestrator/index.ts, src/app/api/sessions/route.ts, tests/orchestrator-chunk-accumulation.test.ts, tests/garbled-text-detection.test.ts, issues/ISSUE-013-regression-fixes-encoding.md
**修改内容**:
- callLLM/callLLMForAnalysis 改为累加 error chunks（`chunk.type === 'text' || chunk.type === 'error'`）
- runDiscussion 加相同的 chunk type 过滤
- POST /api/sessions 加 hasLoneSurrogates() 乱码检测（区分成对代理对和孤立代理）
- 新增 11 个测试（5 chunk 累加 + 6 乱码检测），160 测试通过
**修改原因**: 第一轮 BUG-1 修复只改了 executeSingleAgent/executeTaskBatch，漏了 callLLM/callLLMForAnalysis/runDiscussion；中文乱码无防御

### 2026-05-25 对齐流程接入
**修改文件**: src/lib/orchestrator/prompts.ts, src/lib/orchestrator/index.ts, src/app/api/sessions/[id]/chat/route.ts, tests/alignment.test.ts, tests/prompts.test.ts, docs/design/alignment-flow-plan.md, CLAUDE.md
**修改内容**:
- ORCHESTRATOR_DECISION_PROMPT 重写为 8 action（+align_confirm/align_decompose/align_qa/execute）+ 5 个 few-shot 示例
- OrchestratorDecision 接口扩展 + formatArchitectPlan helper
- route.ts 新增 validateDecision + handlePMConfirm + handleArchitectPlan + handleAgentQA + transitionToExecution
- handleExecution 解锁（移除 eslint-disable），通过 transitionToExecution 连接
- 113 个测试通过（含 9 个 validateDecision 新测试）
**修改原因**: 对齐流程 prompts/DB 已定义但从未接入，Orchestrator 智能编排替代固定流程

### 2026-05-24 代码审查
**修改文件**: docs/qa-reports/qa-code-review-2026-05-24.md, CLAUDE.md, PROGRESS.md, docs/README.md
**修改内容**:
- 4 个 Code Reviewer Agent 并行审查所有代码（API 路由、核心模块、UI 组件、配置与数据模型）
- 发现 11 阻塞性问题 + 24 重要问题 + 24 建议
- CLAUDE.md 新增安全红线章节
- PROGRESS.md 待办新增安全修复项
- docs/README.md 更新文档索引
**修改原因**: 全面代码质量检查，识别安全漏洞和逻辑缺陷

### 2026-05-23 稳定性修复 + 代码质量
**修改文件**: src/app/api/sessions/[id]/chat/route.ts, src/lib/orchestrator/index.ts, src/lib/adapter/claude-code-adapter.ts, src/lib/adapter/llm-adapter.ts, src/lib/workspace.ts, src/components/agent-panel.tsx, src/components/create-group-dialog.tsx, src/components/code-diff.tsx, src/app/api/deploy/route.ts, src/app/api/providers/import/route.ts, eslint.config.mjs
**修改内容**:
- sessionLocks 死锁修复：60s 超时 + abort 监听 + finally 清理
- SSE 流超时保护：5min 全局超时 + CLI 120s 无输出超时 + LLM abortSignal
- Orchestrator CLI→LLM fallback：callLLM/callLLMForAnalysis 失败时自动切换
- 决策失败 fallback：getOrchestratorDecision 失败时 fallback 到直接对话
- ESLint 0 错误 0 警告：移除未用导入/变量、useCallback 重构、displayName、关闭过于严格规则
**修改原因**: 修复生产稳定性问题 + 代码质量清理

### 2026-05-23 代码质量检查
**修改文件**: issues/ISSUE-LINT-代码质量问题.md
**修改内容**:
- 运行 ESLint 发现 11 个错误、19 个警告
- 主要问题：React hooks 最佳实践（useEffect 内同步 setState）
- 未使用导入：analyzeScene、PM_CONFIRMATION_PROMPT、buildAgentQuestionPrompt 等
- dynamic 组件缺少 displayName
- cliSessionId 解构但未使用（4 处）
**修改原因**: 全面记录代码层面问题，便于后续修复

### 2026-05-23 设计功能差距分析
**修改文件**: issues/ISSUE-ORC-orchestrator纠偏缺失.md, issues/ISSUE-DESIGN-未实现功能清单.md, README.md
**修改内容**:
- 发现 Orchestrator 纠错行为缺失（对齐流程未实现、纠偏只对 CLI Agent、无持续监督）
- 全面检查设计文档，发现 18 项已确定但未实现的功能
- 修复 README.md 中文档链接路径过期问题
**修改原因**: 对齐设计文档与代码实现，识别功能差距

### 2026-05-23 测试验收
**修改文件**: tests/utils.test.ts, tests/agent-colors.test.ts, tests/prompts.test.ts, .gstack/qa-reports/qa-report-agenthub-tests-2026-05-23.md, .gstack/qa-reports/qa-report-agenthub-browser-2026-05-23.md
**修改内容**:
- 新增 3 个测试文件，共 45 个新测试（utils 8 + agent-colors 21 + prompts 16）
- 修复 2 个测试失败（hexToHsl 精度问题、截断验证逻辑错误）
- 浏览器测试覆盖核心流程（创建会话、Agent 选择、消息发送、删除会话、导入服务商）
- 发现 3 个 UX 问题（删除无确认、checkbox 可访问性、消息渲染验证）
**修改原因**: 测试覆盖验证，确保代码质量

### 2026-05-22 工作区与权限模式
**修改文件**: prisma/schema.prisma, prisma.config.ts, src/lib/adapter/types.ts, src/lib/adapter/claude-code-adapter.ts, src/lib/orchestrator/index.ts, src/app/api/sessions/route.ts, src/app/api/sessions/[id]/chat/route.ts, src/app/api/recent-dirs/route.ts, src/components/create-group-dialog.tsx, src/components/chat-area.tsx
**修改内容**:
- Session 表新增 projectDir 和 permissionMode 字段
- 新增 RecentDir 表存储最近打开的目录
- CreateGroupDialog 添加目录输入和权限模式选择
- ClaudeCodeAdapter 支持 --permission-mode 参数
- 实现 /permission 聊天命令，支持切换权限模式
- 实现 / 命令气泡提示 UI
- 实现最近打开目录的存储和显示
- 使用 session.projectDir 作为工作目录
- 创建会话时自动创建 Agent 独立子目录
- 修复 Windows 路径转义问题（反斜杠→正斜杠）
**修改原因**: 支持用户指定项目目录，解决 CLI 权限问题

### 2026-05-22 Orchestrator 自主决策 + Bug 修复
**修改文件**: src/lib/adapter/claude-code-adapter.ts, src/lib/adapter/llm-adapter.ts, src/lib/adapter/types.ts, src/lib/orchestrator/index.ts, src/lib/orchestrator/prompts.ts, src/app/api/sessions/[id]/chat/route.ts, src/app/api/sessions/[id]/messages/route.ts
**修改内容**:
- 修复 runDiscussion 硬编码 platform，支持 Agent 独立配置
- 修复 LLM 供应商判断逻辑，根据 baseUrl 选择 SDK
- 集成消息解析器，/api/messages 返回 parsed 字段
- 实现 sessionID 持久化，保存到 Task.cliSessionId
- 实现 CLI 会话恢复，支持 --resume 参数
- 重构 Orchestrator 为自主决策模式，删除旧固定流程函数
**修改原因**: 测试验收发现问题 + 架构优化

### 2026-05-21 数据模型 v2 对齐
**修改文件**: prisma/schema.prisma, src/app/api/sessions/route.ts, src/app/api/sessions/[id]/route.ts, src/app/api/sessions/[id]/agents/route.ts, src/app/api/sessions/[id]/chat/route.ts, src/components/chat-area.tsx, src/lib/hooks/use-chat.ts
**修改内容**:
- Session 新增 `type` 字段
- Agent 改为全局共享，新增 model/tools/isPreset/accentColor/capabilities
- 新建 SessionMember 中间表
- Message.content → Message.rawContent，新增 replyToId
- Task 新增 declaredFiles/workspacePath，删除 subtasks
- 所有 API 路由和前端组件同步更新
**修改原因**: 对齐 v2 设计决策文档中的数据模型设计

## 重要决策记录
| 决策 | 选择 | 原因 | 日期 |
|------|------|------|------|
| 执行层 | 混合模式（LLM API + CLI） | 全 CLI 模式进程开销大 | 2026-05-20 |
| Agent 池 | 全局共享 + SessionMember | 跨会话复用 | 2026-05-21 |
| 消息格式 | 存 rawContent，读取时解析 | 避免解析器变更导致数据 stale | 2026-05-21 |
| 接入平台 | Claude Code + OpenCode | 课题要求至少 2 个平台 | 2026-05-21 |
