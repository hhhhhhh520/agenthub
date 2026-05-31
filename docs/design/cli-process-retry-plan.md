# CLI 进程恢复与重试机制实现计划

> 目标：当 Claude Code CLI 进程崩溃或异常退出时，自动重试，而不是直接失败。

## 一、当前问题

ProcessRegistry.send() 在 CLI 进程中途崩溃时，while 循环会无限等待（等 roundComplete），因为
- 进程 crash 后 stdout 不会再输出数据
- roundComplete 永远不会变为 true
- 50ms poll 循环永远不会退出
- 最终靠 SSE 5分钟超时断开

最终结果：前端收到一个 5 分钟超时，用户看到的是无响应，而不是有意义的错误。

## 二、改动范围

只改 **一个文件**：`src/lib/adapter/process-registry.ts`

不动：
- ClaudeCodeAdapter
- chat/route.ts
- 前端
- 适配器层其他文件

## 三、改动细节

### 3.1 ProcessEntry 新增字段

```typescript
// 旧
interface ProcessEntry {
  // ... existing fields
}

// 新增字段：
mcpConfig: string | null   // 存原始 mcpConfig JSON 字符串，重建进程时需要
```

理由：重建进程时需要原版 mcpConfig，当前只存了文件路径（`mcpConfigFile`），但如果要重建进程，必须知道 mcpConfig 的原始内容。直接存下来是最简单的方式。

### 3.2 ProcessEntry 新增字段

```typescript
interface ProcessEntry {
  // 已有的
  process: ChildProcess;
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  pid: number;
  mcpConfig: string | null;    // 新增，保存原始 JSON 字符串，重建进程时重传 --mcp-config
  // ...rest 照旧
}
```

### 3.2 `send()` 方法重构

核心变动：

1. **外层加入 retry 机制。** `send()` 最多尝试 1 次重试（即最多执行 2 次）。如果第一次失败，杀掉旧进程，重建进程，将 `fullPrompt` 重发。

2. **检测进程退出。** 在 while 循环中新增逻辑：如果 entry.alive === false 或 entry.process.exitCode !== null，判定进程已死。

- 若是正常关闭（exit 0）→ 在日志中记录正常退出
- 若是异常退出（非 0 退出）→ 触发重试

3. **超时兜底**。在 while 循环中加入 noDataTimeout：如果 60s 内没有收到任何 chunk，认为进程卡死，将其视为进程崩溃处理。

### 3.3 改后的 `send()` 伪代码

```
send(key, prompt) {
  for attempt 0..1:
    entry = get(key) || spawn(key)
    send prompt to stdin, enter read-loop
    while !roundComplete && process alive:
      poll events; yield chunks
      if process dies:
        if attempt == 0: break inner loop (will retry)
        else: throw error
    if roundComplete: break // success
  if never succeeded: throw
}
```

**关键改动细节：**

- 循环最多执行2轮：第一次失败后 rebuild 进程，第二次尝试；若第 2 次仍失败则上抛 error。
- 如果 `entry.alive === false` 或 `entry.process.exitCode !== null`，视为进程已死。此时如果 retry < 1，清除旧 entry、调用 spawnProcess()，用同一 key 重新启动并重发 prompt；retry++，继续循环。

**超时兜底**：
- 在 while 循环中加入 `lastChunkTime`，如果 60 秒内没有任何 chunk 到来 → 视作进程僵死，进入重试流程。

**新 StreamChunk 增加 retry 标记**：当重试开始时 yield `{ type: 'status', content: 'process crashed, retrying...' }` 前端无需做任何事。status chunk 会被上层 onChunk 回调忽略/透传，不影响功能。

### 3.4 进程重建的完整流程

```
a. key 对应的 ProcessEntry.alive 为 false
b. kill any remaining resources (stdin, proc.kill)
c. 删除 registry 中旧的 entry
d. 通过 spawnProcess() 新建进程
e. send prompt
f. 等待
```

**mcpConfig 的处理**：重建进程时需要传 `--mcp-config`（需要写一个新的临时文件或复用同一个 temp file），简单做法是在 ProcessEntry 里保留 mcpConfig 原始 JSON string, rebuild 时直接把内容写进临时文件并传 path。

## 四、逐文件改动清单

| 文件 | 改动内容 |
|------|---------|
| `src/lib/adapter/process-registry.ts` | 修改 `send()` 加入重试逻辑，ProcessEntry 增加字段，在 spawnProcess 时保存 mcpConfig 原始字符串 |

## 五、对其他功能的影响分析

| 功能 | 是否受影响 | 理由 |
|------|-----------|------|
| 正常聊天流 | 不受影响 | send() 正常逻辑不变，只是增加了崩溃重试 |
| 权限交互（permission request） | 不受影响 | 权限流程在 send() 返回后由上层处理 |
| 会话恢复 --resume | 不受影响 | sessionId 在 entry.sessionId，rebuild进程后并不传 resume，是新建进程 |
| SSE 流式推送到前端 | 不受影响 | send() 还是 yield StreamChunk，上层 onChunk 回调透明 |
| 多 Agent 并发 | 不受影响 | 每个进程由 key 隔离，互不影响 |

## 六、风险点与保护措施

1. **进程僵尸风险**：重生进程前先 kill 旧进程，确保没有僵尸进程残留
2. **死循环重试**：最多 1 次重试，不会无限重试
3. **多 Agent 并发**：每个 key 的 send 只操作自己进程，互不干扰
4. **mcpConfig 原始字符串需要保存**——否则 mcpConfig 文件删了就丢了

## 七、测试要点

1. `kill -9` 模拟进程崩溃 → send() 应自动重启并重试，上层能正常获得正常结果
2. 进程启动后正常完成，无崩溃 → 行为与改动前完全一致
3. 重试后第二次仍崩溃 → 返回 error chunk，上层 try/catch 可正常处理
4. 超时兜底：60s 无 chunk 则视为僵死