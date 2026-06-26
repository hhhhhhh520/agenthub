# 2026-06-25 代码审查验证结果

> 审查方法：6维度并行审查（安全/架构/性能/代码质量/测试/Contract v1）
> 原始发现：94项
> 验证后真实问题：20项（误报率 79% → 21%）
> 误报原因：审查Agent不了解项目威胁模型（本地单机工具）、已有审计记录、设计决策

---

## 高优先级（5项）

### 1. P3 缺少数据库索引

**位置**：`prisma/schema.prisma`
**问题**：Task 表按 sessionId 查询和按 status 过滤均无复合索引。Message 表按 sessionId 查询频繁但无索引。
**出现原因**：初始 schema 设计时未考虑查询模式，后续迭代未优化。
**影响**：SQLite 全表扫描，随数据增长查询变慢。
**修复方法**：
```prisma
model Task {
  // ...existing fields...
  @@index([sessionId, status])
}

model Message {
  // ...existing fields...
  @@index([sessionId, createdAt])
}

model Attachment {
  // ...existing fields...
  @@index([sessionId])
}
```
然后运行 `npx prisma db push` 或创建 migration。

---

### 2. T2 send() 最大重试耗尽路径未测试

**位置**：`src/lib/adapter/process-registry.ts:617-629`
**问题**：send() 在 MAX_SEND_RETRIES=3 次失败后会 yield error chunk 并 throw，但无测试覆盖此路径。
**出现原因**：ProcessRegistry 重构时（2026-06-22）重点测试了正常路径和单次失败，遗漏了连续失败的兜底场景。
**影响**：生产中 LLM API 持续不可用时，最终兜底行为未经验证。
**修复方法**：新增测试：
```typescript
it('should yield error and throw after max retries exhausted', async () => {
  // mock spawn 使进程连续 3 次 exitCode=1（非永久错误）
  // 调用 send()
  // 验证产出 'Process failed after 4 attempts' 错误
  // 验证 throw
})
```

---

### 3. T3 NO_DATA_TIMEOUT_MS 60s 超时路径未测试

**位置**：`src/lib/adapter/process-registry.ts:847-853`
**问题**：readRound 和 readNdjsonRound 均有 NO_DATA_TIMEOUT_MS（60s）检测，但无测试覆盖。
**出现原因**：测试中进程要么快速退出要么快速吐数据，从未构造"进程存活但不输出"的场景。
**影响**：防进程 hang 的关键安全机制未经验证。
**修复方法**：使用 fake timers：
```typescript
it('should throw after 60s no data', async () => {
  vi.useFakeTimers()
  // 创建进程但不产生 stdout 数据
  // advanceTimersByTime(61_000)
  // 验证 throw 'No data received'
})
```

---

### 4. T6 gracefulKillEntry 两阶段完整路径未测试

**位置**：`src/lib/adapter/process-registry.ts:1155-1189`
**问题**：gracefulKillEntry 有 Phase 1（SIGTERM + 5s等待）和 Phase 2（强杀），但测试只验证配置指纹分支，未走完完整两阶段。
**出现原因**：测试重点在配置指纹命中/未命中，忽略了"进程不退出"的场景。
**影响**：超时强杀路径未经验证。
**修复方法**：
```typescript
it('should force kill after 5s if process does not exit', async () => {
  vi.useFakeTimers()
  // spawn 进程，alive=true
  // 调用 gracefulKillEntry
  // advanceTimersByTime(5000)
  // 验证 killEntryIfCurrent 被调用
})
```

---

### 5. T9 execution.ts 全局 deadline 超时路径未测试

**位置**：`src/lib/services/execution.ts:99-104`
**问题**：handleExecution 有 globalDeadline 参数，超时时 break 退出循环，但无测试覆盖。
**出现原因**：测试中使用默认 50 分钟 deadline，从未触发超时。
**影响**：全局超时保护机制未经验证。
**修复方法**：
```typescript
it('should break loop and send error when deadline exceeded', async () => {
  // 传入 past deadline: Date.now() - 1
  // 调用 handleExecution
  // 验证 error 事件发送
  // 验证循环提前退出
})
```

---

## 中优先级（8项）

### 6. T1 execution-edge-cases 全量 mock orchestrator

**位置**：`tests/execution-edge-cases.test.ts:25-52`
**问题**：将 orchestrator、shadow-git、context-builder、scheduler 全部 mock，handleExecution 的核心循环不验证真实逻辑。
**出现原因**：测试编写时为了隔离依赖，mock 过度导致不验证真实行为。
**影响**：批内并行、MAX_ITERATIONS、deadline 超时等路径未被真实逻辑触达。
**修复方法**：至少 mock child_process 而非 mock orchestrator 全量函数。或提取纯逻辑函数（如 resolveReadyTasks）单独测试。

