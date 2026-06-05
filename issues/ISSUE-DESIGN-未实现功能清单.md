# AgentHub 设计功能未实现问题清单
> 创建时间: 2026-05-23 | 状态: 🟡部分解决 | 最后更新: 2026-05-31

## 问题概述

对设计文档 `docs/design/agenthub-v2-design-decisions.md` 中的 22 项决策进行全面检查，发现以下功能未实现或不完整。

---

## 一、Orchestrator 纠错行为（已记录）

详见 `issues/ISSUE-ORC-orchestrator纠偏缺失.md`

**状态更新（2026-06-04 验证）**：ISSUE-ORC-001（对齐流程）已完整实现。ISSUE-ORC-002（纠偏范围）部分解决 — 批量执行中所有 Agent 都被审查，但单 Agent 调用路径无监控。ISSUE-ORC-003 不实施。ISSUE-ORC-004（阶段控制）已实现 — Session 表有 phase/phaseStep 字段，chat-router.ts 有 validateDecision() 强制阶段转换，OrchestratorDecision 有 8 种 action（含 align_confirm/align_decompose/align_qa/execute）。

---

## 二、失败处理策略未实现

**设计文档位置**: 第 398-482 行

### ISSUE-FAIL-001: 错误分类与重试策略 — 🟢已解决 (2026-05-30)

**设计要求**（第 400-408 行）：
| 错误类型 | 策略 |
|----------|------|
| 可重试（429、网络错误、超时） | 重试 + 指数退避 |
| 不可重试（API Key 错误、权限不足） | 直接终止 |
| 半可重试（返回格式错误） | 重试时调整 prompt |

**实际状态**: ✅ 已完整实现
- ✅ CLI 进程崩溃自动重试：ProcessRegistry.send() 支持最多 1 次重试，检测进程退出和 60s 无数据超时
- ✅ 进程重建：崩溃后自动 kill 旧进程 + spawnProcess 重建 + 重发 prompt
- ✅ 重试状态通知：yield status chunk 标记重试中
- ✅ 错误分类：`isPermanentError()` 区分永久错误（API_KEY_INVALID 等）和瞬时错误
- ✅ 指数退避：瞬时错误指数退避 1s→2s→4s，最多重试 3 次
- ✅ 永久错误不重试：直接终止并通知用户

**相关文件**: `src/lib/adapter/process-registry.ts`, `src/lib/adapter/types.ts`

---

### ISSUE-FAIL-002: 降级前的能力检查未实现

**设计要求**（第 410-418 行）：
降级到备用模型前必须检查：
- 备用模型是否支持同样的 function calling / tool use
- 上下文窗口是否够大
- 输出格式约束能否满足

**实际状态**: ❌ 未实现
- 没有降级机制
- 没有能力检查逻辑

---

### ISSUE-FAIL-003: 质量自动检测机制 — ⚪不实施 (2026-05-31)

**设计要求**（第 420-429 行）：
| 检测方式 | 适用场景 |
|----------|---------|
| 产物编译/解析 | 代码类 |
| 断言检查 | 测试类 |
| 语义核对 | 通用 |
| 结构化输出校验 | JSON 类 |

**评估结论**: 不作为平台功能实施，应由 Code Review Agent 在工作流中完成。
- 编译/语法/测试检查是 Code Review Agent 的职责，非平台基础设施
- Orchestrator 在 `align_decompose` 阶段拆任务时，自动在编码任务后插入审查任务即可
- 现有 LLM 语义核对（`buildMonitoringPrompt` + `callLLMForAnalysis`）+ Git 越界检测作为平台级兜底已足够

**已实现的平台级检测**:
- ✅ LLM 语义核对：批量执行后审查所有 Agent 结果
- ✅ Git 文件越界检测：`getChangedFiles` 对比 declaredFiles 与实际改动

---

### ISSUE-FAIL-004: 纠偏熔断器 — 🟢已解决 (2026-05-30)

**设计要求**（第 431-439 行）：
```
同一个任务 + 同一 Agent：
  纠偏超过 2 次仍不合格 → 直接终止
  → 通知用户，附带每次产出差异
```

