# 对齐流程接入实现计划 — Orchestrator 智能编排

> 创建时间: 2026-05-25 | 状态: 🟢已完成

## Context

对齐流程的 prompts、DB schema、前端 UI 都已定义但从未接入。设计原则：**每条用户消息都走 Orchestrator 决策**，不做 phaseStep 硬路由。Orchestrator 根据对话上下文自主决定下一步（可跳步、追问、自由编排）。

## 设计核心

扩展 action 类型让 Orchestrator 表达"下一步做什么"：

| action | 含义 | handler |
|--------|------|---------|
| `self` | Orchestrator 自己回答 | handleOrchestratorChat |
| `delegate` | 委派给某个 Agent | delegateToAgent |
| `discuss` | 多 Agent 讨论 | runMultiAgentDiscussion |
| `align_confirm` | PM 复述需求，等用户确认 | handlePMConfirm |
| `align_decompose` | 架构师拆任务，等用户确认 | handleArchitectPlan |
| `align_qa` | Agent 提问，等用户回答 | handleAgentQA |
| `execute` | 开始执行任务 | transitionToExecution → handleExecution |
| `done` | 任务完成 | 标记 done |

phase/phaseStep 仅用于**前端状态显示**和**DB 记录**，不做路由依据。

## 风险缓解（8 项）

### R1: Orchestrator 决策不确定性
- Few-shot 示例覆盖典型场景
- validateDecision 安全校验层拦截严重矛盾（alignment 中返回 done → 覆盖为 align_confirm）

### R2: decomposeTasks ID 与持久化
- 已确认 decomposeTasks 生成 UUID，Prisma Task 支持自定义 id，无迁移问题

### R3: handleAgentQA 延迟风险
- Promise.allSettled 并行调用各 Agent，单个失败不阻塞

### R4: 消息持久化字段一致性
- agentId 使用 Agent name（非 id），PM/架构师用硬编码 name，前端 fallback 到默认颜色

### R5: handlePMConfirm 中自动创建 Agent 的延迟
- SSE status 通知 + Agent 创建后发 SSE 通知 + 前端已有 members 轮询

### R6: transitionToExecution 与 handleExecution 衔接
- handleExecution 内部从 DB 取 task，不依赖 message 参数，传空串安全

### R7: 多轮 Q&A 循环控制
- Prompt 终止条件："Q&A 最多 2 轮"
- validateDecision 代码硬上限：已回答后强制 execute

### R8: 测试策略
- prompts.test.ts 验证 8 action 格式
- alignment.test.ts mock getOrchestratorDecision 测试路由
- validateDecision 测试覆盖/放行逻辑

## 修改范围

| 文件 | 修改内容 |
|------|----------|
| `src/lib/orchestrator/prompts.ts` | 重写 ORCHESTRATOR_DECISION_PROMPT（8 action + few-shot） |
| `src/lib/orchestrator/index.ts` | OrchestratorDecision 接口扩展 + formatArchitectPlan helper |
| `src/app/api/sessions/[id]/chat/route.ts` | 新增 6 个函数 + switch 扩展 + validateDecision + 连接 handleExecution |
| `tests/alignment.test.ts` | 新增：对齐流程集成测试 |