---

### 7. T7 thinking/tool_use/tool_result 事件未测试

**位置**：`src/lib/adapter/process-registry.ts:771-798`
**问题**：readRound 支持 thinking、tool_use、tool_result 三种事件类型，但所有测试仅覆盖 text、control_request、result。
**出现原因**：2026-06-09 StreamChunk 事件补全时（PROGRESS.md记录），新增了事件类型但未同步补测试。
**影响**：LLM 思考过程和工具调用事件在读取链路上从未被验证。
**修复方法**：
```typescript
it('should yield thinking chunk for thinking block', async () => {
  // 构造包含 thinking block 的 stdout 数据
  // 验证 yield { type: 'thinking', content: '...' }
})
```

---

### 8. C6 declaredFiles 路径未归一化

**位置**：`src/lib/services/execution.ts:226`
**问题**：undeclared 计算使用 `changedFiles.filter(f => !declaredFiles.includes(f))`，字符串精确匹配。Windows 反斜杠 vs Unix 正斜杠会导致误判越界。
**出现原因**：2026-06-23 实施 Contract v1 动作 6 时，focused on 分级逻辑，忽略了路径格式差异。
**影响**：Windows 上同一文件（`src/index.ts` vs `src\index.ts`）会被误判为越界。
**修复方法**：
```typescript
// 在比对前归一化路径
const normalizePath = (p: string) => p.replace(/\\/g, '/').replace(/^\.\//, '')
const undeclared = changedFiles.filter(f => !declaredFiles.map(normalizePath).includes(normalizePath(f)))
```

---

### 9. Q1 readRound 253 行，职责过载

**位置**：`src/lib/adapter/process-registry.ts:631-883`
**问题**：readRound 包含 stdin 写入、stdout 解析、权限管理、超时检测等 7+ 职责，嵌套 5 层。
**出现原因**：2026-06-22 ProcessRegistry 重构时，从原有代码提取但未进一步拆分。
**影响**：可读性差，修改任一职责需要理解整个方法。
**修复方法**：拆分为：
- `writeStdinPayload(entry, prompt, attachments)` — stdin 写入
- `parseClaudeEvent(event)` — 事件解析纯函数
- `handlePermissionRequest(entry, request)` — 权限处理
- `waitForRoundComplete(entry, stdout)` — 完成检测

---

### 10. Q4 readRound 与 readNdjsonRound 大量结构性重复

**位置**：`process-registry.ts:631-883 vs 885-1061`
**问题**：两个方法约 60% 结构相同（alive 检查 → stdin 写入 → stdout 监听 → buffer 解析 → timeout → cleanup），差异仅在事件解析协议。
**出现原因**：先实现了 readRound（Claude），后实现 readNdjsonRound（OpenCode）时复制了结构但未提取公共部分。
**影响**：修改公共逻辑（如超时检测）需要改两处。
**修复方法**：提取模板方法：
```typescript
private async *readRoundCore(
  entry: ProcessEntry,
  writeFn: () => void,
  parseEvent: (line: string) => StreamChunk | null
): AsyncIterable<StreamChunk> { ... }
```

---

### 11. A5 空 catch 块静默吞异常

**位置**：
- `src/lib/orchestrator/index.ts:80` — updateAgentSessionStatus
- `src/lib/services/review.ts:105` — reviewResult 外层
- `src/lib/adapter/claude-code-adapter.ts:29` — 图片读取

**问题**：关键路径的 catch 块为空，异常被静默吞没。
**出现原因**：开发时为了"不让异常中断流程"，但忽略了可观测性。
**影响**：生产环境排查问题时无法定位失败原因。
**修复方法**：至少添加 `console.warn`：
```typescript
} catch (err) {
  console.warn(`[updateAgentSessionStatus] Failed: ${err}`)
}
```

---

### 12. S13 附件上传路径未校验 sessionId 为 UUID

**位置**：`src/app/api/sessions/[id]/attachments/route.ts:18,38`
**问题**：上传目录 `join(process.cwd(), 'uploads', sessionId)` 未校验 sessionId 格式。含 `../` 的 sessionId 可逃逸目录。
**出现原因**：2026-06-01 实现附件功能时，focused on 上传逻辑，遗漏了路径安全校验。
**影响**：目录遍历写入任意位置（需结合其他漏洞利用）。
**修复方法**：
```typescript
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
if (!UUID_REGEX.test(sessionId)) {
  return NextResponse.json({ error: 'Invalid session ID' }, { status: 400 })
}
```

---

### 13. Q2/Q3 executeTaskBatch 185行 / handleExecution 400行

**位置**：
- `src/lib/orchestrator/index.ts:305-489` — executeTaskBatch
- `src/lib/services/execution.ts:30-430` — handleExecution