**实际状态**: ✅ 已实现
- ✅ 重试上限已实现：`chat/route.ts:761-769` 有 `_correctionRetryCount` 计数器，2 次后停止纠偏并通知用户
- ✅ 计数器已持久化：`Task.correctionCount` 字段，重启不丢失
- ❌ 无产出差异比较：熔断时只发简单文本消息，未附带每次产出差异

---

### ISSUE-FAIL-005: 重试时的上下文隔离未实现

**设计要求**（第 441-447 行）：
- 回滚到任务开始前的上下文快照
- 防止上一次的错误输出污染新一轮执行
- 非幂等操作标记 `unsafe_to_retry`

**实际状态**: ⚠️ 部分实现
- 有 `takeSnapshot` 函数（`src/lib/workspace.ts:33`）
- 但没有回滚逻辑
- 没有 `unsafe_to_retry` 标记

---

### ISSUE-FAIL-006: 用户操作面板 — 🟢已解决

**设计要求**（第 463-472 行）：
| 操作 | 说明 |
|------|------|
| 重试 | 可以改参数/换模型后重试 |
| 跳过 | 标记为"人工完成"，解除下游阻塞 |
| 回滚重做 | 修改任务描述后重新分配 |
| 手动修复 | 用户直接修改产物，然后继续流水线 |

**实际状态**: 🟢 已实现（2026-05-30 更新）
- ✅ 重做功能已实现：failed/blocked 任务可通过 UI 点击"重做"按钮，弹出编辑描述的对话框，确认后重新执行
- ✅ 级联执行：重做成功后自动执行下游依赖任务
- ✅ 下游解阻塞：重做时 blocked 的下游任务改为 pending
- ❌ 跳过功能未实现：经讨论后决定不做跳过 — 跳过意味着下游在缺失前置产出的情况下执行，结果不可用
- ❌ 手动修复未实现：功能等同跳过，同样不做

**实现方式**：
- 后端 API: `POST /api/sessions/{id}/tasks/{taskId}/redo` — 验证状态、更新描述、重置为 pending、执行任务、级联执行下游
- 前端: `agent-panel.tsx` — failed/blocked 任务卡片加"重做"按钮 + 编辑描述弹窗
- 不修改现有 `handleExecution` 逻辑 — redo 是独立路径

**相关文件**: `src/app/api/sessions/[id]/tasks/[taskId]/redo/route.ts`, `src/components/agent-panel.tsx`

---

### ISSUE-FAIL-007: 全链路可观测 — 🟢已解决 (2026-06-05)

**设计要求**（第 474-481 行）：
- 任务为什么失败？（错误类型、错误信息）
- 重试了几次？每次的错误有什么不同？
- 降级到哪个模型了？效果如何？
- Orchestrator 为什么没发现跑偏？

**实际状态**: ✅ 已实现
- Task 表新增 `trace` JSON 字段，记录结构化执行轨迹
- 5 种事件类型：`start`（含 agent 名）、`error`（含错误信息）、`success`、`correction`（含 attempt 次数）、`blocked`（含原因）
- `execution.ts` 各关键节点写入 trace（任务开始、成功、失败、纠偏、阻塞）
- `agent-panel.tsx` Task 卡片可展开查看 trace 详情
- 4 个针对性测试覆盖

**相关文件**: `prisma/schema.prisma`, `src/lib/services/execution.ts`, `src/components/agent-panel.tsx`, `tests/execution-trace.test.ts`

---

## 三、上下文管理功能缺失

**设计文档位置**: 第 379-386 行

### ISSUE-CTX-001: Pin 消息 — 🟢已解决 (2026-05-31)

**设计要求**（第 382 行）：
> 长期上下文: 用户手动 pin 关键消息，绑定到 Agent（Agent 级，跨会话可见）

**实际状态**: ✅ 已实现
- `Message.isPinned` 字段（Boolean，默认 false）
- `PATCH /api/sessions/[id]/messages/[messageId]` API，每会话最多 10 条
- `context-builder.ts` 将 pinned 消息优先插入上下文顶部
- 前端：消息右键菜单 "Pin/取消 Pin"，pinned 消息显示图钉图标

**相关文件**: `prisma/schema.prisma`, `src/app/api/sessions/[id]/messages/[messageId]/route.ts`, `src/lib/services/context-builder.ts`, `src/components/chat-area.tsx`, `src/components/message-action-menu.tsx`

