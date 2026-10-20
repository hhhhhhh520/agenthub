# Batch 0 交接：锁队列、统一释放、取消链路

> 创建时间: 2026-10-19 | 分支: master | 代码 HEAD: `a5e6991`（主批次工具白名单 + 审计内容证据 + 结果发布门禁 + OpenCode 清扫 hotfix + 双维度权限 + CLI 探针）；文档：本次修复文档提交（commit `a5e6991` 之后）
> 适用对象: 接手后续批次的 AI/开发者
> 必读: `CLAUDE.md`「Chat API Session Lock」「会话取消与停止」「工作区与权限模式」、本文、`docs/design/repair-backlog-2026-10-20.md`（当前待办权威清单）、`docs/design/roadmap-to-excellence.md` v21

## 1. 当前状态

已完成 commit：

| commit | 内容 |
|---|---|
| `b6b2deb` | 锁队列重写 + chat 统一释放 |
| `c5930d3` | 取消全链路 + 进程真实退出 + 有界清理 + stop/delete |
| `55d5012` | Batch 1 第一小项：执行恢复态 + 任务/verify 单事务 |
| `e75339d` | Batch 1 审计三态 + 批次级归责 + 共享目录停止自动删除 |
| `4774de6` | 双维度权限模型 + CLI 探针（Claude 2.1.270 / OpenCode 2.0.27） |
| `ca020b8` | OpenCode 配置清扫前缀 bug hotfix（active 目录不再被误删） |
| `be969e0` | 任务结果发布门禁：completed CAS 成功后才进入 allResults/成功摘要；纠偏退回删除旧结果 |
| `0dd751a` | 批次审计内容证据：已脏同一路径再改、忽略 `.env`、删除按内容 hash 判定 |
| `ce2703b` | 补漏：被忽略目录内的 `.env` 也用 pathspec glob 纳入证据 |
| `a5e6991` | 主批次透传 Agent tools 白名单；两条执行入口共用 parseAgentTools |

回归基线（2026-10-20）：

- `npx vitest run`：121 files / **1400 passed / 3 skipped**
- `npx next build`：通过
- 改动文件 eslint：0 error（存量 warning 不阻塞）
- 工作区干净

## 2. 已完成的不变量（不要回退）

### 2.1 会话锁

- `src/lib/session-lock.ts` 是显式 waiter 队列，不是 `Map<sessionId, Promise>` 链。
- 等待者超时/abort 必须从队列移除，不能留下死 promise。
- `release` 幂等；释放时 handoff 队首。
- **持有者 abort 不释放锁**：HTTP 断开 ≠ 后台执行结束。
- chat route 用 `lockHandedOff`：拿锁后、建流前的所有提前返回/异常都走外层 finally；一旦交给 stream，只由 stream finally 释放。
- 新增 `waitForSessionUnlock(sessionId, timeoutMs)` 供 delete/stop 收敛等待。

### 2.2 取消

- `src/lib/cancellation.ts` 是唯一取消源：`requestSessionCancel` / `isSessionCancelled` / `clearSessionCancel`。
- `ProcessEntry.ownerSessionId` = `SpawnConfig.chatSessionId`；两个 adapter 必须透传 `chatSessionId`。
- `cancelByOwnerSession` / `terminateEntry`：
  - 标记 `cancelled`，禁止 retry/respawn；
  - 5s 优雅 + 5s 强制；
  - 等 `exit` / `exitCode !== null` / `alive === false` 三重确认；
  - 未确认返回 `unconfirmed`，不删 registry、不假报成功。
- `handleExecution` 取消时 `resetBatchToPending`：本批 `in_progress/failed` 条件写回 `pending`，completed 保留；不写 result、不跑监控、不 auto-done。
- `stop` 只停止不删除；`DELETE` 只在确认退出且锁释放后删数据。
- 前端 stop 按钮先 `POST /api/sessions/[id]/stop`，再 abort 本地流。

