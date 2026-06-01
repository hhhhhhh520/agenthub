# 适配器生命周期层重构设计

> 创建时间: 2026-05-31 | 状态: 已实现（2026-06-02）

## 最终实现

ProcessRegistry 直接复用，未采用 SessionManager + OneShotRunner 方案。

**改动清单**：
1. `SpawnConfig` 扩展 4 字段：`command`/`args`/`format`/`env`
2. `ProcessEntry` 新增 `format: 'claude' | 'ndjson'`
3. `spawnProcess()` 支持自定义命令和环境变量
4. 新增 `readNdjsonRound()` 处理 OpenCode 的 NDJSON 协议
5. `send()` 按 `entry.format` 分发到 readRound 或 readNdjsonRound
6. ndjson 格式在 send() 完成后自动 `killEntry()`（一次性进程清理）
7. `OpenCodeAdapter` 删除自管理进程代码（~70 行），委托 ProcessRegistry

**关键差异**：

| | readRound (Claude) | readNdjsonRound (OpenCode) |
|---|---|---|
| stdin | JSON `{ type: 'user', message: {...} }` | 纯文本 |
| 等待结束 | 等 `result` 事件 | 等 stdout close |
| 权限协商 | 处理 `control_request` | 无 |
| session_id | `event.session_id` | `event.sessionID` |
| 进程生命周期 | 长驻（idle 回收） | 一次性（send 后清理） |

---

## 原始设计（已修订）

> 以下 SessionManager + OneShotRunner 方案未实施，保留作为设计背景参考。

## 一、问题背景

### 1.1 现状

AgentHub 的适配器层 (`src/lib/adapter/`) 支持三个执行平台：

| 平台 | 适配器 | 进程管理 | 成熟度 |
|------|--------|----------|--------|
| Claude Code CLI | `ClaudeCodeAdapter` | ProcessRegistry 长连接 | 生产级 |
| OpenCode CLI | `OpenCodeAdapter` | 自管理，fire-and-forget | 功能验证级 |
| LLM API | `LLMAdapter` | 无进程 | 生产级 |

### 1.2 核心差距

ProcessRegistry 为 Claude Code 提供了 6 项关键能力，OpenCode 一项都没有：

| 能力 | Claude Code | OpenCode |
|------|------------|----------|
| 进程池复用 | 有 (ProcessRegistry) | 无，每次 send() 新建进程 |
| 崩溃重试 (3次指数退避) | 有 | 无，单次尝试 |
| 无数据超时检测 (60s) | 有 | 无，仅 20min 硬超时 |
| 优雅关闭 (SIGTERM→SIGKILL) | 有 | 无，直接 taskkill |
| 空闲清理 (10min) | 有 | 无 |
| 权限协商 (control_request/response) | 有 | 无，硬编码全部允许 |

### 1.3 已知问题 (来自审计报告)

- **P0-17**: OpenCodeAdapter 无 ProcessRegistry，孤儿进程无法追踪
- **P1-11**: OpenCodeAdapter 硬编码 `OPENCODE_PERMISSION={"*":"allow"}`
- **P3-6**: OpenCodeAdapter 无 noOutputTimer (卡死检测)

## 二、参考实现分析

### 2.1 cc-connect (Go)

OpenCode 处理方式：**one-shot CLI per turn**

```go
// agent/opencode/session.go
func (s *Session) Send(ctx context.Context, prompt string) (<-chan Event, error) {
    args := []string{"run", "--format", "json", "--session", s.id, "--model", s.model, "--dir", s.workDir}
    cmd := exec.CommandContext(ctx, "opencode", args...)
    cmd.Stdin = strings.NewReader(prompt)
    // ... read NDJSON from stdout
}
```

- 每次 send() 启新进程
- 靠 `--session <chatID>` 实现会话连续性
- 权限由 OpenCode 内部处理 (RespondPermission 是 no-op)
- 有 `readLoop` goroutine 解析 NDJSON 流