---

### ISSUE-CTX-002: 多轮迭代修改记录未实现

**设计要求**（第 384-386 行）：
> 每轮对话完整保留，Agent 的上下文包含自己之前产出的工件

**实际状态**: ⚠️ 部分实现
- 对话历史有保留（`take: 20`）
- 但没有"产出工件"的显式关联
- Message 表有 `taskId` 字段但未充分使用

---

## 四、对齐流程 — 🟢已解决

**设计文档位置**: 第 61-93 行

> **状态更新（2026-05-30 验证）**：对齐流程已完整实现，ISSUE-ALIGN-001 和 ISSUE-ALIGN-002 可关闭。
> 详见 `issues/ISSUE-ORC-orchestrator纠偏缺失.md` 中 ISSUE-ORC-001 的更新说明。

### ISSUE-ALIGN-001: PM 需求确认阶段 — 🟢已解决

**原问题**：`PM_CONFIRMATION_PROMPT` 已定义但未使用。

**实际状态**: ✅ 已实现 — `handlePMConfirm()` (route.ts:850-927) 使用 `PM_CONFIRMATION_PROMPT` 调用产品经理确认需求。

### ISSUE-ALIGN-002: Agent 提问澄清阶段 — 🟢已解决

**原问题**：`buildAgentQuestionPrompt` 已定义但未使用。

**实际状态**: ✅ 已实现 — `handleAgentQA()` (route.ts:1021-1088) 并行调用所有 Agent 使用 `buildAgentQuestionPrompt` 提问。

---

## 五、工具集管理未实现

**设计文档位置**: 第 275-279 行

### ISSUE-TOOL-001: 工具集硬限制 — 🟢已解决 (2026-06-04)

**设计要求**（第 276 行）：
> 后端维护工具集预设映射：`"代码读写" → [Read, Write, Edit]`、`"命令执行" → [Bash]` 等

**实际状态**: 🟢 已实现（2026-06-04 验证）
- ✅ 数据模型已存在：`Agent.tools` (string[], schema.prisma:39) + `Agent.capabilities` (JSON, schema.prisma:51)
- ✅ 运行时工具提示注入：`executeSingleAgent` 读取 `agent.tools` 并在 system prompt 中注入 `[可用工具: ...]`（软引导）
- ✅ Agent 推荐 API 已实现：`/api/sessions/recommend-agents` 根据任务描述匹配 Agent
- ✅ **Claude Code 硬限制**：`--allowedTools` / `--disallowedTools` CLI 参数传递（`process-registry.ts`）
- ✅ **OpenCode 硬限制**：临时 `opencode.json` 配置文件 + `OPENCODE_CONFIG` 环境变量注入（`process-registry.ts`）
- ✅ **工具名映射**：`Write` → `edit`、`Agent` → `task`、`AskUserQuestion` → `question` 等（`TOOL_NAME_MAP`）
- ✅ **进程隔离**：tools hash 附加到 registry key，不同工具配置不复用进程
- ✅ **OPENCODE_PERMISSION 冲突处理**：有工具限制时移除 `{"*":"allow"}`
- ❌ 无前端 UI 工具选择器：创建 Agent 时无法配置工具集（预设 Agent 已有 tools，用户自建通过 API 传入）
- ❌ 无 MCP tools 或 function calling 加载逻辑

**相关文件**: `src/lib/adapter/types.ts`, `src/lib/adapter/process-registry.ts`, `src/lib/adapter/claude-code-adapter.ts`, `src/lib/adapter/opencode-adapter.ts`, `src/lib/orchestrator/index.ts`, `tests/tool-restriction.test.ts`

---

### ISSUE-TOOL-002: Orchestrator 自动推荐工具集 — 🟡部分实现

**设计要求**（第 277 行）：
> Orchestrator 根据用户描述组合工具集

**实际状态**: 🟡 部分实现（2026-05-30 验证）
- ✅ Agent 推荐 API 已实现：`/api/sessions/recommend-agents` 根据任务描述匹配 Agent（含能力匹配）
- ✅ 运行时工具注入：`executeSingleAgent` 读取 `agent.tools` 并注入 system prompt
- ❌ 对话式创建 Agent 时无工具推荐：创建流程不推荐工具子集
- ❌ 表单创建时无工具选择 UI

