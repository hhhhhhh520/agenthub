# Round 7 异步状态与资源边界缺口
> 创建时间: 2026-10-21 | 状态: 🟢已解决（待独立复核）

## 问题描述

Round 7 复核在已标记闭环的 P3 项中发现三处功能缺口：

1. **#21 会话切换**：`loadMessages` 的 fetch 没有绑定取消信号，也没有在 await 后校验请求仍属于当前会话；旧会话迟到响应会覆盖新会话消息。发送请求 `finally` 无条件清 `loading`/`abortRef`，旧请求会清掉新请求状态。
2. **#24 配置向导**：手动配置的“测试连接”只发无 body POST；后端只调用 `detectCLIPlatform()`，没有测试表单草稿。
3. **#14 附件上传**：请求体上限只看可缺省的 `Content-Length`，随后仍调用原生 `request.formData()` 全量解析；无长度头时可超出声明上限并返回 200。

## 出现原因

- #21 只做了切换时状态清空，没有给异步回调建立“请求身份/会话身份”。
- #24 把“CLI 可用性检测”误当成“手动 API 配置测试”。
- #14 把文件字段总大小限制误当成整个请求体限制。

## 解决方案

- #21（`8c2b4c3`）：
  - `loadMessages` 使用独立 `AbortController` + `RequestEpoch`，写 `messages` 前校验最后一次请求；
  - `send` 的 catch/finally 只在仍持有当前 controller 时收尾；
  - `applyEvent` 和 streaming 节流定时器写状态前核对 `sessionIdRef`。
- #24（`84056cd`）：
  - 向导发送 `{ apiKey, model, baseUrl }` 草稿；
  - 后端有草稿时通过 AI SDK 发起最小生成请求，无草稿时保持 CLI 检测；
  - 测试不落库，错误脱敏。
- #14（`0a6aacd`）：
  - 新增 `readFormDataWithLimit`，按实际读取字节计数；
  - 超限立即 cancel 源流并返回 413，再把上限内的 body 交给原生 multipart 解析；
  - 保留 Content-Length 早退、文件校验、失败回滚和 DB 事务。

## 验证

- 定向回归：25 passed（#21/#24/#14 相关）
- 真实浏览器：
  - 消息串会话：切到 B 后放行旧 A 响应，DOM 仍为 B-message（`staleIgnored: true`）
  - loading 所有权：B 请求进行中放行旧 A 失败，loading 仍为 true
- 全量：144 files / 1561 passed / 3 skipped
- coverage：85.67% / 78.43% / 88.54% / 86.51%，超阈值
- `next build` 通过；改动文件 eslint 0 error

## 相关文件

- `src/lib/hooks/use-chat.ts`
- `src/lib/hooks/latest-request.ts`
- `src/app/api/config/test-connection/route.ts`
- `src/lib/llm-connection.ts`
- `src/app/api/sessions/[id]/attachments/route.ts`
- `src/lib/request-body-limit.ts`
- `tests/use-chat-session-switch.test.ts`
- `tests/setup-test-connection-route.test.ts`
- `tests/llm-connection.test.ts`
- `tests/attachments-upload-limits.test.ts`

## 参考资料

- `<home>\.codex\visualizations\2026\10\20\01a157b9-2549-7321-a5a8-9a46eeb05ea4\agenthub-repair-quality-review-round7.md`
- `docs/design/handoff-2026-10-21-round7.md`
