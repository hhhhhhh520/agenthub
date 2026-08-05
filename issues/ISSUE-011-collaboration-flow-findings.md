# 协作流程 E2E 4 项发现（批失败吞错 / 会话遗留 / 消息归属 / 设计漂移）

> 创建时间: 2026-08-05 | 状态: 🟢 已解决（4/4）
> 发现方式: qwen3.8-max-preview 对齐流程 E2E（align_confirm→align_decompose→execute，6 任务分解执行）
> 更新: 2026-08-05 Finding 1/2/3/4 全部修复（commit 见 PROGRESS.md）

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

## Finding 2：会话遗留 execution 态（🟡）→ 🟢 已修复

**现象**：任务 3 失败、4/5 blocked、6 pending 后，会话 phase 停在 `execution`，不转 done，也无 redo 提示。

**根因**：执行循环结束条件不处理"部分任务失败+下游 blocked"的组合，批次循环结束后直接返回。

**建议**：批次失败后若存在 blocked/pending 且无继续执行的 ready 任务，应发提示消息（"N 个任务失败，可 redo"）而非静默停在 execution。

**✅ 已修复（2026-08-05）**：
- 非 allDone 时发收尾消息 `执行未完全完成：N 个任务失败，M 个任务被阻塞，K 个任务未完成。失败/阻塞任务可点击 redo 重试，未完成任务将在下次执行时继续`（message.create 落库 + SSE text）
- done 事件不再谎报"所有任务已完成"——无成功结果时发 `执行结束：N 个失败...`
- pending + in_progress 合并为"未完成"计数：中断后报"执行中"与事实不符，且 in_progress/pending 无 redo 入口（redo 只接受 failed/blocked），故 redo 提示只针对失败/阻塞
- 新增测试：部分失败场景断言收尾消息 + done 不谎报 + 不报"执行中"（真回归守卫，旧代码下红）

**⚠️ 已知设计权衡（记录）**：
- phase 在部分失败后仍停 `execution`（有意保留：下次用户消息可触发 execute 继续跑遗留任务）。副作用：前端 chat-area 用 `phase==='execution'` 渲染脉动"执行中"，部分失败后 UI 会持续显示"执行中"直到用户再发消息/刷新。未引入新 phase 值（如 failed/paused），如需收敛 UI 需扩展 session phase 枚举
- 收尾 text 事件被紧跟的 done 事件清掉 streaming buffer：部分成功场景实时 UI 看不到聚合统计（但 message.create 已落库，刷新可见；逐失败消息由 F1 修复实时可见）
- 收尾消息非幂等：redo/重触发 execute 会追加多条结论消息（每次都是真实执行结果，未做去重）

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

## Finding 4：架构师设计漂移（🟡 观察）→ 🟢 已修复

**现象**：architecture.md（436 行）写成 Python 技术栈（cli.py / Python 3.10 / pyproject.toml），与任务契约声明的 TS 交付物（src/types.ts / src/store.ts）冲突，也和架构师此前自己说的"Node.js + TypeScript"矛盾。

**表现**：后端工程师正确识别冲突并以任务边界（authoritative_input）为准产出 TS 文件——contract v1 的权威输入机制兜住了这次漂移。但设计文档与实现从此不一致，后续 Agent 读设计文档会困惑。

**建议**：架构师 prompt 强约束"设计必须与任务拆解的 declared_files 技术栈一致"，或拆解阶段就锁定技术栈字段。

**✅ 已修复（2026-08-05）**：
- 三处约束落点覆盖全部拆解路径：
  1. `TASK_DECOMPOSITION_PROMPT`（prompts.ts）规则区新增 techStack↔declared_files 技术栈一致性约束（兜底/无架构师路径，声明 TS 则 .ts/.tsx 不得写 Python）
  2. `alignment.ts` handleArchitectPlan 主路径 archPrompt 注入同约束——主路径用架构师自己 systemPrompt 读不到 TASK_DECOMPOSITION_PROMPT，必须显式注入（覆盖 DB 既有 Agent）
  3. `prisma/seed.ts` 架构师默认 systemPrompt 加技术栈一致性要求（覆盖新 seed 的拆解 + 执行阶段写设计文档）
- techStack JSON 字段描述更新为"必须明确技术栈，且与各任务 declared_files 的文件后缀一致"
- 新增测试：prompts.test.ts 断言约束文本存在（真回归守卫）+ architect-output-schema.test.ts 断言主路径 archPrompt 含约束
- 注：仅 prompt 约束（ISSUE-011 建议的"强约束"路径），未做拆解后确定性校验（techStack 自由文本到文件后缀映射属启发式，硬校验易误伤混合技术栈项目）；执行侧漂移已由 contract v1 authoritative_input 兜住

**⚠️ 已知残留**：
- `ROLE_GENERATION_PROMPT` 动态生成的架构师 systemPrompt 未加同约束（LLM 生成 prompt，指令文本约束模糊，收益低）
- techStack 拆解后即被丢弃（decomposeTasks 只解析 tasks），无"锁定字段"的下游持久化——若需确定性防护，需在 task.create 时存储 techStack 并传播进设计文档任务上下文

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
