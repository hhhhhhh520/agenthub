# 可借鉴设计模式

> 来源：cc-connect、multica、Anthropic Managed Agents
> 记录时间：2026-05-27 | 代码验证: 2026-06-03
>
> **2026-06-03 更新**：经代码级验证，以下 7 个模式中大部分已实现或不需要。
> 仅剩 2 个真实 bug 待修复，详见 [cc-connect-multica-borrowable-patterns.md](../reference/cc-connect-multica-borrowable-patterns.md)

---

## P0 — Session TryLock（cc-connect）— ✅ 已实现，有 bug

**问题：** 同一会话多人同时发消息可能冲突，没有并发控制。

**方案：** cc-connect 的 `TryLock()/Unlock()` 模式，同一会话加锁，防重复处理。

**参考：** `cc-connect/core/session.go`

**现状**：已实现（`session-lock.ts`），但 60s 超时后静默放行导致并发。需修复。

---

## P1 — 分类重试（multica）— ✅ 已实现

**问题：** 任务失败直接标记失败，没有重试机制。

**方案：** 区分基础设施故障和逻辑错误，只重试前者：
- 可重试：`runtime_offline`、`timeout`、进程崩溃
- 不可重试：Agent 逻辑错误、格式解析失败

**参考：** `multica/server/internal/service/autopilot.go` 的 `MaybeRetryFailedTask`

**现状**：已实现。ProcessRegistry 3 次重试 + 指数退避（1s/2s/4s），execution.ts 2 次纠正重试。但失败时错误信息被吞掉（catch {}），需修复。

---

## P1 — 预检门控（multica）— ❌ 不需要

**问题：** 不管 Agent 状态直接派发任务，可能白等或失败。

**方案：** 派发前先检查：
- Agent 是否在线
- Agent 是否空闲
- 权限是否匹配

检查不通过就跳过，记录 `skipped` 状态。

**参考：** `multica/server/internal/service/autopilot.go` 的 `shouldSkipDispatch`

**现状**：不需要。AgentHub 通过 SessionMember.status + finally 块管理状态，Orchestrator 决策时已知 Agent 列表。

---

## P2 — 熔断器（multica）— ❌ 不需要

**问题：** Orchestrator 或任务连续失败时持续执行，浪费资源。

**方案：** 连续失败率超过阈值时自动暂停：
- 阈值：90% 失败率
- 窗口：7 天
- 最少执行次数：50 次
- 触发后通知用户

**参考：** `multica/server/internal/service/autopilot_failure_monitor.go`

**现状**：不需要。MAX_ITERATIONS = tasks.length * 3 + correctionCount <= 2 + validateDecision 阶段守卫，三层保护已覆盖。

---

## P2 — 插件注册表（cc-connect）— ❌ 不需要

**问题：** adapter 硬编码 if-else，加新平台要改核心代码。

**方案：** Agent 类型通过注册表自注册，核心不依赖具体实现：
- `RegisterAgent("name", factory)` 注册
- `GetAgent("name")` 获取
- 新增平台只需加一个模块

**参考：** `cc-connect/core/registry.go`

**现状**：不需要。只有 3 个 adapter，switch-case 19 行，类型系统已约束 platform 为 3 个字面量。注册模式是过度设计。

---

## P3 — Scoped Toolsets（Anthropic）— ⏳ 部分实现

**问题：** 所有 Agent 都能用所有工具，权限过大。

**方案：** Agent 表加 `tools` 字段，限制每个 Agent 能用的工具范围。例如：
- 前端工程师：只能读写文件、执行 npm 命令
- 测试工程师：只能运行测试、读文件
- 架构师：只读，不能写

**参考：** Anthropic Managed Agents 的 scoped toolsets 设计

**现状**：Agent.tools 字段已存在（JSON 数组），但执行时仅 prompt 提示无硬限制。对应 PROGRESS.md 待办 TOOL-001。

---

## P3 — Vault 凭证保险箱（Anthropic）— ❌ 不需要

**问题：** API Key 明文存在数据库，安全性差。

**方案：** 敏感信息加密存储，运行时注入到会话中：
- 存储：加密后的密文
- 读取：解密后注入环境变量
- 不写入日志

**参考：** Anthropic Managed Agents 的 Vault 概念

**现状**：不需要。比赛项目 scope 内，API key 已通过 Prisma select 排除（GET 不返回），环境变量占位符方案过度设计。
