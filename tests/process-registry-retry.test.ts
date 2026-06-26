import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'events'
import { PassThrough } from 'stream'
import { isPermanentError, getRetryDelay } from '../src/lib/adapter/process-registry'

// --- Mock child_process for retry tests ---
function createFakeProcess() {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const proc: any = new EventEmitter()
  proc.pid = Math.floor(Math.random() * 10000) + 1000
  proc.stdin = stdin
  proc.stdout = stdout
  proc.stderr = stderr
  proc.exitCode = null
  proc.kill = vi.fn()
  return proc
}

let fakeProc: ReturnType<typeof createFakeProcess>
const mockSpawn = vi.fn(() => fakeProc)

vi.mock('child_process', () => ({
  spawn: (...args: any[]) => mockSpawn(...args),
}))

vi.mock('fs', () => ({
  existsSync: vi.fn().mockReturnValue(true),
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
  unlinkSync: vi.fn(),
}))

let processRegistry: any

beforeEach(async () => {
  vi.clearAllMocks()
  vi.useFakeTimers()
  delete (globalThis as any).__processRegistry
  delete (globalThis as any).__processRegistryCleanupTimer
  delete (globalThis as any).__processRegistryShutdownRegistered
  vi.resetModules()
  const mod = await import('@/lib/adapter/process-registry')
  processRegistry = mod.processRegistry
  fakeProc = createFakeProcess()
  mockSpawn.mockReturnValue(fakeProc)
})

afterEach(() => {
  vi.useRealTimers()
  try { processRegistry.killAll() } catch {}
})

async function collect(gen: AsyncIterable<any>): Promise<any[]> {
  const results: any[] = []
  for await (const chunk of gen) results.push(chunk)
  return results
}

describe('ProcessRegistry error classification', () => {
  describe('isPermanentError', () => {
    it('should classify API_KEY_INVALID as permanent', () => {
      expect(isPermanentError('API_KEY_INVALID')).toBe(true)
    })

    it('should classify authentication_error as permanent', () => {
      expect(isPermanentError('Authentication error: invalid key')).toBe(true)
    })

    it('should classify permission_denied as permanent (case insensitive)', () => {
      expect(isPermanentError('Permission denied for model')).toBe(true)
      expect(isPermanentError('PERMISSION_DENIED')).toBe(true)
    })

    it('should classify MODEL_NOT_FOUND as permanent', () => {
      expect(isPermanentError('Model not found: claude-xyz')).toBe(true)
    })

    it('should classify invalid_prompt as permanent', () => {
      expect(isPermanentError('invalid_prompt: empty input')).toBe(true)
    })

    it('should classify process crash as transient (not permanent)', () => {
      expect(isPermanentError('Process exited with code 1')).toBe(false)
    })

    it('should classify timeout as transient', () => {
      expect(isPermanentError('No data received for 60s')).toBe(false)
    })

    it('should classify unknown errors as transient', () => {
      expect(isPermanentError('Something went wrong')).toBe(false)
    })

    it('should handle empty error string', () => {
      expect(isPermanentError('')).toBe(false)
    })
  })

  describe('getRetryDelay (exponential backoff)', () => {
    it('should return 1s for attempt 0', () => {
      expect(getRetryDelay(0)).toBe(1000)
    })

    it('should return 2s for attempt 1', () => {
      expect(getRetryDelay(1)).toBe(2000)
    })

    it('should return 4s for attempt 2', () => {
      expect(getRetryDelay(2)).toBe(4000)
    })

    it('should cap at 16s', () => {
      expect(getRetryDelay(10)).toBe(16000)
    })
  })
})

describe('ProcessRegistry send() — max retries exhaustion', () => {
  it('should yield error and throw after MAX_SEND_RETRIES exhausted', { timeout: 15000 }, async () => {
    vi.useRealTimers()
    let spawnCount = 0

    mockSpawn.mockImplementation((...args: any[]) => {
      const proc = createFakeProcess()
      const cmd = args[0]?.toString() || ''
      if (!cmd.includes('taskkill') && !cmd.includes('kill')) {
        spawnCount++
        // Process crashes immediately each time (non-permanent error)
        setTimeout(() => {
          proc.exitCode = 1
          setImmediate(() => {
            proc.stdout.end()
            proc.emit('exit')
          })
        }, 5)
      }
      fakeProc = proc
      return proc
    })

    // Collect chunks manually, capturing the error chunk before throw
    const chunks: any[] = []
    let thrownError: Error | null = null
    try {
      for await (const chunk of processRegistry.send('max-retry', 'test', { workDir: '/dir' })) {
        chunks.push(chunk)
      }
    } catch (err) {
      thrownError = err as Error
    }

    // Should have spawned 4 times (initial + 3 retries)
    expect(spawnCount).toBe(4)

    // Should have thrown with retry exhaustion error
    expect(thrownError).not.toBeNull()
    expect(thrownError!.message).toMatch(/Process failed after.*attempts/)

    // Should have yielded error chunk before throwing
    const errorChunks = chunks.filter((c: any) => c.type === 'error')
    expect(errorChunks.length).toBeGreaterThanOrEqual(1)
  })
})
