# 协作流程 E2E 4 项发现（批失败吞错 / 会话遗留 / 消息归属 / 设计漂移）

> 创建时间: 2026-08-05 | 状态: 🟡排查中（2/4 已解决，1/4 有观察结论）
> 发现方式: qwen3.8-max-preview 对齐流程 E2E（align_confirm→align_decompose→execute，6 任务分解执行）
> 更新: 2026-08-05 Finding 1/3 已修复（commit 见 PROGRESS.md）

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

## Finding 3：完成消息文件归属错误（🟡 日志 bug）→ 🟢 已修复

**现象**：SSE 出现 `任务 96caa720 完成,修改了 src/store.ts, src/types.ts`（PRD 任务却报任务 3 的存储层文件）。

**根因**：`gitBefore` 是 batch 开始前一次快照（execution.ts:162），`changedFiles = 工作树 diff − gitBefore`（shadow-git.ts）是 **batch 级差异**，含同批并行其他任务的文件。而 `undeclared = declaredFiles.length === 0 ? [] : ...`（execution.ts:277-278）让**无声明文件的任务（PRD/文档）强制跳过文件校验**，直接落到完成消息分支，把 batch 级 `changedFiles` 全部串报成自己的。与"批级共享变量被覆盖"的初判不同，实际机制是 batch 级快照差异 + 空声明任务跳过校验的组合。

**建议修法**：完成消息用当前 task 自己的 declaredFiles∩实际变更，而非共享变量；加单测守护。

**✅ 已修复（2026-08-05）**：
- 完成消息改为 `attributed = changedFiles.filter(f => normalizedDeclared.includes(normalizePath(f)))`（declared∩changed），attributed 为空只发"任务 X 完成"不列文件（execution.ts:381-388）
- 声明任务零信息丢失（completion 分支仅在 undeclared===0 到达，此时 attributed 恒等于声明文件）；空声明任务不再串报
- 顺带修掉：完成消息不再列出已被 `cleanupUndeclared` 物理删除的越界文件
- 新增测试：declaredFiles=[] 不串报同批文件（真回归守卫，旧代码下红）+ 声明∩变更仍列出（防过度抑制）

**⚠️ 已知残留（架构层，非本修复范围）**：
- `enforceFileOverlap`（scheduler.ts:86）归一化比 `normalizePath` 弱（只转斜杠不小写不去 `./`）→ `src/Store.ts` vs `src/store.ts` 不判重叠并行执行，重叠声明文件仍可能串报
- batch 级 diff 本质限制：声明不碰 + 兄弟任务未声明写同一文件时，声明方会"冒领"修改
- 根除需 per-task 文件 diff（shadow-git 当前仅支持 batch 级），已列入后续范围

## Finding 4：架构师设计漂移（🟡 观察）

**现象**：architecture.md（436 行）写成 Python 技术栈（cli.py / Python 3.10 / pyproject.toml），与任务契约声明的 TS 交付物（src/types.ts / src/store.ts）冲突，也和架构师此前自己说的"Node.js + TypeScript"矛盾。

**表现**：后端工程师正确识别冲突并以任务边界（authoritative_input）为准产出 TS 文件——contract v1 的权威输入机制兜住了这次漂移。但设计文档与实现从此不一致，后续 Agent 读设计文档会困惑。

**建议**：架构师 prompt 强约束"设计必须与任务拆解的 declared_files 技术栈一致"，或拆解阶段就锁定技术栈字段。

## 相关文件

- `src/lib/services/execution.ts:249`（批失败消息）、`:381-388`（完成消息 changedFiles→declared∩changed）
- `src/lib/orchestrator/prompts.ts`（架构师 prompt，涉及 Finding 4）
- `src/lib/orchestrator/scheduler.ts:86`（enforceFileOverlap 归一化弱，见 Finding 3 已知残留）

## 附带发现（既有问题，非本次引入）

- **`execution.ts:377` 的 `[越界修改]` 软警告是死代码**：`cleanupUndeclared` 末尾 `undeclared.splice(0)` 清空数组，走到 377 时 `undeclared.length` 恒为 0，该分支永不执行。与 :376 注释"普通越界软警告"矛盾。越界提示实际由 `[越界警告/保护]`（:319-335）承担。待后续清理。

## 已验证的正面行为（非问题）

- 依赖失败级联 blocked 正确（任务 4/5 未执行）
- contract v1 authoritative_input 让后端工程师守住任务边界
- outputSchema 软校验 / 越界保护按设计工作
