# §3.2 generation CAS 统一状态写入 —— 写入点清单与范围拍板

> 创建时间: 2026-09-21 | 状态: 🟢 范围已拍板（路线图 §3.2 先行动作：先列清单再动手）
> 关联: docs/design/roadmap-to-excellence.md §3.2 / issues/ISSUE-022-phase-write-race.md（行为性收敛先例）

## 0. 结论（TL;DR）

- **纳入 CAS**：① `transitionPhase` 的 phase 写入（读时快照条件写 + 冲突重读重算 + 3 次重试 + 仍冲突 fail-closed）；② execution.ts / cli-session.ts / redo 路由的 **Task 状态写入全部改状态前置条件写**（updateMany where 带前置 status，count=0 → 重读同步内存 + 弃权 + 可见 warn）。
- **结构性收益**：pending→in_progress 的条件标记是**互斥闸门**——同一任务同时只能有一个执行流通过该闸门，双流重复执行结构性不可能（§7 完成判据）；僵尸流（SSE 60min 超时 / abort 提前释放锁后后台续跑）的晚到写全部被前置条件拦下。
- **不引入 generation 字段**（Session.runGeneration / Task.execGeneration）：状态前置条件写已覆盖全部已证实的竞态窗口（见 §2 窗口分析）；generation 的增量价值只在"区分哪个流"，而互斥闸门 + 心跳已提供等价保护。若 §3.3 中断恢复需要"批次纪元"语义再引入（避免现在为此付 schema 变更 + 全量测试适配的成本）。
- **不纳入**：SessionMember（last-writer-wins 是既定语义 + invalidate 方向 fail-safe）、decisionTrace（已是模式本体）、heartbeat updatedAt（无状态语义）、非状态字段写（dependencies/description/permissionMode）。

## 1. 写入点全景

### A. Session.phase/phaseStep（转移合法性敏感）

| # | 位置 | 现状写法 | 处置 |
|---|---|---|---|
| A1 | `state-machine.ts:254` transitionPhase | `update where {id}` **无条件**（读-写之间非原子） | **CAS 化**：updateMany where {id, phase, phaseStep}=读时快照；count=0 → 重读 → stateFromSession 重算 applyTransitionWithOverride → 合法则新快照重写（3 次上限），非法/超限 fail-closed 拒写（可见 warn，返回 ok:false）。trace 条目用最终成功那次的 inputState |
| A2 | `decision-trace.ts:107` appendDecisionTrace | updateMany where decisionTrace=base + 3 次重读重试 | 已是模式本体，不动 |
| A3 | `chat/route.ts:58` /permission | update permissionMode | 非状态字段，不纳入 |
| A4 | `sessions/[id]/route.ts:70` PUT | update title/projectDir/... | 非状态字段，不纳入 |

**A1 的竞态窗口（回归基线针对）**：
- 🔴 **abort 提前释放锁**：`session-lock.ts:31-37` abort handler 直接 release；chat 路由传了 `request.signal`（chat/route.ts:41）——浏览器断开 SSE → 锁释放 → **handler 仍在后台跑** → 用户重发 → 新流拿锁 → 双流并发双写 phase。ISSUE-022 修的是"锁超时误放行"，此窗口（abort 路径）仍在。
- 🔴 **决策点快照过期**：`chat-router.ts:48` sessionPhase 是请求开始时读的快照，LLM 决策 120s 期间 DB 可能已被改（同上双流窗口）；transitionPhase 重读兜底了非法转移，但读-写之间仍可被覆盖。
- 多实例（instrumentation 注释提到的场景）：单实例部署下暂不可达，CAS 顺带覆盖。

### B. Task 状态写入（批次执行）

| # | 位置 | 转移 | 现状 | 处置（前置条件写） |
|---|---|---|---|---|
| B1 | `execution.ts:188` | pending→in_progress | 无条件 update | where {id, status:'pending'}；**count=0 → 重读同步内存 + 从本批剔除（不调 agent）+ warn**。这是双流互斥闸门 |
| B2 | `execution.ts:367-384` | in_progress→completed（+member 事务） | 事务内无条件 update | 事务内 task.updateMany where {id, status:'in_progress'}；count=0 → **member 也不写**（防"任务被拒但 member 记了新 session"污染 fallback——正是动作 7 防的脏状态）→ 交互式事务 |
| B3 | `execution.ts:261/281` | →failed | 无条件 | where {id, status:'in_progress'}；count=0 → 弃权 + warn |
| B4 | `execution.ts:498` | →blocked（依赖失败级联） | 无条件 | where {id, status:'pending'}（blocked 只从 pending 级联） |
| B5 | `execution.ts:165` | blocked→pending 复活 | 无条件 | where {id, status:'blocked'} |
| B6 | `cli-session.ts` invalidateCliSession（redo 重置 / 敏感失败 / 纠偏退回三调用方） | 各异 | 事务内无条件 task.update | 统一入口加 `expectedFrom`（redo: ['failed','blocked']；敏感失败: 'in_progress'；纠偏: 'completed'）；count=0 → 返回 applied:false，调用方弃权（member 清空仍执行——清空方向 fail-safe 无害） |
| B7 | `redo/route.ts:111` | blocked→pending 解锁下游 | 无条件 | where {id, status:'blocked'} |
| B8 | `sessions/[id]/route.ts:44` GET stuck reset | in_progress→pending | findMany 带 status+updatedAt 条件，但 updateMany **只按 id**（审查抓出：findMany 与 updateMany 之间执行流可把任务写 completed，无条件重置会丢结果 + 造成 DB pending/内存 completed 漂移 → 误 done） | **已收口**：updateMany where 补 `status: 'in_progress'`（2026-09-21 随 §3.2 一并修） |
| B9 | `execution.ts:198` heartbeat | updatedAt 心跳 | 无条件 | 无状态语义，不纳入 |
| B10 | `alignment.ts:297` | verify 依赖/描述扩展（status='pending' 分支内） | 无条件 | 锁内对齐路径 + 非状态字段，不纳入 |

