# P3 #21–#27 交互修复完成记录（2026-10-21）

> 代码 HEAD: `6198d62` | 文档 HEAD: 本次记录提交 | 分支: master
> 回归基线: `138 files / 1532 passed / 3 skipped`；`next build` 通过；工作区 clean；未 push
> **状态：✅ #21–#27 已闭环；后续 P3 #29–#36 已全部闭环；仅 #3 已接受风险**

## 1. 修复内容

| 项 | 修复 |
|---|---|
| #21 | `useChat` 在 sessionId 变化时 abort 旧请求，清空 messages/streaming/loading/phase/awaitingInput/pendingPermissions/thinking/toolCalls，并按新会话重置 seq gate |
| #22 | 项目页接入 `permission_request` / `permission_cancel`，显示 Bash/Write 详情并提供允许/拒绝 POST 入口 |
| #23 | 附件占位/上传结果合并改为函数式状态；并发上传只更新各自占位；上传中禁止发送；结果数量不符显式失败并清理占位 |
| #24 | setup wizard 所有保存/检测/测试请求检查 `res.ok`；连接测试不再先保存配置；保存/完成/跳过失败不再静默完成 |
| #25 | Provider 导入 `await onImport` 成功后才 toast/关闭；调用方检查导入与加入会话的 HTTP 状态 |
| #26 | diff 接受失败改为 toast 可见错误；Dialog 补 `role="dialog"`、`aria-modal`、标题关联、初始焦点/Tab 陷阱/焦点恢复；移动端增加侧栏入口。`+ 添加 Agent` 已确认有 onClick |
| #27 | task-poller 比较 `description`/`dependencies`/`assignedAgentId`/`trace`，redo 改描述或依赖后任务板刷新 |

## 2. 测试

- 新增纯函数回归：
  - `tests/attachment-upload-merge.test.ts`：并发 append/merge、结果数量不符、失败清理
  - `tests/project-permissions.test.ts`：request 去重、replay 忽略、cancel 移除
  - `tests/http-error.test.ts`：2xx/JSON error/非 JSON/响应体不被消费
  - `tests/use-chat-session-switch.test.ts`：会话切换复位源码守卫
  - `tests/ui-regression-guards.test.ts`：#23/#24/#25/#26/#22 接线守卫
- `tests/task-poller.test.ts` 新增 description/dependencies 变化刷新回归
- 定向：`6 files / 26 passed`
- 全量：`138 files / 1532 passed / 3 skipped`
- `npx next build`：通过（1 条既有 Turbopack NFT warning）
- 改动文件 eslint：0 error（6 条既有 warning：img/未使用 drag/paste 等）

## 3. 变异验证

- 去掉会话切换 `abort` → #21 守卫红
- 恢复 task-poller 只比较 status/trace → #27 回归红
- 去掉 `permission_request` replay 保护 → #22 回归红
- 去掉 `assertOkResponse` 的 `res.ok` 检查 → #24 回归红

## 4. 残余

- #22 只处理当前 POST 流的权限事件；刷新后 pending permission 恢复仍依赖未实现的 runtime 快照接口（原 §5.1）。
- #24 `test-connection` 当前仍只检测 CLI；API Key 的真实连通性测试未扩展（原接口能力限制）。
- #26 Dialog 焦点陷阱基于 DOM 查询，缺少浏览器 E2E 回放；建议后续 `/qa` 或 `browse` 验证。
- `attachment-input.tsx` 的 drag/paste handler 仍未被 JSX 接线（既有 warning），不属于本批 #23 的“并发覆盖/未完成发送”范围。

## 5. 下一项

P3 **#29**：MCP 消息查询 `asc + take 50` 读最旧 50 条，应改为最新 50 条后反序。