---

## 六、Diff Accept 文件修改检测未实现

**设计文档位置**: 第 220 行

### ISSUE-DIFF-001: Accept 前文件修改检测 — 🟢已解决 (2026-06-05)

**设计要求**（第 220 行）：
> Accept 前检查文件是否被用户手动修改过，不一致则提示"文件已被修改，是否覆盖？"

**实际状态**: ✅ 已实现
- `files/accept/route.ts` 写入前用 md5 对比当前文件内容与待写入内容
- 不一致返回 `409 { error: 'file_modified' }`，前端弹确认框
- 确认后带 `force: true` 重试跳过检查
- 新文件（不存在）跳过检查
- 8 个针对性测试覆盖

**相关文件**: `src/app/api/sessions/[id]/files/accept/route.ts`, `src/components/chat-area.tsx`, `tests/api-files-accept.test.ts`

---

## 七、CLI 进程管理未实现长驻模式

**设计文档位置**: 第 133-151 行

### ISSUE-CLI-001: 长驻进程模式 — 🟢已解决 (2026-05-30 验证)

**设计要求**（第 135-138 行）：
| 场景 | 模式 | 实现方式 |
|------|------|----------|
| 当前会话活跃时 | 长驻进程 | `--input-format stream-json` + stdin/stdout JSON 管道，进程保持活着 |

**实际状态**: ✅ 已完整实现
- ProcessRegistry 使用 `globalThis.__processRegistry` 持久化进程池（route.ts 重载后仍存活）
- `getOrCreate()` 查找已有活跃进程并复用，不再每次 spawn 新进程
- `IDLE_TIMEOUT_MS = 10 minutes` — 仅空闲且超时才清理，working 进程不受影响
- `MAX_PROCESSES = 10`，超出时 LRU 淘汰最旧空闲进程
- `state: 'idle' | 'working'` 状态追踪，send() 时 working，完成后 idle

---

## 八、任务恢复提示未实现

**设计文档位置**: 第 148-149 行

### ISSUE-RECOVER-001: 未完成任务恢复提示 — 🟢已解决 (2026-06-05)

**设计要求**（第 149 行）：
> 用户重新打开会话时，检查有没有 `in_progress` 状态的任务，提示用户「上次有未完成的任务，是否继续？」

**实际状态**: ✅ 已实现
- GET `/api/sessions/[id]` 自动重置超过 5 分钟未更新的 `in_progress` 任务为 `pending`，返回 `recoveredTaskCount`
- 前端 `chat-area.tsx` 收到 `recoveredTaskCount > 0` 时弹 Dialog："上次有 N 个任务未完成，是否继续执行？"
- 点"继续执行"触发 `send()`，点"跳过"关闭弹窗

**相关文件**: `src/app/api/sessions/[id]/route.ts`, `src/components/chat-area.tsx`

---

## 九、Agent 状态同步不完整

**设计文档位置**: 第 305 行

### ISSUE-AGENT-001: Agent 状态由 Orchestrator 更新 — 🟢已解决 (2026-05-30 验证)

**设计要求**（第 305 行）：
> 后端维护 `idle / working / done / error` 四个状态，由 Orchestrator 在任务生命周期中更新

**实际状态**: ✅ 已完整实现
- `executeTaskBatch` (orchestrator/index.ts:228): 执行前 `prisma.agent.update({ status: 'working' })`
- `executeSingleAgent` (orchestrator/index.ts:313): 同样有 `working→idle` 生命周期
- 两个函数都在 `finally` 块中执行 `prisma.agent.update({ status: 'idle' })`，确保异常时也不遗漏
- 前端渲染：`agent-panel.tsx` STATUS_COLORS 状态圆点，`agents/page.tsx` 状态标签

---

## 十、会话列表 Agent 头像拼图未实现

**设计文档位置**: 第 303 行

### ISSUE-UI-001: 群聊会话头像拼图未实现

**设计要求**（第 303 行）：
> 会话列表：群聊会话显示参与的 Agent 头像拼图

**实际状态**: ❌ 未实现
- 会话列表只显示标题，没有头像拼图

---

## 汇总

### 排除未开发功能后的问题清单

