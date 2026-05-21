# AgentHub 实现计划
> 更新时间: 2026-05-21 | 基于 22 项 v2 设计决策

## 阶段划分

### 阶段 1：基础层（数据 + API）
> 目标：完善数据模型的 CRUD，为上层功能提供基础

| # | 任务 | 依赖 | 涉及文件 | 验收标准 |
|---|------|------|----------|----------|
| 1.1 | SessionMember CRUD API | 无 | src/app/api/sessions/[id]/members/route.ts | 增删查会话成员 |
| 1.2 | 全局 Agent 池管理 API | 无 | src/app/api/agents/route.ts, src/app/api/agents/[id]/route.ts | Agent 增删改查，区分预设/自建 |
| 1.3 | 消息 replyToId 支持 | 无 | src/app/api/sessions/[id]/messages/route.ts, src/app/api/sessions/[id]/chat/route.ts | 发送消息可带 replyToId，查询时返回被引用消息 |
| 1.4 | 消息内容解析器 | 无 | src/lib/message-parser.ts | rawContent → { text, codeBlocks, artifacts } 结构化 JSON |
| 1.5 | 前端适配新 API | 1.1-1.4 | src/components/chat-area.tsx, src/lib/hooks/use-chat.ts | 使用新 API 渲染消息 |

### 阶段 2：Agent 管理 + 展示
> 目标：Agent 全局池 + 用户自建 + 联系人样式展示

| # | 任务 | 依赖 | 涉及文件 | 验收标准 |
|---|------|------|----------|----------|
| 2.1 | 预设 Agent 种子数据 | 1.2 | prisma/seed.ts | 架构师、前端、后端、测试、PM 等预设 Agent |
| 2.2 | Agent 展示：头像 + 主题色 | 1.2 | src/components/agent-panel.tsx, src/lib/agent-colors.ts | 首字母+专属背景色头像，accentColor 存数据库 |
| 2.3 | Agent 能力标签 Badge | 1.2 | src/components/agent-panel.tsx | capabilities JSON 渲染为 Badge |
| 2.4 | Agent 状态指示 | 1.2 | src/components/agent-panel.tsx | idle/working/done/error 圆点颜色 |
| 2.5 | 对话式创建 Agent | 1.2 | src/app/api/sessions/[id]/chat/route.ts | 用户告诉 Orchestrator → 生成配置 → 确认 → 创建 |
| 2.6 | 表单创建 Agent | 1.2 | src/components/create-agent-dialog.tsx | 快速创建表单，填写配置直接生成 |

### 阶段 3：消息操作 + 产物内联
> 目标：IM 核心体验，消息操作 + 富媒体渲染

| # | 任务 | 依赖 | 涉及文件 | 验收标准 |
|---|------|------|----------|----------|
| 3.1 | 消息操作菜单 | 1.5 | src/components/message-actions.tsx | Web 端 `⋯` 图标，弹出回复/引用/重新生成/复制 |
| 3.2 | 回复引用机制 | 1.3, 3.1 | src/components/chat-area.tsx | replyToId → 引用预览条 + 气泡下方缩略 |
| 3.3 | 重新生成 | 3.1 | src/app/api/sessions/[id]/chat/route.ts | 传 regenerate: messageId，替换原消息 |
| 3.4 | 代码块渲染 | 1.4 | src/components/code-block.tsx | 语法高亮 + 复制按钮 |
| 3.5 | 网页预览卡片 | 1.4 | src/components/web-preview.tsx | iframe srcdoc + sandbox，HTML 预览 |
| 3.6 | 文件附件卡片 | 1.4 | src/components/file-attachment.tsx | 文件名+大小+下载 |
| 3.7 | Diff 视图卡片 | 1.4 | src/components/code-diff.tsx | Monaco DiffEditor + Accept/Reject |

### 阶段 4：Orchestrator 核心流程
> 目标：对齐流程 + 任务拆解 + 阶段控制

| # | 任务 | 依赖 | 涉及文件 | 验收标准 |
|---|------|------|----------|----------|
| 4.1 | 对齐流程：PM 确认需求 | 2.1 | src/lib/orchestrator/index.ts | Orchestrator @PM → 确认需求 → 用户确认 |
| 4.2 | 对齐流程：架构师方案+拆解 | 4.1 | src/lib/orchestrator/index.ts | 架构师出技术方案 + 任务拆解 + 依赖关系 |
| 4.3 | 对齐流程：其他 Agent 提问 | 4.2 | src/lib/orchestrator/index.ts | 其他 Agent 有机会提问 |
| 4.4 | 阶段控制 | 4.1-4.3 | src/lib/orchestrator/index.ts | 对齐 → 执行两阶段切换 |
| 4.5 | 任务依赖执行 | 4.4 | src/lib/orchestrator/scheduler.ts | 无依赖并行，有依赖等前置完成 |
| 4.6 | 任务 declaredFiles | 4.2 | src/lib/orchestrator/index.ts | 每个任务输出声明修改的文件列表 |

### 阶段 5：执行层 + 平台适配
> 目标：混合执行层 + OpenCode 接入 + 会话恢复

| # | 任务 | 依赖 | 涉及文件 | 验收标准 |
|---|------|------|----------|----------|
| 5.1 | LLM API 适配器 | 无 | src/lib/adapter/llm-adapter.ts | Vercel AI SDK 直连，用于分析/讨论 |
| 5.2 | Orchestrator 切换到 LLM API | 5.1 | src/lib/orchestrator/index.ts | 分析调用从 CLI 降到 0 个进程 |
| 5.3 | Agent 执行平台选择 | 5.1 | src/lib/adapter/index.ts | 根据 Agent.platform 路由到对应适配器 |
| 5.4 | OpenCode CLI 适配器 | 无 | src/lib/adapter/opencode-adapter.ts | opencode run --format json，流式输出 |
| 5.5 | sessionID 持久化 | 无 | prisma/schema.prisma, src/lib/adapter/ | CLI Agent 执行后提取 sessionID 存数据库 |
| 5.6 | 会话恢复 | 5.5 | src/lib/adapter/claude-code-adapter.ts | --resume sessionID 恢复上下文 |
| 5.7 | 工作区持久化 | 5.5 | src/lib/adapter/ | workspaces/{sessionId}/ 目录，关机不丢失 |