### 2.2 multica (Go)

OpenCode 处理方式：**同样 one-shot CLI per turn**

```go
// server/pkg/agent/opencode.go
func (b *OpenCodeBackend) Execute(ctx context.Context, prompt string, opts ExecOptions) (*Session, error) {
    args := []string{"run", "--format", "json", "--dir", workDir, "--model", model, "--session", resumeID}
    cmd := exec.CommandContext(ctx, "opencode", args...)
    // ... read NDJSON from stdout
}
```

- 同样 one-shot
- 自动批准：`OPENCODE_PERMISSION={"*":"allow"}`
- Windows 特殊处理：绕过 .cmd shim，直接调用 opencode.exe

### 2.3 关键结论

**两个成熟项目都接受了 OpenCode 的 one-shot 本质**，没有尝试让它变成长连接。它们的做法是：

1. 接受 one-shot，不强求进程复用
2. 靠 `--session <id>` 实现会话连续性
3. 在上层做生命周期管理 (重试、超时、清理)

## 三、设计目标

| 目标 | 说明 |
|------|------|
| 共享生命周期管理 | 重试、超时、清理逻辑写一次，两个平台都用 |
| 保留平台差异 | Claude Code 保持进程复用，OpenCode 保持 one-shot |
| 向后兼容 | 现有 API (`AgentAdapter` 接口) 不变 |
| 渐进迁移 | 可以先改 OpenCode，不影响 Claude Code |

## 四、架构设计

### 4.1 分层架构

```
┌─────────────────────────────────────────────┐
│           AgentAdapter (接口不变)             │
│  connect() / send() / close()               │
├─────────────┬───────────────┬───────────────┤
│ ClaudeCode  │  OpenCode     │   LLM         │
│ Adapter     │  Adapter      │   Adapter     │
├─────────────┴───────────────┴───────────────┤
│         SessionManager (新增，通用)           │
│  retry / noDataTimeout / gracefulShutdown   │
├─────────────┬───────────────────────────────┤
│ ProcessPool │   OneShotRunner (新增)         │
│ (现有，改名)  │   spawn → read → kill        │
│ stdin/stdout│   one process per send()      │
│ long-lived  │                               │
└─────────────┴───────────────────────────────┘
```

### 4.2 核心抽象

#### SessionManager — 通用生命周期管理

```typescript
interface SessionManagerConfig {
  maxRetries: number           // 默认 3
  noDataTimeoutMs: number      // 默认 60_000
  idleTimeoutMs: number        // 默认 10 * 60_000
  hardTimeoutMs: number        // 默认 20 * 60_000
  permanentErrorPatterns: string[]  // 不重试的错误模式
}

class SessionManager {
  // 通用重试逻辑：执行 fn，失败时判断是否可重试，指数退避
  async *executeWithRetry<T>(
    key: string,
    fn: () => AsyncIterable<T>,
    config: SessionManagerConfig
  ): AsyncIterable<T>

  // 通用超时检测：包装 AsyncIterable，加入 noDataTimeout
  async *withNoDataTimeout<T>(
    source: AsyncIterable<T>,
    timeoutMs: number
  ): AsyncIterable<T>

  // 通用错误分类
  isPermanentError(error: string): boolean
  getRetryDelay(attempt: number): number
}
```

#### ProcessPool — 重命名现有 ProcessRegistry

现有 ProcessRegistry 只服务 Claude Code，改名为 ProcessPool 更准确。功能不变，只是从"注册表"变成"池"的定位。

#### OneShotRunner — OpenCode 专用执行器

```typescript
interface OneShotConfig {
  command: string              // 'opencode'
  args: string[]              // ['run', '--format', 'json', ...]
  workDir: string
  env: Record<string, string>
  hardTimeoutMs: number       // 20 * 60_000
}

class OneShotRunner {
  // 执行一次性 CLI 命令，返回 NDJSON 流
  async *execute(config: OneShotConfig): AsyncIterable<StreamChunk>

  // 跨平台进程清理
  private killProcess(proc: ChildProcess): void
}
```

