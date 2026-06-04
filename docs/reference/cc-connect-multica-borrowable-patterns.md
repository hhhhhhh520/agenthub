# CC-Connect & Multica 技术方案借鉴分析

> 生成时间: 2026-06-03 | 代码验证: 2026-06-03 | 分析对象: cc-connect、multica | 目标项目: agenthub

---

## 概述

基于对 CC-Connect 和 Multica 的代码级架构报告，筛选出对 AgentHub 有借鉴价值的技术方案。经过对 AgentHub 源码的逐项验证，**11 项初始建议中仅 2 项确认为真实问题**，其余要么现有方案已覆盖，要么属于过度设计。

---

## 确认需要修复的（2 项）

### 1. Session Lock 超时后静默并发

**严重程度**：中 | **文件**：`src/lib/session-lock.ts`

**问题**：锁 60 秒后静默失效。Agent 执行任务经常超过 60 秒（多 Agent 讨论、大段代码生成），超时后第二条消息进来，两个请求同时执行，SSE 事件交错输出，前端显示混乱。用户完全不知道发生了什么——没有报错，没有提示。

**代码证据**：
- `session-lock.ts:12` — `LOCK_TIMEOUT_MS = 60_000`
- `session-lock.ts:24` — catch 块为空，超时后静默放行
- `route.ts:95` — SSE 超时 5 分钟，但锁只有 1 分钟
- `use-chat.ts:35` — `loading` 是单个 boolean，无法区分多个并发请求

**修复方案**：
- 方案 A：超时后返回明确错误（SSE 推送 "上一条消息仍在处理中"），而非静默放行
- 方案 B：锁超时时间与 SSE 超时对齐（5 分钟），或改为永不超时（由 AbortSignal 控制释放）
- 方案 C：消息入队，Agent 空闲后自动处理下一条

**改动量**：小（~20 行）

---

### 2. Task 失败时错误信息丢失

**严重程度**：中 | **文件**：`src/lib/services/execution.ts`

**问题**：任务失败后用户只看到 `status: 'failed'`，不知道为什么失败。无法判断应该重试、换方案还是修配置。

**代码证据**：
- `execution.ts:114` — catch 块为空 `catch {}`，异常被吞掉
- `execution.ts:115-119` — 任务标记 failed，但错误信息未写入数据库
- Task schema 无 `failureReason` 字段
- 前端只收到 `task_status: { taskId, status: 'failed' }`，无诊断信息

**修复方案**：
- Task 表新增 `failureReason`（string，可选）
- catch 块中提取错误信息写入 `failureReason`
- SSE 事件携带错误摘要：`{ taskId, status: 'failed', reason: 'CLI process crashed' }`
- 前端在任务卡片上显示失败原因

**改动量**：小（schema 迁移 + ~30 行逻辑）

---

## 评估后排除的（9 项）

| 建议 | 排除理由 |
|------|----------|
| Streaming 节流 | 网络是瓶颈不是渲染。实测单 Agent 场景无卡顿，多 Agent 讨论也只有 3 轮，不会产生高频事件 |
| Agent 状态自动推导 | `updateAgentSessionStatus()` 用 `finally` 块保证重置，代码正确，无不一致风险 |
| 工厂注册模式 | 只有 3 个 adapter，switch-case 19 行，类型系统已约束 platform 为 3 个字面量。注册模式是过度设计 |
| 可选接口模式 | 3 个 adapter 各服务不同平台，没有"动态能力检测"需求。Orchestrator 已通过 platform 字段区分 |
| 任务自动重试 | 已有两层保护：ProcessRegistry 3 次重试 + 指数退避（process-registry.ts:48），execution.ts 2 次纠正重试（line 169）|
| 孤儿任务恢复 | 仅在 Node.js 进程本身崩溃时产生孤儿，属极端场景。正常重启 ProcessRegistry 会清理进程 |
| Hook 事件系统 | 497 个测试覆盖关键路径，console.log 够用。当前阶段不需要 webhook 基础设施 |
| 三阶段关闭 | SIGTERM → 5s → SIGKILL 在实践中够用。stdin close 只在 CLI 忽略 SIGTERM 时有意义，Claude Code CLI 不会 |
| 防自旋锁 / Squad 模式 | `MAX_ITERATIONS = tasks.length * 3` + `correctionCount <= 2` + `validateDecision` 阶段守卫，三层保护已够。Orchestrator 已是 leader 角色，当前规模不需要多层级 |

---

## 参考资料

- [CC-Connect Agent 架构报告](../新建文件夹/cc-connect-agent-architecture-report.md)
- [Multica Agent 架构报告](../新建文件夹/multica-agent-architecture-report.md)
- [AgentHub 设计决策](../design/agenthub-v2-design-decisions.md)
- [可借鉴设计模式](../design/borrowable-patterns.md)