### 阶段 6：群聊协作 + 冲突处理
> 目标：群聊全员可见 + 代码冲突预防与合并

| # | 任务 | 依赖 | 涉及文件 | 验收标准 |
|---|------|------|----------|----------|
| 6.1 | 群聊消息全员可见 | 1.5 | src/app/api/sessions/[id]/chat/route.ts | 所有消息广播到群聊界面 |
| 6.2 | Orchestrator 群聊角色 | 4.4 | src/lib/orchestrator/index.ts | 主持人+监督者+纠偏者，关键节点介入 |
| 6.3 | 代码冲突：声明预防 | 4.6 | src/lib/orchestrator/scheduler.ts | 文件重叠任务排串行 |
| 6.4 | 代码冲突：合并审计 | 6.3 | src/lib/orchestrator/index.ts | 实际修改 vs 声明对比，越界抛 Diff 卡片 |
| 6.5 | 隔离工作区 | 5.7 | src/lib/adapter/ | workspaces/{sessionId}/task-{taskId}/ |

### 阶段 7：失败处理 + 质量保障
> 目标：错误分类重试 + 熔断 + 用户操作面板

| # | 任务 | 依赖 | 涉及文件 | 验收标准 |
|---|------|------|----------|----------|
| 7.1 | 错误分类与重试 | 5.1-5.4 | src/lib/adapter/ | 可重试/不可重试/半可重试分类 |
| 7.2 | 降级前能力检查 | 7.1 | src/lib/adapter/ | 检查 function calling、上下文窗口、输出格式 |
| 7.3 | 质量自动检测 | 4.5 | src/lib/orchestrator/ | 编译检查、断言检查、语义核对 |
| 7.4 | 纠偏熔断器 | 7.3 | src/lib/orchestrator/ | 同任务同 Agent 纠偏超 2 次终止 |
| 7.5 | 上下文隔离 | 7.1 | src/lib/adapter/ | 重试时回滚到任务开始前快照 |
| 7.6 | 阻塞传播 | 7.1 | src/lib/orchestrator/scheduler.ts | 依赖拓扑分析，只阻塞受影响下游 |
| 7.7 | 用户操作面板 | 7.6 | src/components/task-panel.tsx | 重试/跳过/回滚重做/手动修复 |

### 阶段 8：上下文管理 + 细节完善
> 目标：pin 消息 + 多轮迭代 + AI 协作规范

| # | 任务 | 依赖 | 涉及文件 | 验收标准 |
|---|------|------|----------|----------|
| 8.1 | Agent 级 pin 消息 | 1.3 | prisma/schema.prisma, API | 手动 pin 关键消息，Agent 级跨会话可见 |
| 8.2 | 多轮迭代修改 | 1.5 | src/app/api/sessions/[id]/chat/route.ts | 每轮完整保留，Agent 上下文含自己之前产出 |
| 8.3 | Agent 上下文组装 | 8.1, 8.2 | src/lib/adapter/ | 当前会话历史 + Agent 级 pin + reply 上下文 |
| 8.4 | Prompt 展示面板 | 无 | src/components/prompt-panel.tsx | 展示 Agent 的 System Prompt（答辩亮点） |
| 8.5 | AI 协作规范文档 | 无 | docs/ai-collaboration.md | 开发完成后从历史对话总结 Spec+Skill+Rules |

## 依赖关系图

```
阶段 1（基础层）
  ├── 1.1 SessionMember CRUD ──┐
  ├── 1.2 Agent 池管理 ────────┼──→ 阶段 2（Agent 管理）
  ├── 1.3 replyToId ───────────┼──→ 阶段 3（消息操作）
  ├── 1.4 消息解析器 ──────────┼──→ 阶段 3（产物内联）
  └── 1.5 前端适配 ────────────┘
                                    ↓
阶段 4（Orchestrator）← 依赖 2.1 预设 Agent
  ├── 4.1-4.3 对齐流程
  ├── 4.4 阶段控制
  ├── 4.5 任务依赖执行
  └── 4.6 declaredFiles
                                    ↓
阶段 5（执行层）← 可与阶段 4 并行
  ├── 5.1 LLM 适配器
  ├── 5.2 Orchestrator 用 LLM API
  ├── 5.3 平台路由
  ├── 5.4 OpenCode 适配器
  ├── 5.5-5.7 会话恢复
                                    ↓
阶段 6（群聊+冲突）← 依赖 4.6 + 5.7
阶段 7（失败处理）← 依赖 5.x + 4.5
阶段 8（上下文+细节）← 依赖 1.3 + 1.5
```

## 建议执行顺序

**第一批**（并行）：1.1 → 1.2 → 1.3 → 1.4 → 1.5
**第二批**（并行）：2.1-2.6 + 3.1-3.7
**第三批**（并行）：4.1-4.6 + 5.1-5.4
**第四批**（并行）：5.5-5.7 + 6.1-6.5
**第五批**（并行）：7.1-7.7 + 8.1-8.5

## P2 功能（后续）

- 一键部署（聊天中部署指令）
- 多端支持（桌面端 + 移动端）
- 部署状态卡片
- PPT 浏览卡片
