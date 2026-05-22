# sessionLocks 内存泄漏导致死锁
> 创建时间: 2026-05-21 | 状态: 🔴未解决

## 问题描述

`chat/route.ts` 中的 `sessionLocks`（Map 类型）在异常场景下不会释放锁，导致后续对该 session 的所有 chat 请求永久阻塞。

**复现步骤：**
1. 向某个 session 发送消息触发 LLM 调用
2. 在 LLM 返回前关闭客户端连接（或网络断开）
3. 锁未被释放（`finally` 块可能因异常中断未执行）
4. 再次向同一 session 发送消息 → 请求永久挂起

**预期行为：** 锁应在超时后自动释放，或监听客户端断开事件主动释放
**实际行为：** 锁永久持有，该 session 的所有后续请求阻塞

## 出现原因

```typescript
// chat/route.ts:8
const sessionLocks = new Map<string, Promise<void>>()
```

- 锁在 `finally` 中删除，但如果 Promise 链因异常中断，`finally` 可能不执行
- 没有超时机制
- 没有监听 `request.signal` 的 abort 事件

## 解决方案

1. 添加锁超时机制（建议 60 秒自动释放）
2. 监听 `request.signal.addEventListener('abort', ...)` 主动释放锁
3. 考虑使用 `AbortController` 包装 LLM 调用，客户端断开时取消操作

## 相关文件
- `src/app/api/sessions/[id]/chat/route.ts`

## 参考资料
- 内存中的 Map，进程重启后锁会重置，但运行期间会导致 session 不可用
