# Round 7 复核补修记录（2026-10-21）

> 代码 HEAD：`0a6aacd` | 分支：master | 文档：本次提交
> 审计来源：`<home>\.codex\visualizations\2026\10\20\01a157b9-2549-7321-a5a8-9a46eeb05ea4\agenthub-repair-quality-review-round7.md`
> 结论：Round 7 指出的 **#21 / #24 / #14 三处缺口已补修**；不再声称“0 项待修”，等待下一轮独立复核。
> 基线：`144 files / 1561 passed / 3 skipped`；build 通过；改动文件 eslint 0 error；未 push。

## 1. 三项缺口与修复

### R7-01 / R7-02：#21 旧会话异步回调覆盖新会话

**根因：**
- `loadMessages` 的 fetch 没有取消信号/会话身份校验；A 的迟到响应会在切到 B 后写 `setMessages(A)`。
- `send` 的 `finally` 无条件 `setLoading(false)` 并清 `abortRef`；A 的迟到收尾会清掉 B 的 loading 和本地停止句柄。
- `applyEvent` 与 streaming 节流定时器也没有会话身份护栏。

**修复（`8c2b4c3`）：**
- `src/lib/hooks/latest-request.ts`：请求世代 `createRequestEpoch()`。
- `loadMessages`：独立 `loadAbortRef` + epoch，写 messages 前 `isCurrent(requestId)`；切换时 abort + invalidate。
- `send`：`isCurrentRequest()` 核对自己是否仍持有 controller；catch/finally 只允许当前请求收尾。
- `applyEvent`：写状态前 `sessionIdRef.current === sessionId`；节流定时器同样核对捕获的 session。
- 回归：`tests/use-chat-session-switch.test.ts`（世代异步 + 接线守卫）。

**浏览器验证：**
- 消息串会话：切到 B 后放行旧 A 响应，DOM 仍为 `B-message`，`staleIgnored: true`。
- loading 所有权：B 请求进行中放行旧 A 失败，`loading` 仍为 `true`，`newLoadingPreserved: true`。
- harness 在 `%TEMP%\agenthub-round7-harness` / `agenthub-round7-loading`，真实 React 19 + Playwright Chromium，本地 deferred fake fetch。

### R7-03：#24 手动配置测试未使用表单草稿

**根因：** 向导 `testConnection` 只发 `POST` 无 body；后端只 `detectCLIPlatform()`，手动输入的 apiKey/model/baseUrl 完全没参与测试。

**修复（`84056cd`）：**
- `setup-wizard.tsx`：发送 `{ apiKey, model, baseUrl }`，仍不保存。
- `test-connection/route.ts`：有草稿时调用真实最小生成；无草稿才回退 CLI 检测；错误脱敏；缺 API Key 明确 400。
- `src/lib/llm-connection.ts`：AI SDK 最小请求（Anthropic/OpenAI 兼容按 baseUrl/model 分流），`AbortSignal.timeout(15s)`，OpenAI 强制 `.chat()` 走 chat/completions。
- 回归：`tests/setup-test-connection-route.test.ts`（草稿/CLI/失败/缺 key）、`tests/llm-connection.test.ts`（本地回环真实 HTTP 生成）、`tests/ui-regression-guards.test.ts` 接线守卫。

**边界：**
- 测试会真实调用一次模型端点（最多 16 output tokens，15s 超时）；不写数据库。
- 非 https 且非回环的 baseUrl 被 `assertSafeBaseUrl` 拒绝。

### R7-04：#14 请求体上限只信 Content-Length

**根因：** Content-Length 可缺省/可伪造；之后 `request.formData()` 仍完整读取并解析全部 body，文件字段限制不能替代请求体上限。

**修复（`0a6aacd`）：**
- `src/lib/request-body-limit.ts`：按实际读取字节计数，超过上限立即 `reader.cancel()` 并抛 `RequestBodyTooLargeError`；上限内 body 再交给 `formData()`。
- `attachments/route.ts`：Content-Length 早退保留；无 body 流回退原生解析；超限返回 413；文件校验/写盘回滚/DB 事务不变。
- 回归：`tests/attachments-upload-limits.test.ts`：无长度头超限、正常 multipart、54MB 路由级 413、接线守卫。

## 2. 验证结果

| 检查 | 结果 |
|---|---|
| 定向回归 | 25 passed（5 files） |
| 全量 `npm test` | **144 files / 1561 passed / 3 skipped** |
| Coverage | statements 85.67% / branches 78.43% / functions 88.54% / lines 86.51%，均过阈值 |
| `npx next build` | 通过（2 条既有 Turbopack NFT warning） |
| 改动文件 eslint | 0 errors |
| 真实浏览器 | 消息串会话 + loading 所有权均通过 |
| 工作区 | clean；未 push |

## 3. 当前状态与剩余

- #21 / #24 / #14：**补修完成，待下一轮独立复核**。
- 不再声明“P3 0 项待修”；在复核通过前，`repair-backlog` 状态为 `review`。
- 既有已接受风险不变：#3 API 无认证、Windows ACL、历史 migration 非 v2 部分等。

## 4. 相关提交

- `8c2b4c3` fix(chat): ignore stale session loads and preserve new loading state
- `84056cd` fix(setup): test the actual manual LLM draft
- `0a6aacd` fix(attachments): enforce request limit on bytes actually read
- 文档收尾：本次提交