### 2.3 有界清理

- `withTimeout` 的 `onTimeout`：10s 上限；抛错/挂起都不能吞掉 `TimeoutError`。
- `eventLogger.flush`：5s 上限；超时只警告，不阻塞锁释放。
- `terminateEntry` / stop / delete 全部有硬上限。

## 3. 仍然未完成（下一批的直接任务）

### Batch 1：执行恢复边界 + 审计三态 + 禁止提前发布成功

**Batch 1 的 1-6 项已全部完成**：`55d5012` 负责执行恢复态 + 任务/verify 单事务；`e75339d` 负责审计三态、批次级归责、共享目录停止自动删除、审计通过前禁止成功。

- `src/lib/services/alignment.ts`（任务创建、phase 推进）
- `src/lib/services/execution.ts`（审计、result、completed、done）
- `src/lib/services/shadow-git.ts`（审计结果三态）
- `src/lib/services/schema-validator.ts` / `sensitive-paths.ts`
- `src/lib/orchestrator/state-machine.ts`（只读转移表，不改契约）
- `tests/*` 相关

必须实现：

1. ✅ **`ensureExecutableState(sessionId)`**（commit `55d5012`）
   - 任务已存在但 phase 停在 `align_pm`：`align_pm → align_decompose(align_arch) → execute(exec)`；
   - `align_arch / align_qa → execute`；
   - `exec → no-op`；
   - 每一步检查 `transitionPhase` 返回值；失败报错，不继续发 done；
   - 不重新拆解、不重复建任务。

2. ✅ **任务 + verify 单事务创建**（commit `55d5012`）
   - `handleArchitectPlan` 的任务创建循环与 verify 创建放入一个 `prisma.$transaction`；
   - 中途失败要么全建、要么全不建；
   - 加测试：任务已建但 phase 未推进 → 恢复不重复建任务。

3. ✅ **审计三态**（commit `e75339d`）
   - `pass | violation | unavailable`；
   - `shadow-git` 的 `getGitSnapshot` / `getChangedFiles` 不再 `catch { return empty }`；新增 detailed 返回值；
   - 批次开始快照失败 → 不执行本批，任务 failed + `trace event:'audit_unavailable'`；
   - 批次结束 diff 失败 → 本批任务 failed，不写 result、不跑监控、不标 completed；
   - downstream blocked；`allDone` 不成立，不 done。

4. ✅ **批次级归责**（commit `e75339d`）
   - 当前 `execution.ts` 把批次级 `changedFiles` 拿去逐任务比较 `declaredFiles`，会误判（A 声明 package.json、B 只声明 foo.ts，B 被误判敏感越界）；
   - 改为 `batchDeclared = union(本批任务 declaredFiles)`；敏感路径检查基于 `changedFiles - batchDeclared`；未声明敏感文件 → **整批失败**；
   - 普通越界按批次告警；
   - 不做不可靠的逐任务硬归责；如需逐任务硬边界，必须上 worktree/隔离工作区（另立项）。

5. ✅ **共享 projectDir 停止自动删除**（commit `e75339d`）
   - 用户真实项目目录下不自动删任何文件；
   - 普通越界只警告；敏感路径整批失败；
   - 自动清理仅限 AgentHub 管理的隔离工作区（当前默认不做）。

6. ✅ **审计通过前禁止成功**（commit `e75339d`）
   - 不新增 `Task.status` 枚举：审计在 completed 事务之前完成，`audit_unavailable / violation → failed`，通过后才写 `completed/result`；
   - 审计通过前不写 `Task.result`、不写 `status=completed`、不发 `task_status completed`、不启动下游、不跑成功监控、不 done；
   - 批次级审计时本批结果先留内存，审计通过后统一事务提交；
   - verify 任务同样过审计。

### 之后（不要在本批混入）

- ✅ 权限模型双维度（可用工具 vs 审批）与 CLI 探针（commit `4774de6`，证据
  `docs/design/permission-cli-probe-2026-10-20.md`）；