### C. SessionMember

| # | 位置 | 语义 | 处置 |
|---|---|---|---|
| C1 | `orchestrator/index.ts:72/77` | status 标记 updateMany where {sessionId, agentId} | 已按 key 条件写；per-agent last-writer-wins 可接受（圆点显示），不纳入 |
| C2 | `execution.ts:379` / `cli-session.ts:31` / `chat-router.ts:375` | cliSessionId 成功路径写 / invalidate 清 | 成功路径 last-writer-wins 是既定语义（§1.3"正常完成保留"）；invalidate 走 B6 收敛且清空方向 fail-safe。不纳入（B2 事务内 member 写的"条件联动"由交互式事务承载） |

## 2. 窗口分析（为什么条件写够、不需要 generation）

| 窗口 | 触发条件 | 条件写如何拦 |
|---|---|---|
| 双流重复执行同一任务 | abort/超时释放锁 → 旧流（僵尸）在跑 → 新流进来 | 两流的 in-memory 快照都含 pending 任务，但 B1 互斥：先到者标 in_progress 成功，后到者 count=0 → 剔除。**进入执行只有一条门且互斥** |
| 僵尸流晚到纠偏写覆盖新流状态 | 僵尸 monitoring 判 needsCorrection → invalidate 置 pending | B6 纠偏 where status='completed'；新流已把它推到 in_progress → count=0 → 弃权 |
| GET stuck reset 后僵尸写 completed 覆盖 | heartbeat 失效 5min → GET 置 pending → 僵尸完成 | B2 where status='in_progress' → count=0 → 弃权（服从 reset） |
| phase 丢更新（双流） | 同窗口 1 | A1 快照条件写 + 重读重算 + fail-closed |
| 双流都 mark in_progress 成功？ | —— | 不可能：updateMany where status='pending' 在 SQLite 行级原子，第二个必然 count=0 |
| （generation 才能拦的场景） | 双流都已在 in_progress 后各写 completed | 仅当 GET reset 把 in_progress 打回 pending 且两流都重新标记才可达——heartbeat 60s 使 reset 需 5min 心跳失效，僵尸流心跳活着 → 实际不可达；真不可达时 reset 语义（任务死透）与 completed 写（僵尸完成）冲突由 warn 暴露 |

**generation 的取舍**：不否定其价值（codeg 用 run_seq 贯穿），但在本项目当前窗口集下，它解决的问题条件写已解决，而它的成本（schema 变更 + execution.ts 全写点 + 5 个测试文件 mock 适配 + GET reset/redo 的纪元语义）显著。记为 §3.3 的设计输入：若 reconcile 需要"批次纪元"（区分中断批次与恢复批次），届时一并引入。

## 3. 实现落点

- A1：`state-machine.ts` transitionPhase 内部（update → updateMany + 重试环）。trace 补记逻辑不变（appendDecisionTrace 自身 CAS）。
- B1-B5/B7：`execution.ts` / `redo/route.ts` 各写点改 updateMany 条件写 + count 检查；B1 失败路径加 findUnique 重读同步。
- B2：success 路径 $transaction 数组式 → **交互式事务**（task 条件写 count=0 时提前 return，member 不写）。现有 3 个测试文件的数组式 $transaction mock 加了"双形态 shim"（typeof opsOrFn === 'function' → cb(mockTx)：execution-edge-cases / execution-trace / task-result-persistence；api-task-redo / cli-session-invalidate / event-log-wiring 的数组式 mock 未经过交互式路径，无需 shim）。
- B6：`cli-session.ts` invalidateCliSession 加 `expectedFrom?: string | string[]` 参数（不传 = 保持旧语义，向后兼容），task.update → updateMany 条件写，返回 `{ applied: boolean }`；三个调用方接线 + applied=false 时 warn；redo applied=false → 409。
- B8（审查收口）：GET stuck reset 的 updateMany 补 `status: 'in_progress'` 前置（原条件只在 findMany）。
- 基线测试：`tests/transition-phase-cas.test.ts`（A1 四用例：非法覆盖 fail-closed / 合法重试用新快照 / 重试上界=3 / 无并发基线）+ `tests/task-conditional-write.test.ts`（B1 互斥 ×2 / B2 弃权 / B3 形状 / B4 级联 / B5 形状 / B6 单元 ×2）+ `tests/api-task-redo.test.ts` 增补（B7 解锁形状 / invalidate applied=false → 409）。
- 变异验证（2026-09-21 实测，均为精确红后还原全绿）：① transitionPhase 退回无条件写（去快照条件）→ A1 测试 2 红；② B1 标记去 status 条件 → B1 形状断言 1 红；③ B2 completed 写去 status 条件 → B2 用例 2 红；④ invalidate 忽略 expectedFrom → B6 用例 2 红。B3/B5/B7 的 where 形状由专项断言钉死（转发 shim 会剥离 where.status，故形状断言直接查 updateMany 调用参数）。