**问题**：两个核心函数过长，嵌套过深。
**出现原因**：Contract v1 实施时（2026-06-23）在原有函数上追加了 dependency 注入、authoritative 包装、文件校验等逻辑，未重构拆分。
**影响**：可读性差，新开发者理解成本高。
**修复方法**：
- executeTaskBatch：提取 `buildAgentPrompt(task, depBlocks, fileConstraint)` 和 `executeSingleTask(task, agent, ...)`
- handleExecution：提取 `selectReadyTasks(tasks)`、`persistResults(results)`、`validateFileBoundary(task, result)`、`monitorAndCorrect(task, result)`

---

## 低优先级（7项）

### 14. T4 send 测试条件化断言

**位置**：`tests/process-registry.test.ts:141-163`
**问题**：`if (written)` 条件断言，stdin.write 未及时完成时整个断言被跳过。
**出现原因**：使用 `vi.useRealTimers + setTimeout(50)` 等待，CI 环境下时序不稳定。
**修复方法**：改为 deterministic 模式：直接调用 stdin.write 后 await Promise.resolve() 多次。

---

### 15. T5 process-registry-ndjson 测试与 extended 重复

**位置**：`tests/process-registry-ndjson.test.ts`
**问题**：使用不同 mock 结构，与 extended 测试功能大量重叠。
**出现原因**：两组测试由不同审查轮次编写，未合并。
**修复方法**：合并到 process-registry-extended.test.ts，统一 mock 方式。

---

### 16. T8 源码断言脆弱

**位置**：`tests/process-registry-refactor.test.ts:178-184,240-247`
**问题**：直接 readFileSync 源码并用正则断言变量名，重构时必然失败。
**出现原因**：作为回归保护（防回退命名）编写的，但不应是主要断言方式。
**修复方法**：保留作为补充，主要断言改为运行时行为验证。

---

### 17. A7 agents 参数类型重复内联

**位置**：`chat-router.ts:13`、`alignment.ts:12`、`execution.ts:33`、`review.ts:12`
**问题**：`Array<{ id: string; name: string; ... }>` 在 6+ 函数中重复内联定义。
**出现原因**：快速迭代时直接写内联类型，未抽取公共接口。
**修复方法**：
```typescript
// src/lib/types/agent.ts
export interface AgentConfig {
  id: string; name: string; systemPrompt: string; platform: string;
  expertise: string; model: string; baseUrl: string; apiKey: string; tools: string;
}
```

---

### 18. C4 schema-validator fenced regex 不处理嵌套括号

**位置**：`src/lib/services/schema-validator.ts:59`
**问题**：non-greedy `*?` 会提前在第一个闭合符处停止，可能截断嵌套 JSON。
**出现原因**：实现时 focused on 常见场景，未考虑嵌套括号的边界情况。
**修复方法**：改用贪心匹配取最后一个 fenced block，或使用平衡括号匹配。

---

### 19. C7 越界警告噪声

**位置**：`src/lib/services/execution.ts:304-312`
**问题**：所有未声明的文件变更都标记为越界警告，Agent 顺手改邻近文件（import、types）产生大量低价值警告。
**出现原因**：Contract v1 动作 6 实施时，选择了"记录一切"的保守策略。
**修复方法**：可增加"常见邻近修改"白名单（.d.ts、index.ts 导出文件、test 文件等）。

---

### 20. P4 stderrBuffer 无限增长

**位置**：`src/lib/adapter/process-registry.ts:387-391`
**问题**：stderr.on('data') 不断追加，无截断。长时间运行进程可累积大量 stderr。
**出现原因**：初始实现时 focused on 错误诊断完整性，未考虑内存限制。
**修复方法**：
```typescript
proc.stderr.on('data', (chunk: Buffer) => {
  const text = chunk.toString()
  entry.stderrBuffer = (entry.stderrBuffer + text).slice(-4096) // 只保留最近 4KB
  console.error(`[ProcessRegistry ${key}] stderr:`, text)
})
```

---

## 统计

| 优先级 | 数量 | 类型分布 |
|--------|------|----------|
| 高 | 5 | 性能1 + 测试4 |
| 中 | 8 | 测试2 + Contract2 + 代码质量3 + 安全1 |
| 低 | 7 | 测试3 + 架构1 + Contract2 + 性能1 |

## 与近期改动的关系

| 问题 | 引入时间 | 相关 commit |
|------|---------|-------------|
| C6 路径未归一化 | 2026-06-23 | Contract v1 动作 6 |
| T7 事件未测试 | 2026-06-09 | StreamChunk 事件补全 |
| Q1/Q4 重复代码 | 2026-06-22 | ProcessRegistry 重构 |
| Q2/Q3 长函数 | 2026-06-23 | Contract v1 实施 |
| 其余 | 历史累积 | — |
