# 可借鉴设计模式

> 来源：cc-connect、multica、Anthropic Managed Agents
> 记录时间：2026-05-27

---

## P0 — Session TryLock（cc-connect）

**问题：** 同一会话多人同时发消息可能冲突，没有并发控制。

**方案：** cc-connect 的 `TryLock()/Unlock()` 模式，同一会话加锁，防重复处理。

**参考：** `cc-connect/core/session.go`

---

## P1 — 分类重试（multica）

**问题：** 任务失败直接标记失败，没有重试机制。

**方案：** 区分基础设施故障和逻辑错误，只重试前者：
- 可重试：`runtime_offline`、`timeout`、进程崩溃
- 不可重试：Agent 逻辑错误、格式解析失败

**参考：** `multica/server/internal/service/autopilot.go` 的 `MaybeRetryFailedTask`

---

## P1 — 预检门控（multica）

**问题：** 不管 Agent 状态直接派发任务，可能白等或失败。

**方案：** 派发前先检查：
- Agent 是否在线
- Agent 是否空闲
- 权限是否匹配

检查不通过就跳过，记录 `skipped` 状态。

**参考：** `multica/server/internal/service/autopilot.go` 的 `shouldSkipDispatch`

---

## P2 — 熔断器（multica）

**问题：** Orchestrator 或任务连续失败时持续执行，浪费资源。

**方案：** 连续失败率超过阈值时自动暂停：
- 阈值：90% 失败率
- 窗口：7 天
- 最少执行次数：50 次
- 触发后通知用户

**参考：** `multica/server/internal/service/autopilot_failure_monitor.go`

---

## P2 — 插件注册表（cc-connect）

**问题：** adapter 硬编码 if-else，加新平台要改核心代码。

**方案：** Agent 类型通过注册表自注册，核心不依赖具体实现：
- `RegisterAgent("name", factory)` 注册
- `GetAgent("name")` 获取
- 新增平台只需加一个模块

**参考：** `cc-connect/core/registry.go`

---

## P3 — Scoped Toolsets（Anthropic）

**问题：** 所有 Agent 都能用所有工具，权限过大。

**方案：** Agent 表加 `tools` 字段，限制每个 Agent 能用的工具范围。例如：
- 前端工程师：只能读写文件、执行 npm 命令
- 测试工程师：只能运行测试、读文件
- 架构师：只读，不能写

**参考：** Anthropic Managed Agents 的 scoped toolsets 设计

---

## P3 — Vault 凭证保险箱（Anthropic）

**问题：** API Key 明文存在数据库，安全性差。

**方案：** 敏感信息加密存储，运行时注入到会话中：
- 存储：加密后的密文
- 读取：解密后注入环境变量
- 不写入日志

**参考：** Anthropic Managed Agents 的 Vault 概念
