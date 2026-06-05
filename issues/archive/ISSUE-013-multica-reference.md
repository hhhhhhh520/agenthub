# Multica 参考分析：可借鉴的 UI 模式和功能实现
> 创建时间: 2026-05-21 | 状态: 📋 参考文档

## 项目概况

Multica 是一个成熟的多 Agent 协作平台，monorepo 架构（pnpm + Turborepo），Go 后端 + Next.js 16 前端。

**技术栈对比**：

| 维度 | Multica | AgentHub |
|------|---------|----------|
| 框架 | Next.js 16 + React 19 | Next.js 16 |
| 状态管理 | Zustand 5 + TanStack Query 5 | useState + fetch |
| UI | shadcn/ui + Base UI | shadcn/ui |
| 富文本 | Tiptap | 无 |
| 表格 | TanStack Table 8 | 无 |
| 图标 | Lucide React | 无统一图标库 |
| 拖拽 | @dnd-kit | 无 |
| 实时 | WebSocket | SSE |
| 后端 | Go + PostgreSQL | Prisma + SQLite |
| 桌面端 | Electron | 无 |

---

## 可借鉴的功能点

### 1. 侧边栏导航结构（高优先级）

Multica 的侧边栏分三组：
- **个人**：收件箱、我的 Issue
- **工作区**：Issue、项目、自动化、Agent、小队、用量
- **配置**：运行时、Skill、设置

**AgentHub 可借鉴**：
- 当前只有会话列表，可以加"Agent 管理"独立页面
- 会话列表上方加筛选（全部/我的/群聊/私聊）
- 底部加"设置"入口

**关键文件**：`packages/views/layout/app-sidebar.tsx`（733 行）

### 2. Agent 详情页 + 内联编辑（高优先级）

Multica 用 320px 左侧 Inspector 面板做 Agent 编辑，不是弹窗：
- 头像可上传
- 名称/描述内联弹窗编辑
- Runtime/Model/Visibility 都是独立 Picker
- Skill 多选附加
- 只读模式下 Picker 退化为静态 Badge

**AgentHub 可借鉴**：
- Agent 卡片点击 → 展开详情面板（而非弹窗编辑）
- 每个配置项独立 Picker，不用一个大表单
- 只读/编辑权限控制

**关键文件**：`packages/views/agents/components/agent-detail-inspector.tsx`

### 3. Issue 三视图（中优先级）

Multica Issue 支持 List / Board (Kanban) / Gantt 三种视图，共享同一份数据和筛选状态。

**AgentHub 可借鉴**：
- Task 看板目前只有列表，可加 Board 视图
- 用 `react-resizable-panels` 做可调宽度的分栏

**关键文件**：`packages/views/issues/components/board-view.tsx`、`gantt-view.tsx`

### 4. 小队 (Squad) 路由层（中优先级）

Squad = Agent 团队，有 Leader Agent。Issue 分配给 Squad → Leader 决定谁执行。

**AgentHub 可借鉴**：
- 当前 Orchestrator 直接分配任务给 Agent
- 可以加"小组"概念，Orchestrator 分配给小组 → 小组内自动调度
- 对应设计文档的"群聊结构"

**关键文件**：`packages/views/squads/components/squad-detail-page.tsx`（52KB）

### 5. Skill 系统（中优先级）

Skill = 可复用的指令集，可附加到 Agent。支持多文件（SKILL.md + 辅助文件）。

**AgentHub 可借鉴**：
- 当前 System Prompt 写死在 Agent 配置里
- 可以抽成独立的 Skill 实体，Agent 按需附加
- 对应设计文档第 19 项"工具集管理"

**关键文件**：`packages/views/skills/components/skill-detail-page.tsx`

### 6. 全局搜索 + 快捷键（低优先级）

- `C` 键全局创建 Issue
- `cmdk` 命令面板搜索 Issue/Agent/Project
- 草稿持久化（未完成的创建可中断恢复）

**关键文件**：`packages/views/search/`

### 7. 实时状态（低优先级）

- Agent 在线/离线/不稳定状态通过 WebSocket 推送
- Task 执行进度实时更新
- 活动热力图

**AgentHub 当前**：SSE 流式输出，够用但不支持双向通信。

---

## 不需要借鉴的

| Multica 特性 | 为什么不需要 |
|---|---|
| Electron 桌面端 | 20 天比赛不做桌面端 |
| Go 后端 | Prisma + SQLite 够用 |
| 国际化 (i18n) | 中文项目，不需要 |
| PostHog 分析 | 比赛项目不需要 |
| Autopilot 自动化 | P2，后续再做 |
| PR 追踪 | 不涉及 Git 集成 |

---

## 实现优先级排序

| 优先级 | 功能 | 复杂度 | 价值 |
|---|---|---|---|
| P1 | Agent 详情页 + 内联编辑 | 中 | 高（答辩展示） |
| P1 | 侧边栏导航优化 | 低 | 中（用户体验） |
| P2 | Task Board 视图 | 中 | 中（可视化） |
| P2 | Skill 系统 | 高 | 中（设计文档要求） |
| P3 | 小队路由层 | 高 | 中（架构改进） |
| P3 | 全局搜索 | 中 | 低（锦上添花） |
