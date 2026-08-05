# 协作流程 E2E 4 项发现（批失败吞错 / 会话遗留 / 消息归属 / 设计漂移）

> 创建时间: 2026-08-05 | 状态: 🟡排查中（1/4 已解决，1/4 有观察结论）
> 发现方式: qwen3.8-max-preview 对齐流程 E2E（align_confirm→align_decompose→execute，6 任务分解执行）
> 更新: 2026-08-05 Finding 1 已修复（commit 见 PROGRESS.md）

## 背景

2026-08-05 模型切换到 qwen3.8-max-preview 后跑完整协作流程：CLI 待办工具 6 任务分解（PRD/设计/存储层/CLI/测试/README）。任务 1/2 完成，**任务 3（存储层）失败**，任务 4/5 正确 blocked，任务 6 遗留 pending。测试暴露 4 个问题。

## Finding 1：批失败吞掉底层错误（🔴 可观测性缺口）→ 🟢 已修复

**现象**：任务 3 失败后 task.trace 只有 `start → error: Task failed in batch execution`，SSE 无 error 事件，真实原因不可见。

**根因**：`execution.ts:249` 的 `batchFailedIds` 循环写死通用消息，`executeTaskBatch` 的 Promise.allSettled rejection reason 未透传。实测服务日志显示任务 3 的 CLI 进程 `Process exited, code=1, signal=null, stderr=`（空 stderr），重试 1 次仍失败——真实原因（CLI 崩还是 provider 错误）只有服务日志里有线索，trace/SSE 全丢。

**后果**：失败任务无法自助定位，用户只能看服务日志猜。

**建议修法**：`executeTaskBatch` 的 settled rejection 里把 `s.message` 写入 task trace（或发 error 事件），`execution.ts:249` 使用真实 err.message 而非通用串。

**✅ 已修复（2026-08-05）**：
- `executeTaskBatch` 返回新增 `failedTaskReasons: Record<string,string>`，rejection reason 经 `reasonToString()` 安全序列化（防 null-prototype 对象 `String()` 抛 TypeError 击穿整批）
- `execution.ts` 批失败循环用真实原因写 task trace（`??` 兜底保留空串原因）+ SSE text 事件 + `message.create` 聊天历史持久化（不被结尾 done 事件刷掉）
- 新增测试：execution-edge-cases（trace+SSE+message.create 透传）、orchestrator-extended（Error reason + null-prototype 不崩）
- 遗留：catch 整体 throw 路径（executeTaskBatch 整体 reject）仍只写 trace 不发 SSE text，属既有行为、罕见路径，未一并处理

## Finding 2：会话遗留 execution 态（🟡）

**现象**：任务 3 失败、4/5 blocked、6 pending 后，会话 phase 停在 `execution`，不转 done，也无 redo 提示。

**根因**：执行循环结束条件不处理"部分任务失败+下游 blocked"的组合，批次循环结束后直接返回。

**建议**：批次失败后若存在 blocked/pending 且无继续执行的 ready 任务，应发提示消息（"N 个任务失败，可 redo"）而非静默停在 execution。

## Finding 3：完成消息文件归属错误（🟡 日志 bug）

**现象**：SSE 出现 `任务 96caa720 完成,修改了 src/store.ts, src/types.ts`（PRD 任务却报任务 3 的存储层文件）。

**根因**：`execution.ts:372` 的完成消息用 `changedFiles`，疑似批级/共享变量在审计时被后任务的声明文件覆盖，导致已完成任务的完成消息报错文件清单。

**建议修法**：完成消息用当前 task 自己的 declaredFiles∩实际变更，而非共享变量；加单测守护。

## Finding 4：架构师设计漂移（🟡 观察）

**现象**：architecture.md（436 行）写成 Python 技术栈（cli.py / Python 3.10 / pyproject.toml），与任务契约声明的 TS 交付物（src/types.ts / src/store.ts）冲突，也和架构师此前自己说的"Node.js + TypeScript"矛盾。

**表现**：后端工程师正确识别冲突并以任务边界（authoritative_input）为准产出 TS 文件——contract v1 的权威输入机制兜住了这次漂移。但设计文档与实现从此不一致，后续 Agent 读设计文档会困惑。

**建议**：架构师 prompt 强约束"设计必须与任务拆解的 declared_files 技术栈一致"，或拆解阶段就锁定技术栈字段。

## 相关文件

- `src/lib/services/execution.ts:249`（批失败消息）、`:372`（完成消息 changedFiles）
- `src/lib/orchestrator/prompts.ts`（架构师 prompt，涉及 Finding 4）

## 已验证的正面行为（非问题）

- 依赖失败级联 blocked 正确（任务 4/5 未执行）
- contract v1 authoritative_input 让后端工程师守住任务边界
- outputSchema 软校验 / 越界保护按设计工作
