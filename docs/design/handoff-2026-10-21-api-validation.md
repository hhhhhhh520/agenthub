# 安全 / API 校验六项完成记录（2026-10-21）

> 代码 HEAD: `b4fa42a` | 文档 HEAD: 本次记录提交 | 分支: master
> 回归基线: `133 files / 1514 passed / 3 skipped`；`next build` 通过；工作区 clean；未 push
> 权威待办: `docs/design/repair-backlog-2026-10-20.md`
> **状态：✅ #5/#14/#15/#16/#17/#18 已闭环；#3 按用户决定保持已接受风险；下一项 P3 #28**

## 1. 本批修复

| 项 | 根因 | 修复 | 回归 |
|---|---|---|---|
| #5 | POST/PUT 对非法 `permissionMode` 静默按 default | 新增 `isPermissionMode` 共享守卫；显式非法值返回 400，缺省仍 default | 非法 POST/PUT 均不落库；`auto` 正常 |
| #14 | 先全量 `formData()`；无文件数/总大小上限；中途失败留文件/记录 | 增加 Content-Length 早退、10 文件/50MB 总大小限制；先全量校验再写盘；文件写入或 DB 事务失败清理已写文件 | 超数量/总大小/Content-Length；DB 失败 unlink；正常上传 |
| #15 | `POST /chat` 不校验 `replyToId` | 在拿锁/写消息前校验存在且属于当前会话，非字符串 400 | 不存在/跨会话均不拿锁、不建消息 |
| #16 | redo 先 `transitionPhase` 后 `trim()`，非字符串 500 | body 与 `description` 类型在推进前校验 | 非字符串 400，phase/task 均未写 |
| #17 | private session 先 create 再校验 agentIds，失败留空会话 | agentIds 在 create 前完成数组/非空/全部存在校验；先查 agent 再 create | 缺失/未知 ID 不建会话；有效时才建 |
| #18 | Pin 的 count→update 分离，并发可超 10 | count+update 移入事务，串行化上限检查 | 11 并发最多 10 成功；满额仍可取消 Pin；404 |

## 2. 验证

- 定向：`6 files / 66 passed`
- 全量：`133 files / 1514 passed / 3 skipped`
- `npx next build`：通过（2 条既有 Turbopack NFT warning）
- 改动文件 eslint：0 error（1 条既有 warning：`api-task-redo.test.ts` 的 `msg`）
- 变异验证：
  - 去掉 POST/PUT permissionMode 检查 → 两条测试红；
  - 跳过 private agent 预校验 → 三条 #17 测试红；
  - 去掉总大小检查 / 失败 unlink → 对应 #14 测试红；
  - 去掉 replyToId 校验 → 两条 #15 测试红；
  - 去掉 description 类型检查 → #16 测试红；
  - 将 #18 移出事务 → 并发测试红（11 成功）。

## 3. 残余风险

- #14 `formData()` 在 Content-Length 缺失或未超上限时仍由运行时缓冲；本批已通过 Content-Length 早退 + 解析后总量校验限制影响面，未实现流式 multipart parser。
- #17 private 会话的 `session.create` 与 `sessionMember.createMany` 仍未包在单一事务；本批已消除“校验失败留空会话”，DB 写失败仍可能留下空会话。
- #18 依赖 SQLite 事务串行化；并发写冲突时可能返回 500（未加 busy retry）。
- #3 未修：用户明确选择保持本机单用户、无认证的已接受风险。

## 4. 下一项

P3 **#28**：MCP 硬编码 `cwd/dev.db`，主进程使用 `DATABASE_URL`。