### 4.3 文件结构

```
src/lib/adapter/
├── types.ts                    # 不变
├── index.ts                    # 不变
├── llm-adapter.ts              # 不变
├── claude-code-adapter.ts      # 小改：用 SessionManager 包装
├── opencode-adapter.ts         # 重写：用 SessionManager + OneShotRunner
├── process-registry.ts         # 改名 → process-pool.ts (功能不变)
├── session-manager.ts          # 新增：通用生命周期管理
└── oneshot-runner.ts           # 新增：OneShot 执行器
```

## 五、详细设计

### 5.1 SessionManager

```typescript
// src/lib/adapter/session-manager.ts

export interface SessionManagerConfig {
  maxRetries?: number           // 默认 3
  noDataTimeoutMs?: number      // 默认 60_000
  hardTimeoutMs?: number        // 默认 20 * 60_000
  permanentErrorPatterns?: string[]  // 默认见下
}

const DEFAULT_PERMANENT_ERRORS = [
  'api_key_invalid', 'invalid_api_key', 'authentication_error',
  'permission_denied', 'model_not_found', 'invalid_prompt',
]

export class SessionManager {
  private config: Required<SessionManagerConfig>

  constructor(config?: SessionManagerConfig) {
    this.config = {
      maxRetries: config?.maxRetries ?? 3,
      noDataTimeoutMs: config?.noDataTimeoutMs ?? 60_000,
      hardTimeoutMs: config?.hardTimeoutMs ?? 20 * 60_000,
      permanentErrorPatterns: config?.permanentErrorPatterns ?? DEFAULT_PERMANENT_ERRORS,
    }
  }

  /**
   * 包装一个 AsyncIterable，加入：
   * 1. 重试逻辑（可重试错误时指数退避重试）
   * 2. 无数据超时检测（60s 无输出判定卡死）
   * 3. 硬超时（20min 总超时）
   */
  async *executeWithRetry(
    taskFn: () => AsyncIterable<StreamChunk>,
    label: string = 'task'
  ): AsyncIterable<StreamChunk> {
    let attempt = 0
    let lastError: string | null = null

    while (attempt <= this.config.maxRetries) {
      try {
        if (attempt > 0) {
          yield { type: 'status', content: `retrying (attempt ${attempt})...`, data: { retry: attempt } }
        }

        yield* this.wrapWithTimeouts(taskFn())
        return  // 成功

      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err)
        attempt++

        if (this.isPermanentError(lastError)) {
          break  // 不重试
        }

        if (attempt <= this.config.maxRetries) {
          const delay = this.getRetryDelay(attempt - 1)
          console.warn(`[SessionManager ${label}] Attempt ${attempt} failed: ${lastError}. Retrying in ${delay}ms...`)
          await new Promise(r => setTimeout(r, delay))
        }
      }
    }

    const errMsg = `${label} failed after ${this.config.maxRetries + 1} attempts: ${lastError}`
    yield { type: 'error', content: errMsg }
    throw new Error(errMsg)
  }

  /**
   * 包装 AsyncIterable，加入无数据超时和硬超时
   */
  private async *wrapWithTimeouts(
    source: AsyncIterable<StreamChunk>
  ): AsyncIterable<StreamChunk> {
    const hardTimeout = setTimeout(() => {
      // 硬超时由外层处理
    }, this.config.hardTimeoutMs)

    try {
      let lastChunkTime = Date.now()

      for await (const chunk of source) {
        lastChunkTime = Date.now()
        yield chunk

        // 检查无数据超时
        if (Date.now() - lastChunkTime > this.config.noDataTimeoutMs) {
          throw new Error(`No data for ${this.config.noDataTimeoutMs / 1000}s, process stalled`)
        }
      }
    } finally {
      clearTimeout(hardTimeout)
    }
  }

  isPermanentError(error: string): boolean {
    const lower = error.toLowerCase()
    return this.config.permanentErrorPatterns.some(p => lower.includes(p.toLowerCase()))
  }

  getRetryDelay(attempt: number): number {
    return Math.min(1000 * Math.pow(2, attempt), 16000)
  }
}
```

