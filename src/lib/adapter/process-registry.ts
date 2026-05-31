import { spawn, type ChildProcess } from 'child_process'
import { mkdirSync, existsSync, writeFileSync, unlinkSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import type { StreamChunk } from './types'

interface ProcessEntry {
  process: ChildProcess
  sessionId: string | null
  stdin: NodeJS.WritableStream
  lastActive: number
  alive: boolean
  state: 'idle' | 'working'
  mcpConfigFile: string | null
  mcpConfig: string | null  // Original mcpConfig JSON string for process rebuild
  workDir: string
  permissionMode: string
  pendingPermissions: Map<string, PendingPermission>
}

interface PendingPermission {
  requestId: string
  toolName: string
  toolInput: Record<string, unknown>
  resolve: (response: { behavior: 'allow' | 'deny'; updatedInput?: Record<string, unknown>; message?: string }) => void
}

interface SpawnConfig {
  workDir: string
  sessionId?: string | null
  permissionMode?: string
  mcpConfig?: string
}

const MAX_PROCESSES = 10
const IDLE_TIMEOUT_MS = 10 * 60 * 1000 // 10 minutes
const MAX_SEND_RETRIES = 3
const NO_DATA_TIMEOUT_MS = 60 * 1000 // 60 seconds
const BASE_RETRY_DELAY_MS = 1000 // 1s base for exponential backoff

// Error classification: permanent errors should not be retried
const PERMANENT_ERROR_PATTERNS = [
  'api_key_invalid',
  'invalid_api_key',
  'authentication_error',
  'authentication error',
  'permission_denied',
  'permission denied',
  'model_not_found',
  'model not found',
  'invalid_prompt',
]

function isPermanentError(error: string): boolean {
  const lower = error.toLowerCase()
  return PERMANENT_ERROR_PATTERNS.some(p => lower.includes(p.toLowerCase()))
}

function getRetryDelay(attempt: number): number {
  return Math.min(BASE_RETRY_DELAY_MS * Math.pow(2, attempt), 16000)
}

// Global registry to survive Next.js module reloads
// In dev mode, Next.js reloads modules on every request, which would
// clear the registry and lose process references. Using globalThis ensures
// the registry persists across module reloads.
declare global {
  var __processRegistry: Map<string, ProcessEntry> | undefined
  var __processRegistryCleanupTimer: ReturnType<typeof setInterval> | undefined
  var __processRegistryShutdownRegistered: boolean | undefined
}

class ProcessRegistry {
  private registry: Map<string, ProcessEntry>
  private cleanupTimer: ReturnType<typeof setInterval> | null = null

  constructor() {
    // Use global registry if it exists, otherwise create new one
    if (!globalThis.__processRegistry) {
      globalThis.__processRegistry = new Map<string, ProcessEntry>()
    }
    this.registry = globalThis.__processRegistry

    // Only set up cleanup timer and signal handlers once
    if (!globalThis.__processRegistryCleanupTimer) {
      this.cleanupTimer = setInterval(() => this.cleanupIdle(), 60_000)
      globalThis.__processRegistryCleanupTimer = this.cleanupTimer
    }

    // Register graceful shutdown handlers (once across all module reloads)
    if (!globalThis.__processRegistryShutdownRegistered) {
      globalThis.__processRegistryShutdownRegistered = true
      const shutdown = () => { this.gracefulShutdown() }
      process.on('SIGTERM', shutdown)
      process.on('SIGINT', shutdown)
      process.on('beforeExit', shutdown)
    }
  }

  getOrCreate(key: string, config: SpawnConfig): ProcessEntry {
    const existing = this.registry.get(key)
    if (existing && existing.alive && existing.process.exitCode === null) {
      existing.lastActive = Date.now()
      return existing
    }

    if (existing) {
      this.killEntry(key)
    }
    return this.spawnProcess(key, config)
  }

  private spawnProcess(key: string, config: SpawnConfig): ProcessEntry {
    // Long-lived process mode: use --print with stream-json for both input and output
    // --print enables non-interactive mode; process stays alive as long as stdin is open
    const args = ['-p', '--output-format', 'stream-json', '--input-format', 'stream-json', '--verbose', '--bare', '--permission-prompt-tool', 'stdio']

    let mcpConfigFile: string | null = null
    if (config.mcpConfig) {
      mcpConfigFile = join(tmpdir(), `agenthub-mcp-${Date.now()}.json`)
      writeFileSync(mcpConfigFile, config.mcpConfig, 'utf-8')
      args.push('--mcp-config', mcpConfigFile)
    }

    if (config.permissionMode) {
      args.push('--permission-mode', config.permissionMode)
    }

    if (config.sessionId) {
      args.push('--resume', config.sessionId)
    }

    const workDir = config.workDir
    if (!existsSync(workDir)) {
      mkdirSync(workDir, { recursive: true })
    }

    const proc = spawn('claude', args, {
      cwd: workDir,
      env: {
        ...process.env,
        PYTHONIOENCODING: 'utf-8',
        LANG: 'en_US.UTF-8',
        LC_ALL: 'en_US.UTF-8',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: true,
    })

    const entry: ProcessEntry = {
      process: proc,
      sessionId: config.sessionId || null,
      stdin: proc.stdin!,
      lastActive: Date.now(),
      alive: true,
      state: 'idle',
      mcpConfigFile,
      mcpConfig: config.mcpConfig || null,
      workDir,
      permissionMode: config.permissionMode || 'default',
      pendingPermissions: new Map(),
    }

    proc.on('exit', () => {
      entry.alive = false
      this.registry.delete(key)
    })

    if (proc.stderr) {
      proc.stderr.on('data', (chunk: Buffer) => {
        console.error(`[ProcessRegistry ${key}] stderr:`, chunk.toString())
      })
    }

    this.registry.set(key, entry)
    return entry
  }

  async *send(key: string, fullPrompt: string, config?: SpawnConfig): AsyncIterable<StreamChunk> {
    let attempt = 0
    let lastError: string | null = null

    while (attempt <= MAX_SEND_RETRIES) {
      let entry = this.registry.get(key)

      // If process is dead, rebuild it
      if (!entry || !entry.alive || entry.process.exitCode !== null) {
        if (attempt > 0 && !config) {
          throw new Error(`Process died and no config available to rebuild for key: ${key}`)
        }
        if (entry) this.killEntry(key)
        if (!config) throw new Error(`Process entry not found for key: ${key}`)
        entry = this.spawnProcess(key, config)
      }

      try {
        // Yield retry status if this is a retry attempt
        if (attempt > 0) {
          yield { type: 'status', content: 'process crashed, retrying...', data: { retry: attempt } }
        }

        yield* this.readRound(key, entry, fullPrompt)
        return  // Success — exit retry loop

      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err)
        attempt++

        // Permanent error: don't retry
        if (isPermanentError(lastError)) {
          console.error(`[ProcessRegistry ${key}] Permanent error: ${lastError}. Not retrying.`)
          break
        }

        if (attempt <= MAX_SEND_RETRIES) {
          // Kill old process and prepare for retry with exponential backoff
          this.killEntry(key)
          const delay = getRetryDelay(attempt - 1)
          console.warn(`[ProcessRegistry ${key}] Attempt ${attempt}/${MAX_SEND_RETRIES} failed: ${lastError}. Retrying in ${delay}ms...`)
          yield { type: 'status', content: `retrying in ${delay}ms...`, data: { retry: attempt } }
          await new Promise(resolve => setTimeout(resolve, delay))
        }
      }
    }

    // All attempts exhausted — yield error for frontend notification, then throw
    const errMsg = `Process failed after ${MAX_SEND_RETRIES + 1} attempts: ${lastError}`
    yield { type: 'error', content: errMsg }
    throw new Error(errMsg)
  }

  private async *readRound(key: string, entry: ProcessEntry, fullPrompt: string): AsyncIterable<StreamChunk> {
    if (!entry.alive || entry.process.exitCode !== null) {
      throw new Error(`Process not alive for key: ${key}`)
    }

    entry.lastActive = Date.now()
    entry.state = 'working'

    const jsonPayload = JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'text', text: fullPrompt }]
      }
    })
    const buffer = Buffer.from(jsonPayload + '\n', 'utf-8')
    entry.stdin.write(buffer)

    const stdout = entry.process.stdout
    if (!stdout) {
      throw new Error(`Process stdout not available for key: ${key}`)
    }

    const chunkQueue: StreamChunk[] = []
    let roundComplete = false
    let resolveRound: (() => void) | null = null
    const roundPromise = new Promise<void>((resolve) => {
      resolveRound = resolve
    })
    let bufferStr = ''
    let lastChunkTime = Date.now()
    const decoder = new TextDecoder()

    const onData = (raw: Buffer) => {
      entry.lastActive = Date.now()
      lastChunkTime = Date.now()
      bufferStr += decoder.decode(raw, { stream: true })
      const lines = bufferStr.split('\n')
      bufferStr = lines.pop() || ''

      for (const line of lines) {
        if (!line.trim()) continue
        try {
          const event = JSON.parse(line)

          if (event.session_id && !entry.sessionId) {
            entry.sessionId = event.session_id
          }

          if (event.type === 'control_request' && event.request?.subtype === 'can_use_tool') {
            const requestId = event.request_id
            const request = event.request
            chunkQueue.push({
              type: 'permission_request',
              content: `${request.tool_name}: ${JSON.stringify(request.input)}`,
              data: {
                requestId,
                toolName: request.tool_name,
                toolInput: request.input,
              }
            })
            const permissionPromise = new Promise<{ behavior: 'allow' | 'deny'; updatedInput?: any }>((resolve) => {
              const pending: PendingPermission = {
                requestId,
                toolName: request.tool_name,
                toolInput: request.input,
                resolve,
              }
              entry.pendingPermissions.set(requestId, pending)
          })
          }

          if (event.type === 'control_cancel_request') {
            const requestId = event.request_id
            chunkQueue.push({
              type: 'permission_cancel',
              content: requestId,
              data: { requestId },
            })
            const pending = entry.pendingPermissions.get(requestId)
            if (pending) {
              pending.resolve({ behavior: 'deny', message: 'Request cancelled by CLI' })
              entry.pendingPermissions.delete(requestId)
            }
          }

          if (event.type === 'assistant' && event.message?.content) {
            for (const block of event.message.content) {
              if (block.type === 'text' && block.text) {
                chunkQueue.push({ type: 'text', content: block.text })
              }
            }
          }

          if (event.type === 'result') {
            roundComplete = true
            if (resolveRound) resolveRound()
          }
        } catch {
          // Non-JSON output, skip
        }
      }
    }

    stdout.on('data', onData)

    try {
      while (!roundComplete) {
        // Check if process is dead
        if (!entry.alive || entry.process.exitCode !== null) {
          // Flush remaining chunks before throwing
          while (chunkQueue.length > 0) yield chunkQueue.shift()!

          const exitCode = entry.process.exitCode
          if (exitCode === 0) {
            // Normal exit but no result event — unexpected but not a crash
            console.warn(`[ProcessRegistry ${key}] Process exited normally (0) without result event`)
            break
          }
          throw new Error(`Process exited with code ${exitCode}`)
        }

        // Check no-data timeout
        if (Date.now() - lastChunkTime > NO_DATA_TIMEOUT_MS) {
          while (chunkQueue.length > 0) yield chunkQueue.shift()!
          throw new Error(`No data received for ${NO_DATA_TIMEOUT_MS / 1000}s, process appears stalled`)
        }

        const waits: Promise<boolean>[] = [
          new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 50))
        ]
        if (roundPromise) waits.push(roundPromise.then(() => true))

        const isDone = await Promise.race(waits)

        while (chunkQueue.length > 0) {
          yield chunkQueue.shift()!
        }

        if (isDone) break
      }
    } finally {
      stdout.off('data', onData)
    }

    // Yield remaining chunks
    while (chunkQueue.length > 0) {
      yield chunkQueue.shift()!
    }

    yield { type: 'status', content: 'completed' }
    entry.state = 'idle'
  }

  respondPermission(key: string, requestId: string, result: { behavior: 'allow' | 'deny'; updatedInput?: Record<string, unknown>; message?: string }): boolean {
    const entry = this.registry.get(key)
    if (!entry) return false

    const pending = entry.pendingPermissions.get(requestId)
    if (!pending) return false

    const cliResponse = {
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: requestId,
        response: result.behavior === 'allow'
          ? { behavior: 'allow', updatedInput: result.updatedInput || pending.toolInput }
          : { behavior: 'deny', message: result.message || 'User denied this tool use.' }
      }
    }
    const buffer = Buffer.from(JSON.stringify(cliResponse) + '\n', 'utf-8')
    entry.stdin.write(buffer)

    pending.resolve(result)
    entry.pendingPermissions.delete(requestId)
    return true
  }

  getSessionId(key: string): string | null {
    return this.registry.get(key)?.sessionId || null
  }

  killEntry(key: string): void {
    const entry = this.registry.get(key)
    if (!entry) return

    entry.alive = false
    const pid = entry.process.pid
    if (pid) {
      if (process.platform === 'win32') {
        try {
          spawn('taskkill', ['/pid', pid.toString(), '/T', '/F'], { shell: false })
        } catch {
          entry.process.kill('SIGTERM')
        }
      } else {
        try {
          process.kill(-pid, 'SIGTERM')
        } catch {
          entry.process.kill('SIGTERM')
        }
      }
    }

    if (entry.mcpConfigFile) {
      try { unlinkSync(entry.mcpConfigFile) } catch {}
    }

    this.registry.delete(key)
  }

  cleanupIdle(): void {
    const now = Date.now()
    for (const [key, entry] of this.registry) {
      if (!entry.alive || entry.process.exitCode !== null) {
        this.killEntry(key)
        continue
      }
      // Only kill truly idle processes, not ones actively working
      if (entry.state === 'idle' && now - entry.lastActive > IDLE_TIMEOUT_MS) {
        this.killEntry(key)
      }
    }

    if (this.registry.size > MAX_PROCESSES) {
      const entries = Array.from(this.registry.entries())
      entries.sort((a, b) => a[1].lastActive - b[1].lastActive)
      const toKill = entries.slice(0, entries.length - MAX_PROCESSES)
      for (const [key] of toKill) {
        this.killEntry(key)
      }
    }
  }

  killAll(): void {
    for (const [key] of this.registry) {
      this.killEntry(key)
    }
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer)
      this.cleanupTimer = null
    }
  }

  gracefulShutdown(): void {
    if (this.registry.size === 0) return

    console.log(`[ProcessRegistry] Shutting down ${this.registry.size} processes...`)

    // Phase 1: Send SIGTERM to all
    for (const [key, entry] of this.registry) {
      if (!entry.alive || entry.process.exitCode !== null) continue
      const pid = entry.process.pid
      if (pid) {
        try {
          if (process.platform === 'win32') {
            spawn('taskkill', ['/pid', pid.toString(), '/T'], { shell: false })
          } else {
            process.kill(-pid, 'SIGTERM')
          }
        } catch {}
      }
    }

    // Phase 2: Wait 5s, then force kill survivors
    setTimeout(() => {
      for (const [key, entry] of this.registry) {
        if (entry.alive && entry.process.exitCode === null) {
          const pid = entry.process.pid
          if (pid) {
            try {
              if (process.platform === 'win32') {
                spawn('taskkill', ['/pid', pid.toString(), '/T', '/F'], { shell: false })
              } else {
                process.kill(-pid, 'SIGKILL')
              }
            } catch {}
          }
        }
      }
      // Clean up temp files
      for (const [, entry] of this.registry) {
        if (entry.mcpConfigFile) {
          try { unlinkSync(entry.mcpConfigFile) } catch {}
        }
      }
      this.registry.clear()
    }, 5000)
  }
}

export const processRegistry = new ProcessRegistry()
