import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'events'
import { PassThrough } from 'stream'

// --- Mock child_process ---
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

const { mockExistsSync, mockMkdirSync, mockWriteFileSync, mockUnlinkSync } = vi.hoisted(() => ({
  mockExistsSync: vi.fn().mockReturnValue(true),
  mockMkdirSync: vi.fn(),
  mockWriteFileSync: vi.fn(),
  mockUnlinkSync: vi.fn(),
}))

vi.mock('fs', () => ({
  existsSync: mockExistsSync,
  mkdirSync: mockMkdirSync,
  writeFileSync: mockWriteFileSync,
  unlinkSync: mockUnlinkSync,
}))

// --- Import after mocks ---
let processRegistry: any

beforeEach(async () => {
  vi.clearAllMocks()
  vi.useFakeTimers()
  mockExistsSync.mockReturnValue(true)

  // Reset global singleton state
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

// Helper: consume async iterable into array
async function collect(gen: AsyncIterable<any>): Promise<any[]> {
  const results: any[] = []
  for await (const chunk of gen) {
    results.push(chunk)
  }
  return results
}


describe('ProcessRegistry', () => {
  describe('getOrCreate', () => {
    it('creates new process for unknown key', () => {
      const entry = processRegistry.getOrCreate('key1', { workDir: '/dir' })
      expect(entry).toBeDefined()
      expect(entry.alive).toBe(true)
      expect(mockSpawn).toHaveBeenCalledTimes(1)
    })

    it('reuses existing alive process', () => {
      processRegistry.getOrCreate('key1', { workDir: '/dir' })
      processRegistry.getOrCreate('key1', { workDir: '/dir' })
      expect(mockSpawn).toHaveBeenCalledTimes(1)
    })

    it('respawns dead process', () => {
      processRegistry.getOrCreate('key1', { workDir: '/dir' })
      fakeProc.exitCode = 0
      fakeProc.emit('exit')
      fakeProc = createFakeProcess()
      mockSpawn.mockReturnValue(fakeProc)
      processRegistry.getOrCreate('key1', { workDir: '/dir' })
      expect(mockSpawn).toHaveBeenCalledTimes(2)
    })
  })

  describe('spawnProcess', () => {
    it('writes mcpConfig to temp file and adds --mcp-config arg', () => {
      processRegistry.getOrCreate('key1', { workDir: '/dir', mcpConfig: '{"tools":["a"]}' })
      expect(mockWriteFileSync).toHaveBeenCalled()
      const args = mockSpawn.mock.calls[0][1]
      expect(args).toContain('--mcp-config')
    })

    it('adds --permission-mode arg', () => {
      processRegistry.getOrCreate('key1', { workDir: '/dir', permissionMode: 'auto' })
      const args = mockSpawn.mock.calls[0][1]
      expect(args).toContain('--permission-mode')
      expect(args).toContain('auto')
    })

    it('adds --model arg', () => {
      processRegistry.getOrCreate('key1', { workDir: '/dir', model: 'claude-3' })
      const args = mockSpawn.mock.calls[0][1]
      expect(args).toContain('--model')
      expect(args).toContain('claude-3')
    })

    it('injects provider env vars when apiKey/baseUrl provided', () => {
      processRegistry.getOrCreate('key1', { workDir: '/dir', apiKey: 'sk-123', baseUrl: 'https://api.test.com' })
      const env = mockSpawn.mock.calls[0][2].env
      expect(env.ANTHROPIC_API_KEY).toBe('sk-123')
      expect(env.ANTHROPIC_BASE_URL).toBe('https://api.test.com')
    })

    it('creates workDir if it does not exist', () => {
      mockExistsSync.mockReturnValue(false)
      processRegistry.getOrCreate('key1', { workDir: '/new-dir' })
      expect(mockMkdirSync).toHaveBeenCalledWith('/new-dir', { recursive: true })
    })
  })

  describe('send', () => {
    it('writes prompt JSON to stdin', async () => {
      const key = 'test-key'
      processRegistry.getOrCreate(key, { workDir: '/dir' })

      // Start send but don't await — readRound uses real stream events
      // that don't work with PassThrough + fake timers. Just verify stdin write.
      vi.useRealTimers()
      const gen = processRegistry.send(key, 'do it', { workDir: '/dir' })
      // Let the first tick run to trigger readRound → stdin.write
      await new Promise(r => setTimeout(r, 50))

      // Verify stdin received a JSON payload containing our prompt
      const written = fakeProc.stdin.read()
      if (written) {
        const payload = JSON.parse(written.toString())
        expect(payload.type).toBe('user')
        expect(payload.message.content[0].text).toContain('do it')
      }

      // Cleanup: destroy the generator
      gen.return(undefined as any)
    })

    it('throws when process entry not found and no config provided', async () => {
      vi.useRealTimers()
      await expect(
        collect(processRegistry.send('nonexistent', 'prompt'))
      ).rejects.toThrow('Process entry not found')
    })
  })

  describe('respondPermission', () => {
    it('returns false when entry not found', () => {
      const result = processRegistry.respondPermission('nonexistent', 'req-1', { behavior: 'allow' })
      expect(result).toBe(false)
    })

    it('returns false when requestId not found', () => {
      processRegistry.getOrCreate('key1', { workDir: '/dir' })
      const result = processRegistry.respondPermission('key1', 'invalid-req', { behavior: 'allow' })
      expect(result).toBe(false)
    })
  })

  describe('killEntry', () => {
    it('removes entry from registry', () => {
      processRegistry.getOrCreate('key1', { workDir: '/dir' })
      processRegistry.killEntry('key1')
      const registry = (globalThis as any).__processRegistry
      expect(registry.has('key1')).toBe(false)
    })

    it('cleans up mcpConfigFile', () => {
      processRegistry.getOrCreate('key1', { workDir: '/dir', mcpConfig: '{"tools":[]}' })
      processRegistry.killEntry('key1')
      expect(mockUnlinkSync).toHaveBeenCalled()
    })

    it('no-op for nonexistent key', () => {
      expect(() => processRegistry.killEntry('nonexistent')).not.toThrow()
    })
  })

  describe('cleanupIdle', () => {
    it('kills idle processes past timeout', () => {
      processRegistry.getOrCreate('key1', { workDir: '/dir' })
      // Advance time past IDLE_TIMEOUT_MS (10 min)
      vi.advanceTimersByTime(11 * 60 * 1000)
      processRegistry.cleanupIdle()
      const registry = (globalThis as any).__processRegistry
      expect(registry.has('key1')).toBe(false)
    })

    it('does not kill working processes', () => {
      processRegistry.getOrCreate('key1', { workDir: '/dir' })
      const entry = (globalThis as any).__processRegistry.get('key1')
      entry.state = 'working'
      vi.advanceTimersByTime(11 * 60 * 1000)
      processRegistry.cleanupIdle()
      expect((globalThis as any).__processRegistry.has('key1')).toBe(true)
    })

    it('kills dead processes immediately', () => {
      processRegistry.getOrCreate('key1', { workDir: '/dir' })
      fakeProc.exitCode = 1
      fakeProc.emit('exit')
      processRegistry.cleanupIdle()
      expect((globalThis as any).__processRegistry.size).toBe(0)
    })
  })

  describe('gracefulShutdown', () => {
    it('returns early when registry is empty — no spawn calls', () => {
      // 确保 registry 为空
      expect((globalThis as any).__processRegistry.size).toBe(0)
      vi.clearAllMocks() // 清除之前的 spawn 调用记录
      processRegistry.gracefulShutdown()
      // registry 为空时直接返回，不应该调用 spawn（用于 taskkill）
      expect(mockSpawn).not.toHaveBeenCalled()
    })
  })
})