**设计文档明确标记为"后续再做/P2/暂不实现"的功能**（不计入）：
- 一键部署（第 500 行）
- 多端支持（第 501 行）
- Prompt 展示面板（第 491 行"暂不实现"）
- 部署状态/PPT 浏览（第 494 行 P2）
- 桌面端右键菜单/手机端长按（第 158-159 行 P2）

**已确定设计但未实现的功能**（应计入）：

| ISSUE ID | 问题 | 设计位置 | 严重程度 | 状态 |
|----------|------|----------|----------|------|
| ISSUE-ORC-001 | 对齐流程（PM 确认、Agent 提问） | 第 61-93 行 | **高** | 🟢已解决 |
| ISSUE-ORC-002 | 纠偏范围（批量执行已全平台，单 Agent 调用缺失） | route.ts:747-773 | **高** | 🟡部分解决 |
| ISSUE-ORC-003 | 无持续监督机制，只在任务完成后审查 | 第 311-316 行 | 中 | ⚪不实施 |
| ISSUE-ORC-004 | 无显式阶段切换控制 | 第 57-59 行 | 中 | 🟢已解决 |
| ISSUE-FAIL-001 | CLI 进程崩溃重试（无错误分类/指数退避） | 第 400-408 行 | **高** | 🟢已解决 |
| ISSUE-FAIL-002 | 无降级能力检查 | 第 410-418 行 | 中 | ❌ |
| ISSUE-FAIL-003 | 无确定性质量检测机制 | 第 420-429 行 | 中 | ⚪不实施 |
| ISSUE-FAIL-004 | 纠偏熔断器计数器未持久化 | 第 431-439 行 | 中 | 🟢已解决 |
| ISSUE-FAIL-006 | 无用户操作面板（重试/跳过/回滚） | 第 463-472 行 | **高** | ❌ |
| ISSUE-FAIL-007 | 无全链路可观测 trace | 第 474-481 行 | 中 | 🟢已解决 |
| ISSUE-CTX-001 | Agent 级 pin 消息未实现 | 第 382 行 | **高** | 🟢已解决 |
| ISSUE-TOOL-001 | 工具集硬限制 | 第 276 行 | 中 | 🟢已解决 |
| ISSUE-TOOL-002 | Orchestrator 工具推荐 UI 缺失 | 第 277 行 | 中 | 🟡部分解决 |
| ISSUE-DIFF-001 | Diff Accept 前无文件修改检测 | 第 220 行 | 中 | 🟢已解决 |
| ISSUE-CLI-001 | 长驻进程模式 | 第 135-138 行 | 低 | 🟢已解决 |
| ISSUE-RECOVER-001 | 无未完成任务恢复提示 | 第 149 行 | 中 | 🟢已解决 |
| ISSUE-AGENT-001 | Agent 状态未在任务生命周期更新 | 第 305 行 | 低 | 🟢已解决 |
| ISSUE-UI-001 | 会话列表无 Agent 头像拼图 | 第 303 行 | 低 | ❌ |

**排除项**（设计文档已确定但标记为后续开发）：
- ISSUE-FAIL-005（上下文隔离回滚）：有 snapshot 但无回滚，属失败处理子项
- ISSUE-CTX-002（多轮工件关联）：有部分实现，影响较小
- ISSUE-ALIGN-001/002：与 ISSUE-ORC-001 合并（对齐流程）

**实际需要解决的问题**: **15 项**

| 优先级 | 数量 | 问题 |
|--------|------|------|
| **高** | 2 | 纠偏范围、用户操作面板 |
| 中 | 9 | 监督机制、阶段控制、降级检查、质量检测、trace、工具集、Diff检测、任务恢复、熔断差异比较 |
| 低 | 4 | 长驻进程、Agent状态更新、头像拼图、上下文隔离回滚 |

---

## 相关文件

- 设计文档: `docs/design/agenthub-v2-design-decisions.md`
- Orchestrator 主逻辑: `src/app/api/sessions/[id]/chat/route.ts`
- 适配器实现: `src/lib/adapter/*.ts`
- 工作区管理: `src/lib/workspace.ts`
- 数据模型: `prisma/schema.prisma`
- Prompt 定义: `src/lib/orchestrator/prompts.ts`