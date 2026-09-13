# ISSUE-022 phase 写入竞态（会话锁 60s fail-open）
> 创建时间: 2026-09-13 | 状态: 🟢已解决

## 问题描述
同一会话的两个请求并发执行时，双方同时写 `transitionPhase`，后写覆盖先写：
`phase/phaseStep` 最终值看运气（如 execution 被写回 alignment，任务板卡死在对齐态），
`decisionTrace` 两边交叉追加（P3 建的决策轨迹掺进乱序记录）。单用户一次一回碰不到；
模型响应慢（>60s）+ 连发第二句话（或点 redo）即中招。

## 出现原因
1. `src/lib/session-lock.ts` 等前任最多 60s，超时只 warn 然后**直接放行**（fail-open）。
   而锁里包着上限 120s 的 LLM 决策调用（`timeout.ts: LLM_CALL`）和 15 分钟的 Agent 执行
   （`AGENT_TASK`）——持有锁超过 60s 是常态，不是异常。
2. 放大器：`chat/route.ts` 的 400/404//permission 共 5 处早退**漏 `releaseLock()`**，
   漏一次，该会话后续每个请求都要先白等 60s 再走 fail-open 路径。

## 解决方案（fail-closed，2026-09-13）
- 锁超时改抛 `SessionBusyError`（`code='SESSION_BUSY'`，duck-type 供路由识别），绝不放行；
  超时等待者把队尾挂回真正的持有者（不断链，后来者继续正常排队）；
  超时值生产保持 60s，测试可注 `timeoutMs`（顺手删掉了那个 70s 的旧用例）。
- `chat` / `redo` 路由接住忙错回 **429 + `Retry-After: 60`**（JSON，前端可读）；
  chat 的 `acquireSessionLock` 下移到廉价校验（400/404）之后，/permission 两处早退补 `releaseLock()`。
- `agent-panel.tsx` redo 请求补 `res.ok` 检查：429 时 toast 忙提示并降回慢速轮询
  （此前连 `res.ok` 都不看，429 会静默空转 30 次再报超时）。

行为变化面（唯一）：慢模型 + 60s 内连发时，第二发等 60s 后收到“会话正忙，请稍后重试”，
替代以前的静默状态损坏；正常一次一回的用户零感知。

## 验证
- 全量 84 文件 / 1089 passed / 3 skipped（+3 net）。
- 变异：改回“超时放行”→ 精确红 3 个新用例（fail-closed / 断链自愈 / 超时后仍串行），还原→全绿。
- `tsc` 经手文件 0 错误；`eslint` 0 error（剩余 warning 均为 HEAD 早有）。

## 相关文件
- `src/lib/session-lock.ts` — fail-closed + 断链自愈
- `src/app/api/sessions/[id]/chat/route.ts` — 锁下移 + 429 + 早退释放
- `src/app/api/sessions/[id]/tasks/[taskId]/redo/route.ts` — 429
- `src/components/agent-panel.tsx` — redo 的 `res.ok` 检查 + 429 toast
- `tests/session-lock.test.ts` — 9 用例（3 新增）
- `tests/api-task-redo.test.ts` — 新增 429 用例

## 参考资料
- `src/lib/orchestrator/timeout.ts:66`（LLM_CALL 120s）
- 上游设计：redo「HTTP 变更接口 fail-closed」既有惯例（redo/route.ts 闸门注释）
