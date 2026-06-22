import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'events'
import { PassThrough } from 'stream'
import type { ChildProcess } from 'child_process'

function createFakeProcess(): ChildProcess & { stdin: PassThrough; stdout: PassThrough; stderr: PassThrough } {
  const proc = new EventEmitter() as ChildProcess & { stdin: PassThrough; stdout: PassThrough; stderr: PassThrough; pid: number; exitCode: number | null; kill: ReturnType<typeof vi.fn> }
  proc.pid = Math.floor(Math.random() * 10000) + 1000
  proc.stdin = new PassThrough()
  proc.stdout = new PassThrough()
  proc.stderr = new PassThrough()
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

let processRegistry: any

async function loadRegistry() {
  delete (globalThis as any).__processRegistry
  delete (globalThis as any).__processRegistryCleanupTimer
  delete (globalThis as any).__processRegistryShutdownRegistered
  vi.resetModules()
  const mod = await import('@/lib/adapter/process-registry')
  processRegistry = mod.processRegistry
}

async function collect(gen: AsyncIterable<any>): Promise<any[]> {
  const results: any[] = []
  for await (const chunk of gen) results.push(chunk)
  return results
}

async function nextChunk(gen: AsyncIterator<any>, timeoutMs = 500): Promise<any> {
  return Promise.race([
    gen.next(),
    new Promise((_, reject) => setTimeout(() => reject(new Error('Timed out waiting for next chunk')), timeoutMs)),
  ])
}

beforeEach(async () => {
  vi.clearAllMocks()
  vi.useRealTimers()
  mockExistsSync.mockReturnValue(true)
  fakeProc = createFakeProcess()
  mockSpawn.mockReturnValue(fakeProc)
  await loadRegistry()
})

afterEach(() => {
  try { processRegistry.killAll() } catch {}
  vi.useRealTimers()
})

describe('ProcessRegistry refactor regressions', () => {
  it('routes permission responses by effective key when allowedTools changes the registry key', async () => {
    const writes: string[] = []
    const originalWrite = fakeProc.stdin.write.bind(fakeProc.stdin)
    vi.spyOn(fakeProc.stdin, 'write').mockImplementation((chunk: any, ...args: any[]) => {
      writes.push(Buffer.isBuffer(chunk) ? chunk.toString('utf-8') : String(chunk))
      return originalWrite(chunk, ...args)
    })

    const gen = processRegistry.send('perm-tools', 'do it', {
      workDir: '/dir',
      allowedTools: ['Read'],
      permissionMode: 'default',
    })[Symbol.asyncIterator]()

    setTimeout(() => {
      fakeProc.stdout.write(Buffer.from(JSON.stringify({
        type: 'control_request',
        request_id: 'req-tools',
        request: { subtype: 'can_use_tool', tool_name: 'Read', input: { file_path: '/tmp/a.txt' } },
      }) + '\n'))
    }, 10)

    const first = await nextChunk(gen)
    expect(first.value.type).toBe('permission_request')

    const accepted = processRegistry.respondPermissionByRequestId('req-tools', { behavior: 'allow' })
    expect(accepted).toBe(true)
    expect(writes.some(w => w.includes('control_response') && w.includes('req-tools'))).toBe(true)

    await gen.return?.(undefined)
  })

  it('does not let an old exit handler delete a newer entry registered under the same key', () => {
    const entry1 = processRegistry.getOrCreate('exit-race', { workDir: '/dir' })
    const oldProc = entry1.process
    const registry = (globalThis as any).__processRegistry as Map<string, any>

    const proc2 = createFakeProcess()
    const entry2 = {
      ...entry1,
      process: proc2,
      stdin: proc2.stdin,
      alive: true,
      lastActive: Date.now(),
    }
    registry.set('exit-race', entry2)

    oldProc.emit('exit')

    expect(registry.get('exit-race')).toBe(entry2)
  })

  it('keeps public killEntry(key) compatibility and kills the current entry', () => {
    processRegistry.getOrCreate('public-kill', { workDir: '/dir' })
    const registry = (globalThis as any).__processRegistry as Map<string, any>

    processRegistry.killEntry('public-kill')

    expect(registry.has('public-kill')).toBe(false)
  })

  it('resumes the latest captured CLI session when rebuilding after a crash', async () => {
    const mainSpawns: Array<{ proc: ReturnType<typeof createFakeProcess>; args: string[] }> = []

    mockSpawn.mockImplementation((command: string, args: string[]) => {
      const proc = createFakeProcess()
      if (command !== 'taskkill') {
        mainSpawns.push({ proc, args })
        if (mainSpawns.length === 1) {
          setTimeout(() => {
            proc.stdout.write(Buffer.from(JSON.stringify({ session_id: 'sess-established' }) + '\n'))
            proc.exitCode = 1
            proc.stdout.end()
            proc.emit('exit')
          }, 10)
        } else {
          setTimeout(() => {
            proc.stdout.write(Buffer.from(JSON.stringify({ type: 'result', subtype: 'success' }) + '\n'))
          }, 10)
        }
      }
      fakeProc = proc
      return proc
    })

    await collect(processRegistry.send('resume-after-crash', 'prompt', { workDir: '/dir', sessionId: null }))

    expect(mainSpawns.length).toBeGreaterThanOrEqual(2)
    const retryArgs = mainSpawns[1].args
    const resumeIndex = retryArgs.indexOf('--resume')
    expect(resumeIndex).toBeGreaterThanOrEqual(0)
    expect(retryArgs[resumeIndex + 1]).toBe('sess-established')
  })

  it('uses a Set for pending permission waits so resolved permissions cannot spin the read loop', async () => {
    const { readFileSync } = await vi.importActual<typeof import('fs')>('fs')
    const source = readFileSync('src/lib/adapter/process-registry.ts', 'utf-8')

    expect(source).toContain('pendingPermissionSet')
    expect(source).not.toContain('pendingPermissionPromises')
  })
})
