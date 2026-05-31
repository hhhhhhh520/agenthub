# AgentHub 项目进度
> 创建时间: 2026-05-22 | 最后更新: 2026-05-31

## 项目概述
**项目地址**: D:\ai全栈挑战赛\agenthub | **技术选型**: Next.js 16 + Prisma 7 + SQLite + Claude Code CLI | **目标**: IM 风格多 Agent 协作平台

## 当前进度

### ✅ 已完成
| 阶段 | 内容 | 完成日期 |
|------|------|----------|
| 基础框架 | Next.js 16 + Prisma 7 + SQLite + shadcn/ui | 2026-05-22 |
| 数据模型 v2 | Session/Agent/Task/Message/RecentDir | 2026-05-23 |
| Orchestrator 编排 | 8种 action + 安全校验 + 决策函数 | 2026-05-24 |
| CLI 适配器 | ClaudeCodeAdapter（stdin + bare + stream-json） | 2026-05-25 |
| 群聊 + 私聊 | 多会话类型 + Agent 成员管理 | 2026-05-25 |
| 全量审计 | 109项问题修复 | 2026-05-25 |
| 安全审计 | 9项修复 + API Key 双重掩码 | 2026-05-26 |
| 多供应商 | Agent 级 platform/model/baseUrl/apiKey | 2026-05-27 |
| QA 全流程 | 嵌套路由404 + 编码乱码 + mock 修复 | 2026-05-28 |
| 对齐流程 | PM确认+架构师方案+Agent提问 完整实现 | 2026-05-28 |
| 长驻进程 | ProcessRegistry 进程池复用+10分钟空闲回收 | 2026-05-29 |
| Agent状态同步 | idle→working→idle 生命周期+前端状态圆点 | 2026-05-29 |
| 6项代码修复 | 进程误杀+外键+并发权限+路径遍历+SSE错误+role对齐 | 2026-05-29 |
| ChatFab 私聊规划 | 计划文件+实现方案 | 2026-05-29 |
| CLI 进程恢复重试 | ProcessRegistry.send() 崩溃检测+自动重试+60s超时兜底 | 2026-05-30 |
| 单Agent纠偏审查 | delegate/@提及/私聊/discuss 4路径+reviewResult+quality标记 | 2026-05-30 |
| 任务重做功能 | failed/blocked任务重做+编辑描述+级联执行下游任务 | 2026-05-30 |
| 错误分类与指数退避 | 永久错误不重试+瞬时错误指数退避1s→2s→4s+重试3次 | 2026-05-30 |
| 纠偏计数器持久化 | Task.correctionCount字段+重启不丢失 | 2026-05-30 |
| ProcessRegistry优雅关闭 | SIGTERM→5s→SIGKILL+信号处理注册 | 2026-05-30 |
| Agent状态Per-Session | SessionMember.status替代Agent.status+独立会话状态 | 2026-05-30 |
| God Function拆分 | chat/route.ts 1102行→191行+7个service模块 | 2026-05-30 |
| ChatFab 私聊功能 | Mock→真实API：useChatFab hook + sessions members include | 2026-05-31 |

### ⏳ 进行中
| 任务 | 状态 |
|------|------|
| （暂无） | |

### 📋 待办（2026-05-31 更新）

| 优先级 | 任务 | 说明 | ISSUE |
|--------|------|------|-------|
| 🔴高 | Pin 消息 | Agent 级长期上下文未实现 | CTX-001 |
| 🟡中 | 持续监督机制 | 只在任务完成后审查 | ORC-003 |
| 🟡中 | 确定性质量检测 | 无编译/测试/Schema验证 | FAIL-003 |
| 🟡中 | 工具集 UI 选择器 | 基础设施已有，缺前端配置界面 | TOOL-001 |
| 🟡中 | Diff Accept 修改检测 | 写入前无 mtime/hash 对比 | DIFF-001 |
| 🟡中 | 任务恢复提示 | 加载会话时不检查待处理任务 | RECOVER-001 |
| 🟡中 | 全链路 trace | 无结构化执行日志 | FAIL-007 |
| 🟢低 | 会话列表头像拼图 | 无 Agent 头像聚合展示 | UI-001 |

**已关闭（代码已实现但文档未更新）**：
- ISSUE-ORC-001（对齐流程）— handlePMConfirm/handleArchitectPlan/handleAgentQA 已完整接入
- ISSUE-CLI-001（长驻进程）— ProcessRegistry 进程池复用 + globalThis 持久化 + 10 分钟空闲回收
- ISSUE-AGENT-001（状态同步）— idle→working→idle 生命周期 + 前端状态圆点
- ISSUE-019（删除会话按钮）— 嵌套路由修复后已解决
- FAIL-001（CLI 错误分类与指数退避）— 永久/瞬时错误分类 + 指数退避 1s→2s→4s
- FAIL-004（纠偏计数器持久化）— Task.correctionCount 字段 + 重启不丢失
- ORC-002（纠偏覆盖单 Agent）— 4路径审查 + quality 标记