- ✅ 审计内容证据（commit `0dd751a`/`ce2703b`）：已脏同一路径再次修改、忽略 `.env`（含忽略目录内）、删除均按内容 hash 判定；
- ✅ P1-02 主批次工具白名单（commit `a5e6991`）：批次与单 Agent 共用解析口径；
- ⏳ P1-03 OpenCode 权限文件按会话隔离（下一项）；
- `GET /api/sessions/[id]/runtime` 恢复仍有效的权限请求；
- 事件 seq 不可变 + 单 logger；
- ✅ OpenCode 配置目录 `opencodeCfgDirName` 清扫前缀 bug 修复（commit `ca020b8`）；
- Pin 独立短锁；
- UI 会话切换 remount + 权限恢复；
- MCP DB URL / since 分页；E2E migrate deploy → db push；Tailwind 动态色；parser CRLF；
- P5 路径可移植 + metrics 归档。

## 4. 已知残余风险（诚实口径）

1. **普通 retry / idle cleanup 仍用 `killEntryIfCurrent`**：该函数在 Windows 发出 taskkill 后立即删 registry，不等待真实退出。stop/delete/cancel 已走 `terminateEntry`，但 retry 路径仍需下一批统一；在此之前不要宣称“所有 kill 都等待退出”。
2. **fast LLM 决策是 HTTP fetch**，未绑定会话 AbortSignal；stop/delete 撞上快模型调用时会在 15/30s 后返回 202/409，需要用户重试。
3. **批次审计已实现，但共享 projectDir 的外部并发修改仍可能落入本批 diff**：审计窗口内用户/其他会话改的敏感文件会被本批判 violation；逐任务硬边界需 worktree 隔离，当前未启用。
4. **事件 seq 仍可能在冲突时丢失/重复**：本批只做了 flush 有界；seq 不可变 / 单 logger 未做。
5. **stop/delete 的 UI 只做了 stop 按钮接线**；删除按钮走原 DELETE，已有取消链。
6. **OpenCode default 模式受 headless CLI 限制为只读**：`ask` 会被自动拒绝；需要写文件/执行命令必须切 auto（UI 已提示）。这不是配置遗漏，重跑 `docs/design/permission-cli-probe-2026-10-20.md` 的探针可复核。

## 5. 关键文件地图

| 能力 | 文件 |
|---|---|
| 会话锁 | `src/lib/session-lock.ts` |
| 取消源 | `src/lib/cancellation.ts` |
| 进程池/真实退出 | `src/lib/adapter/process-registry.ts` |
| 执行/审计/状态写 | `src/lib/services/execution.ts` |
| 对齐/任务创建 | `src/lib/services/alignment.ts` |
| 影子 git | `src/lib/services/shadow-git.ts` |
| stop 端点 | `src/app/api/sessions/[id]/stop/route.ts` |
| delete 收敛 | `src/app/api/sessions/[id]/route.ts` |
| 前端 stop | `src/lib/hooks/use-chat.ts` |
| 写点清单 | `docs/design/phase2-3.2-write-points.md`（B12 已补） |

## 6. 验证命令

```bash
cd <repo>
npx vitest run
npx next build
npx eslint <改动文件>
```

每个修复必须：

- 先写失败测试；
- 修复后全量绿；
- 做一次“回退修复 → 测试精确红 → 还原”；
- Windows CI 通过；
- 不破坏 9-action/phase 转移表、Task 条件写、会话锁、Contract v1。

## 7. 需要用户拍板

1. 共享 `projectDir` 下普通越界：**保留 + 警告**（推荐）还是任务失败 + 下游阻塞？
2. 审计不可用：任务 `failed`（推荐，用户可 redo）还是保留 `in_progress` 等待重试？
3. 逐任务硬边界：本批先做批次级归责（推荐），还是投入 worktree 隔离？