### 5.2 OneShotRunner

```typescript
// src/lib/adapter/oneshot-runner.ts

import { spawn, type ChildProcess } from 'child_process'
import { existsSync, mkdirSync } from 'fs'
import type { StreamChunk } from './types'

export interface OneShotConfig {
  command: string
  args: string[]
  workDir: string
  env?: Record<string, string>
  stdin?: string               // 写入 stdin 的内容
  hardTimeoutMs?: number       // 默认 20min
}

export class OneShotRunner {
  /**
   * 执行一次性 CLI 命令，返回 NDJSON 流
   * 负责：spawn → write stdin → read stdout → cleanup
   */
  async *execute(config: OneShotConfig): AsyncIterable<StreamChunk> {
    const workDir = config.workDir
    if (!existsSync(workDir)) {
      mkdirSync(workDir, { recursive: true })
    }

    const proc = spawn(config.command, config.args, {
      cwd: workDir,
      env: { ...process.env, ...config.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: true,
    })

    // 写入 stdin
    if (config.stdin && proc.stdin) {
      proc.stdin.write(Buffer.from(config.stdin, 'utf-8'))
      proc.stdin.end()
    }

    // 收集 stderr
    const stderrChunks: string[] = []
    proc.stderr?.on('data', (chunk: Buffer) => {
      stderrChunks.push(chunk.toString())
    })

    // 硬超时
    const timeout = setTimeout(() => {
      this.killProcess(proc)
    }, config.hardTimeoutMs ?? 20 * 60 * 1000)

    try {
      yield* this.readNdjson(proc)
    } catch (error) {
      const stderr = stderrChunks.join('')
      yield { type: 'error', content: `CLI error: ${error}${stderr ? `\nStderr: ${stderr}` : ''}` }
    } finally {
      clearTimeout(timeout)
      this.killProcess(proc)
    }
  }

  private async *readNdjson(proc: ChildProcess): AsyncIterable<StreamChunk> {
    const stdout = proc.stdout
    if (!stdout) return

    let buffer = ''
    const decoder = new TextDecoder()

    for await (const raw of stdout) {
      buffer += decoder.decode(raw, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''

      for (const line of lines) {
        if (!line.trim()) continue
        try {
          const event = JSON.parse(line)
          const chunk = this.parseEvent(event)
          if (chunk) yield chunk
        } catch {
          // Non-JSON, skip
        }
      }
    }
  }

  /**
   * 解析 NDJSON 事件为 StreamChunk
   * 子类可覆盖以支持不同的事件格式
   */
  protected parseEvent(event: Record<string, unknown>): StreamChunk | null {
    // 默认实现，子类覆盖
    if (event.type === 'text' && (event as any).part?.text) {
      return { type: 'text', content: (event as any).part.text }
    }
    if (event.type === 'error') {
      return { type: 'error', content: (event as any).data?.message || (event as any).message || 'Unknown error' }
    }
    return null
  }

  killProcess(proc: ChildProcess): void {
    const pid = proc.pid
    if (!pid) return

    if (process.platform === 'win32') {
      try {
        spawn('taskkill', ['/pid', pid.toString(), '/T', '/F'], { shell: true })
      } catch {
        proc.kill('SIGTERM')
      }
    } else {
      try {
        process.kill(-pid, 'SIGTERM')
      } catch {
        proc.kill('SIGTERM')
      }
    }
  }
}
```

### 5.3 重构后的 OpenCodeAdapter

```typescript
// src/lib/adapter/opencode-adapter.ts (重构后)

import type { AgentAdapter, AdapterConfig, AgentTask, StreamChunk } from './types'
import { SessionManager } from './session-manager'
import { OneShotRunner } from './oneshot-runner'

export class OpenCodeAdapter implements AgentAdapter {
  private config: AdapterConfig = { platform: 'opencode' }
  private workDir: string = ''
  private sessionId: string | null = null
  private sessionManager: SessionManager
  private runner: OneShotRunner

  constructor() {
    this.sessionManager = new SessionManager({
      maxRetries: 3,
      noDataTimeoutMs: 60_000,
      hardTimeoutMs: 20 * 60 * 1000,
    })
    this.runner = new OneShotRunner()
  }

  async connect(config: AdapterConfig): Promise<void> {
    this.config = config
    this.workDir = config.workDir || join(process.cwd(), 'workspaces', `opencode-${Date.now()}`)
    if (config.sessionId) {
      this.sessionId = config.sessionId
    }
  }

  async *send(task: AgentTask): AsyncIterable<StreamChunk> {
    const fullPrompt = task.context
      ? `Context:\n${task.context}\n\n---\n\n${task.prompt}`
      : task.prompt

    // 构建 CLI 参数
    const args = ['run', '--format', 'json', '--dir', this.workDir]
    if (this.config.model) args.push('--model', this.config.model)
    if (task.systemPrompt) args.push('--prompt', task.systemPrompt)
    if (this.sessionId) args.push('--session', this.sessionId)

    // 构建环境变量
    const env: Record<string, string> = {
      OPENCODE_PERMISSION: '{"*":"allow"}',
    }
    if (this.config.apiKey) {
      env.ANTHROPIC_API_KEY = this.config.apiKey
      env.OPENAI_API_KEY = this.config.apiKey
    }
    if (this.config.baseUrl) {
      env.ANTHROPIC_BASE_URL = this.config.baseUrl
      env.OPENAI_BASE_URL = this.config.baseUrl
    }

    // 通过 SessionManager 执行，获得重试+超时能力
    yield* this.sessionManager.executeWithRetry(
      () => this.runner.execute({
        command: 'opencode',
        args,
        workDir: this.workDir,
        env,
        stdin: fullPrompt,
      }),
      `opencode-${this.sessionId || 'new'}'
    )
  }

  getSessionId(): string | null {
    return this.sessionId
  }

  async close(): Promise<void> {
    // OneShotRunner 自动清理进程
  }
}
```

### 5.4 重构后的 ClaudeCodeAdapter (最小改动)

```typescript
// src/lib/adapter/claude-code-adapter.ts (重构后)

import type { AgentAdapter, AdapterConfig, AgentTask, StreamChunk } from './types'
import { processRegistry } from './process-registry'  // 保持不变
import { SessionManager } from './session-manager'

export class ClaudeCodeAdapter implements AgentAdapter {
  // ... 现有字段不变
  private sessionManager: SessionManager

  constructor() {
    this.sessionManager = new SessionManager({
      maxRetries: 3,
      noDataTimeoutMs: 60_000,
    })
  }

  async *send(task: AgentTask): AsyncIterable<StreamChunk> {
    const key = this.getRegistryKey()
    const parts: string[] = []
    if (task.systemPrompt) parts.push(task.systemPrompt)
    if (task.context) parts.push(`背景信息：\n${task.context}`)
    parts.push(task.prompt)
    const fullPrompt = parts.join('\n\n---\n\n')

    const spawnConfig = { /* ... 现有逻辑 ... */ }

    // ProcessRegistry 自带重试，SessionManager 提供超时检测
    // 这里 ProcessRegistry.send() 已经有重试逻辑，不需要再包一层
    for await (const chunk of processRegistry.send(key, fullPrompt, spawnConfig)) {
      if (chunk.type === 'session') {
        this.sessionId = chunk.content
      }
      yield chunk
    }
  }

  // ... close() 不变
}
```

注意：ClaudeCodeAdapter 的 ProcessRegistry 已经自带重试和超时，不需要 SessionManager 的 executeWithRetry。SessionManager 主要为 OpenCode 服务。

## 六、实施计划

### 阶段 1：提取 SessionManager + OneShotRunner (不改现有代码)

| 步骤 | 文件 | 改动 | 验证 |
|------|------|------|------|
| 1.1 | `session-manager.ts` | 新建，通用重试+超时逻辑 | 单元测试 |
| 1.2 | `oneshot-runner.ts` | 新建，OneShot CLI 执行器 | 单元测试 |
| 1.3 | `tests/session-manager.test.ts` | 测试重试、超时、永久错误分类 | 测试通过 |

### 阶段 2：重构 OpenCodeAdapter

| 步骤 | 文件 | 改动 | 验证 |
|------|------|------|------|
| 2.1 | `opencode-adapter.ts` | 用 SessionManager + OneShotRunner 重写 | 现有测试通过 |
| 2.2 | `tests/adapter.test.ts` | 更新 OpenCode 相关测试 | 测试通过 |
| 2.3 | `tests/multi-provider-isolation.test.ts` | 更新 OpenCode 环境变量测试 | 测试通过 |

### 阶段 3：优化 ClaudeCodeAdapter (可选)

| 步骤 | 文件 | 改动 | 验证 |
|------|------|------|------|
| 3.1 | `process-registry.ts` | 提取通用超时逻辑到 SessionManager | 现有测试通过 |
| 3.2 | `claude-code-adapter.ts` | 最小改动，复用 SessionManager 超时 | 现有测试通过 |

### 阶段 4：清理与文档

| 步骤 | 文件 | 改动 | 验证 |
|------|------|------|------|
| 4.1 | 更新 PROGRESS.md | 记录适配器重构完成 | - |
| 4.2 | 更新 design-decisions.md | 更新决策 #22 | - |

## 七、收益量化

| 指标 | 重构前 (OpenCode) | 重构后 (OpenCode) |
|------|-------------------|-------------------|
| 崩溃重试 | 0 次 | 3 次指数退避 |
| 卡死检测 | 无 | 60s 无输出超时 |
| 硬超时 | 20min (进程泄漏) | 20min (自动清理) |
| 孤儿进程 | 可能残留 | 自动清理 |
| 代码复用 | 0% (独立实现) | ~80% (共享 SessionManager) |

## 八、风险评估

| 风险 | 影响 | 缓解措施 |
|------|------|----------|
| OpenCode CLI 输出格式变化 | 解析失败 | OneShotRunner.parseEvent() 可覆盖 |
| 重试时 session 状态不一致 | 上下文丢失 | 靠 `--session <id>` 恢复，OpenCode 内部管理 |
| SessionManager 与 ProcessRegistry 逻辑重复 | 维护成本 | 阶段 3 统一提取 |
| Windows 进程清理不可靠 | 僵尸进程 | 复用现有的 taskkill 方案 + multica 的 .cmd shim 绕过经验 |

## 九、设计决策记录

| # | 决策 | 选择 | 原因 |
|---|------|------|------|
| D1 | OpenCode 是否做长连接 | 否，保持 one-shot | cc-connect 和 multica 都是 one-shot，OpenCode CLI 不支持 stdin 协议 |
| D2 | 是否抽象通用 ProcessPool | 否，阶段 1 不改 | ClaudeCode 的 ProcessRegistry 已稳定，先不动 |
| D3 | SessionManager 放在哪层 | 适配器层，不是 ProcessRegistry 层 | 两个适配器的重试语义不同，放在各自的 send() 中 |
| D4 | OneShotRunner 是否可继承 | 是，用 protected parseEvent() | 方便未来接入其他 one-shot CLI (codex, cursor 等) |
| D5 | 重试时是否重建 session | 不重建，靠 --session 恢复 | 参考 cc-connect 和 multica 的做法 |
