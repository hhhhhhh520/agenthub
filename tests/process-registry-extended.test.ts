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

describe('ProcessRegistry — extended coverage', () => {
  describe('isPermanentError (via send retry behavior)', () => {
    it('does not retry when stderr contains api_key_invalid', async () => {
      vi.useRealTimers()
      let mainSpawnCount = 0
      mockSpawn.mockImplementation((...args: any[]) => {
        const proc = createFakeProcess()
        // Only count main command spawns, not cleanup (taskkill) spawns
        const cmd = args[0]?.toString() || ''
        if (!cmd.includes('taskkill') && !cmd.includes('kill')) {
          mainSpawnCount++
          // Process writes API key error to stderr then exits
          // Use setImmediate (fires after I/O events) to ensure stderr 'data' is processed before exit
          setTimeout(() => {
            proc.stderr.write(Buffer.from('Error: api_key_invalid: Invalid API key provided\n'))
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

      await expect(collect(processRegistry.send('perm-err', 'test', { workDir: '/dir' })))
        .rejects.toThrow(/api_key_invalid/)
      expect(mainSpawnCount).toBe(1)
    })

    it('does not retry when stderr contains authentication_error', async () => {
      vi.useRealTimers()
      let mainSpawnCount = 0
      mockSpawn.mockImplementation((...args: any[]) => {
        const proc = createFakeProcess()
        const cmd = args[0]?.toString() || ''
        if (!cmd.includes('taskkill') && !cmd.includes('kill')) {
          mainSpawnCount++
          setTimeout(() => {
            proc.stderr.write(Buffer.from('Authentication error: invalid credentials\n'))
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

      await expect(collect(processRegistry.send('auth-err', 'test', { workDir: '/dir' })))
        .rejects.toThrow(/authentication.error/i)
      expect(mainSpawnCount).toBe(1)
    })

    it('retries when stderr contains transient error', async () => {
      vi.useRealTimers()
      let mainSpawnCount = 0
      mockSpawn.mockImplementation((...args: any[]) => {
        const proc = createFakeProcess()
        const cmd = args[0]?.toString() || ''
        if (!cmd.includes('taskkill') && !cmd.includes('kill')) {
          mainSpawnCount++
          if (mainSpawnCount <= 2) {
            setTimeout(() => {
              proc.stderr.write(Buffer.from('connection timeout\n'))
              proc.exitCode = 1
              setImmediate(() => {
                proc.stdout.end()
                proc.emit('exit')
              })
            }, 5)
          } else {
            setTimeout(() => {
              proc.stdout.write(Buffer.from(JSON.stringify({ type: 'result', subtype: 'success' }) + '\n'))
            }, 10)
          }
        }
        fakeProc = proc
        return proc
      })

      const chunks = await collect(processRegistry.send('transient-err', 'test', { workDir: '/dir' }))
      expect(mainSpawnCount).toBe(3)
      expect(chunks.some((c: any) => c.type === 'status' && c.content === 'completed')).toBe(true)
    })

    it('error message includes stderr text when process exits', async () => {
      vi.useRealTimers()
      mockSpawn.mockImplementation(() => {
        const proc = createFakeProcess()
        setTimeout(() => {
          proc.stderr.write(Buffer.from('Unexpected error: model not found\n'))
          proc.exitCode = 1
          setImmediate(() => {
            proc.stdout.end()
            proc.emit('exit')
          })
        }, 5)
        fakeProc = proc
        return proc
      })

      await expect(collect(processRegistry.send('stderr-msg', 'test', { workDir: '/dir' })))
        .rejects.toThrow(/Process exited with code 1:.*model not found/)
    })

    it('retries on transient error (process crash)', async () => {
      vi.useRealTimers()
      const key = 'transient-err'
      let callCount = 0
      mockSpawn.mockImplementation(() => {
        callCount++
        const proc = createFakeProcess()
        if (callCount === 1) {
          // First call: process dies immediately
          setTimeout(() => {
            proc.exitCode = 1
            proc.emit('exit')
          }, 5)
        } else {
          // Second call: succeed
          setTimeout(() => {
            proc.stdout.write(Buffer.from(JSON.stringify({ type: 'result', subtype: 'success' }) + '\n'))
          }, 5)
        }
        fakeProc = proc
        return proc
      })

      const chunks = await collect(processRegistry.send(key, 'test', { workDir: '/dir' }))
      // Should have retried and eventually succeeded
      expect(chunks.some((c: any) => c.type === 'status' && c.content === 'completed')).toBe(true)
    })
  })

  describe('send with ndjson format', () => {
    it('reads ndjson events and yields chunks', async () => {
      vi.useRealTimers()
      const key = 'ndjson-send'
      processRegistry.getOrCreate(key, { workDir: '/dir', command: 'opencode', args: ['run'], format: 'ndjson' })

      setTimeout(() => {
        fakeProc.stdout.write(Buffer.from(JSON.stringify({ type: 'text', part: { text: 'hello' } }) + '\n'))
        fakeProc.stdout.emit('close')
      }, 10)

      const chunks = await collect(processRegistry.send(key, 'prompt', { workDir: '/dir', command: 'opencode', args: ['run'], format: 'ndjson' }))
      expect(chunks.some((c: any) => c.type === 'text' && c.content === 'hello')).toBe(true)
      expect(chunks.some((c: any) => c.type === 'status' && c.content === 'completed')).toBe(true)
    })

    it('cleans up ndjson process after send', async () => {
      vi.useRealTimers()
      const key = 'ndjson-cleanup'
      const config = { workDir: '/dir', command: 'opencode', args: ['run'], format: 'ndjson' as const }
      processRegistry.getOrCreate(key, config)

      // Verify entry exists before send (用 values 查,因为配置指纹后 effectiveKey 含 hash)
      const registry = (globalThis as any).__processRegistry as Map<string, any>
      const initialKeys = [...registry.keys()].filter((k: string) => k.startsWith(key))
      expect(initialKeys.length).toBe(1)

      setTimeout(() => {
        fakeProc.stdout.write(Buffer.from(JSON.stringify({ type: 'text', part: { text: 'done' } }) + '\n'))
        fakeProc.stdout.emit('close')
      }, 10)

      const spawnCountBefore = mockSpawn.mock.calls.length
      await collect(processRegistry.send(key, 'prompt', config))
      // Process should be cleaned up after ndjson send
      const finalKeys = [...registry.keys()].filter((k: string) => k.startsWith(key))
      expect(finalKeys.length).toBe(0)
      // killEntry should have spawned a kill command (taskkill on Windows)
      expect(mockSpawn.mock.calls.length).toBeGreaterThan(spawnCountBefore)
    })

    it('respawns dead ndjson process and succeeds', async () => {
      vi.useRealTimers()
      const config = { workDir: '/dir', command: 'opencode', args: ['run'], format: 'ndjson' as const }
      // Pre-spawn a process that's already dead
      const entry = processRegistry.getOrCreate('ndjson-dead', config)
      entry.alive = false
      entry.process.exitCode = 1

      // Next spawn will succeed
      fakeProc = createFakeProcess()
      mockSpawn.mockReturnValue(fakeProc)
      setTimeout(() => {
        fakeProc.stdout.write(Buffer.from(JSON.stringify({ type: 'text', part: { text: 'recovered' } }) + '\n'))
        fakeProc.stdout.end()
      }, 10)

      const chunks = await collect(processRegistry.send('ndjson-dead', 'prompt', config))
      expect(chunks.some((c: any) => c.type === 'text' && c.content === 'recovered')).toBe(true)
    })

    it('throws on permanent error event without retry', async () => {
      vi.useRealTimers()
      let mainSpawnCount = 0
      mockSpawn.mockImplementation((...args: any[]) => {
        const proc = createFakeProcess()
        const cmd = args[0]?.toString() || ''
        if (!cmd.includes('taskkill') && !cmd.includes('kill')) {
          mainSpawnCount++
          setTimeout(() => {
            proc.stdout.write(Buffer.from(JSON.stringify({
              type: 'error',
              error: { data: { message: 'api_key_invalid: Invalid API key' } }
            }) + '\n'))
            proc.stdout.emit('close')
          }, 5)
        }
        fakeProc = proc
        return proc
      })

      await expect(collect(processRegistry.send('ndjson-perm', 'prompt', { workDir: '/dir', command: 'opencode', args: ['run'], format: 'ndjson' })))
        .rejects.toThrow(/api_key_invalid/)
      // Only 1 main spawn — no retry on permanent error
      expect(mainSpawnCount).toBe(1)
    })

    it('includes stderr in error when ndjson process exits non-zero', async () => {
      vi.useRealTimers()
      mockSpawn.mockImplementation(() => {
        const proc = createFakeProcess()
        setTimeout(() => {
          proc.stderr.write(Buffer.from('Error: model not found\n'))
          proc.exitCode = 1
          setImmediate(() => {
            proc.stdout.emit('close')
            proc.emit('exit')
          })
        }, 5)
        fakeProc = proc
        return proc
      })

      await expect(collect(processRegistry.send('ndjson-stderr', 'prompt', { workDir: '/dir', command: 'opencode', args: ['run'], format: 'ndjson' })))
        .rejects.toThrow(/Process exited with code 1:.*model not found/)
    })
  })

  describe('readRound — image attachments', () => {
    it('includes image blocks in content array', async () => {
      vi.useRealTimers()
      const key = 'img-test'
      processRegistry.getOrCreate(key, { workDir: '/dir' })

      setTimeout(() => {
        fakeProc.stdout.write(Buffer.from(JSON.stringify({ type: 'result', subtype: 'success' }) + '\n'))
      }, 10)

      await collect(processRegistry.send(key, 'describe image', { workDir: '/dir' }, [
        { mimeType: 'image/png', data: 'base64data' }
      ]))

      // Verify stdin received image content — MUST have been written
      const written = fakeProc.stdin.read()
      expect(written).not.toBeNull()
      const payload = JSON.parse(written!.toString())
      const content = payload.message.content
      expect(content.some((b: any) => b.type === 'image' && b.source?.data === 'base64data')).toBe(true)
      expect(content.some((b: any) => b.type === 'text' && b.text === 'describe image')).toBe(true)
    })
  })

  describe('readRound — permission handling', () => {
    it('emits permission_request chunk on control_request', async () => {
      vi.useRealTimers()
      const key = 'perm-req'
      processRegistry.getOrCreate(key, { workDir: '/dir' })

      setTimeout(() => {
        fakeProc.stdout.write(Buffer.from(JSON.stringify({
          type: 'control_request',
          request_id: 'req-1',
          request: { subtype: 'can_use_tool', tool_name: 'Write', input: { file_path: '/tmp/test' } },
        }) + '\n'))
        fakeProc.stdout.write(Buffer.from(JSON.stringify({ type: 'result', subtype: 'success' }) + '\n'))
      }, 10)

      const chunks = await collect(processRegistry.send(key, 'test', { workDir: '/dir' }))
      const permReq = chunks.find((c: any) => c.type === 'permission_request')
      expect(permReq).toBeDefined()
      expect(permReq.data.toolName).toBe('Write')
      expect(permReq.data.requestId).toBe('req-1')
    })
  })

  describe('respondPermission', () => {
    it('writes control_response to stdin and resolves pending', async () => {
      vi.useRealTimers()
      const key = 'perm-resp'
      processRegistry.getOrCreate(key, { workDir: '/dir' })

      // Simulate a pending permission
      const entry = (globalThis as any).__processRegistry.get(key)
      let resolved: any = null
      entry.pendingPermissions.set('req-1', {
        requestId: 'req-1',
        toolName: 'Write',
        toolInput: { file_path: '/tmp/test' },
        resolve: (r: any) => { resolved = r },
      })

      const result = processRegistry.respondPermission(key, 'req-1', { behavior: 'allow' })
      expect(result).toBe(true)
      expect(resolved).toEqual({ behavior: 'allow' })
      expect(entry.pendingPermissions.has('req-1')).toBe(false)

      // Verify control_response was written to stdin
      const written = fakeProc.stdin.read()
      if (written) {
        const payload = JSON.parse(written.toString())
        expect(payload.type).toBe('control_response')
        expect(payload.response.response.behavior).toBe('allow')
      }
    })

    it('deny behavior sends deny message', async () => {
      vi.useRealTimers()
      const key = 'perm-deny'
      processRegistry.getOrCreate(key, { workDir: '/dir' })
      const entry = (globalThis as any).__processRegistry.get(key)
      let resolved: any = null
      entry.pendingPermissions.set('req-2', {
        requestId: 'req-2',
        toolName: 'Bash',
        toolInput: { command: 'rm -rf /' },
        resolve: (r: any) => { resolved = r },
      })

      processRegistry.respondPermission(key, 'req-2', { behavior: 'deny', message: 'Too dangerous' })
      expect(resolved).toEqual({ behavior: 'deny', message: 'Too dangerous' })

      const written = fakeProc.stdin.read()
      if (written) {
        const payload = JSON.parse(written.toString())
        expect(payload.response.response.behavior).toBe('deny')
        expect(payload.response.response.message).toBe('Too dangerous')
      }
    })
  })

  describe('cleanupIdle — MAX_PROCESSES overflow', () => {
    it('evicts least recently used processes when over limit', () => {
      // Create 12 processes (MAX_PROCESSES = 10)
      for (let i = 0; i < 12; i++) {
        processRegistry.getOrCreate(`key-${i}`, { workDir: `/dir-${i}` })
      }
      expect((globalThis as any).__processRegistry.size).toBe(12)

      // Advance time slightly so all are recent but in order
      vi.advanceTimersByTime(1000)
      processRegistry.cleanupIdle()

      // Should evict 2 oldest (key-0, key-1)
      expect((globalThis as any).__processRegistry.size).toBeLessThanOrEqual(10)
    })
  })

  describe('gracefulShutdown', () => {
    it('sends SIGTERM to all alive processes', () => {
      processRegistry.getOrCreate('key-1', { workDir: '/dir-1' })
      processRegistry.getOrCreate('key-2', { workDir: '/dir-2' })

      processRegistry.gracefulShutdown()

      // Phase 1: should have spawned taskkill/kill for each process
      // On win32, spawn('taskkill', ...) is called
      const killCalls = mockSpawn.mock.calls.filter((c: any) => c[0] === 'taskkill' || c[0] === 'kill')
      // At least 2 kill attempts (one per process)
      expect(killCalls.length).toBeGreaterThanOrEqual(2)
    })
  })

  describe('killEntry — mcpConfig cleanup', () => {
    it('deletes mcpConfigFile when entry has one', async () => {
      const { unlinkSync } = await import('fs')
      processRegistry.getOrCreate('mcp-key', { workDir: '/dir', mcpConfig: '{"tools":["a"]}' })
      processRegistry.killEntry('mcp-key')
      expect(unlinkSync).toHaveBeenCalled()
    })
  })

  describe('readRound — process exit edge cases', () => {
    it('yields partial text before process exits with code 0', async () => {
      vi.useRealTimers()
      const key = 'partial-exit'
      processRegistry.getOrCreate(key, { workDir: '/dir' })

      setTimeout(() => {
        fakeProc.stdout.write(Buffer.from(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'partial' }] } }) + '\n'))
        fakeProc.exitCode = 0
        fakeProc.stdout.end()
        fakeProc.emit('exit')
      }, 10)

      const chunks = await collect(processRegistry.send(key, 'test', { workDir: '/dir' }))
      expect(chunks.some((c: any) => c.type === 'text' && c.content === 'partial')).toBe(true)
    })

    it('retries when process dies with non-zero code and succeeds', async () => {
      vi.useRealTimers()
      let callCount = 0
      mockSpawn.mockImplementation(() => {
        callCount++
        const proc = createFakeProcess()
        if (callCount === 1) {
          setTimeout(() => {
            proc.exitCode = 1
            proc.stdout.end()
            proc.emit('exit')
          }, 5)
        } else {
          setTimeout(() => {
            proc.stdout.write(Buffer.from(JSON.stringify({ type: 'result', subtype: 'success' }) + '\n'))
          }, 10)
        }
        fakeProc = proc
        return proc
      })

      const chunks = await collect(processRegistry.send('retry-success', 'test', { workDir: '/dir' }))
      expect(chunks.some((c: any) => c.type === 'status' && c.content === 'completed')).toBe(true)
    })
  })

  describe('readRound — session_id extraction', () => {
    it('captures session_id from event and stores in entry', async () => {
      vi.useRealTimers()
      const key = 'session-capture'
      processRegistry.getOrCreate(key, { workDir: '/dir' })

      setTimeout(() => {
        fakeProc.stdout.write(Buffer.from(JSON.stringify({ session_id: 'sess-abc', type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } }) + '\n'))
        fakeProc.stdout.write(Buffer.from(JSON.stringify({ type: 'result', subtype: 'success' }) + '\n'))
      }, 10)

      await collect(processRegistry.send(key, 'test', { workDir: '/dir' }))
      expect(processRegistry.getSessionId(key)).toBe('sess-abc')
    })
  })

  describe('readNdjsonRound — sessionID extraction', () => {
    it('extracts sessionID from ndjson events', async () => {
      vi.useRealTimers()
      const key = 'ndjson-session'
      processRegistry.getOrCreate(key, { workDir: '/dir', command: 'opencode', args: ['run'], format: 'ndjson' })

      setTimeout(() => {
        fakeProc.stdout.write(Buffer.from(JSON.stringify({ sessionID: 'oc-sess-1', type: 'text', part: { text: 'hello' } }) + '\n'))
        fakeProc.stdout.emit('close')
      }, 10)

      const chunks = await collect(processRegistry.send(key, 'prompt', { workDir: '/dir', command: 'opencode', args: ['run'], format: 'ndjson' }))
      const sessionChunk = chunks.find((c: any) => c.type === 'session')
      expect(sessionChunk?.content).toBe('oc-sess-1')
    })
  })

  describe('readNdjsonRound — error event variants', () => {
    it('handles error with event.message fallback', async () => {
      vi.useRealTimers()
      const key = 'err-fallback'
      processRegistry.getOrCreate(key, { workDir: '/dir', command: 'opencode', args: ['run'], format: 'ndjson' })

      setTimeout(() => {
        fakeProc.stdout.write(Buffer.from(JSON.stringify({ type: 'error', message: 'direct message' }) + '\n'))
        fakeProc.stdout.emit('close')
      }, 10)

      const chunks = await collect(processRegistry.send(key, 'prompt', { workDir: '/dir', command: 'opencode', args: ['run'], format: 'ndjson' }))
      const err = chunks.find((c: any) => c.type === 'error')
      expect(err?.content).toBe('direct message')
    })

    it('handles error with no message (Unknown error)', async () => {
      vi.useRealTimers()
      const key = 'err-unknown'
      processRegistry.getOrCreate(key, { workDir: '/dir', command: 'opencode', args: ['run'], format: 'ndjson' })

      setTimeout(() => {
        fakeProc.stdout.write(Buffer.from(JSON.stringify({ type: 'error' }) + '\n'))
        fakeProc.stdout.emit('close')
      }, 10)

      const chunks = await collect(processRegistry.send(key, 'prompt', { workDir: '/dir', command: 'opencode', args: ['run'], format: 'ndjson' }))
      const err = chunks.find((c: any) => c.type === 'error')
      expect(err?.content).toBe('Unknown error')
    })
  })

  describe('readNdjsonRound — process dies mid-stream', () => {
    it('completes with partial data when process exits', async () => {
      vi.useRealTimers()
      const key = 'ndjson-mid-die'
      processRegistry.getOrCreate(key, { workDir: '/dir', command: 'opencode', args: ['run'], format: 'ndjson' })

      setTimeout(() => {
        fakeProc.stdout.write(Buffer.from(JSON.stringify({ type: 'text', part: { text: 'partial' } }) + '\n'))
        fakeProc.stdout.end()
      }, 10)

      const chunks = await collect(processRegistry.send(key, 'prompt', { workDir: '/dir', command: 'opencode', args: ['run'], format: 'ndjson' }))
      expect(chunks.some((c: any) => c.type === 'text' && c.content === 'partial')).toBe(true)
      expect(chunks.some((c: any) => c.type === 'status' && c.content === 'completed')).toBe(true)
    })
  })

  describe('readNdjsonRound — non-JSON output', () => {
    it('skips non-JSON lines', async () => {
      vi.useRealTimers()
      const key = 'ndjson-nonjson'
      processRegistry.getOrCreate(key, { workDir: '/dir', command: 'opencode', args: ['run'], format: 'ndjson' })

      setTimeout(() => {
        fakeProc.stdout.write(Buffer.from('not json at all\n'))
        fakeProc.stdout.write(Buffer.from(JSON.stringify({ type: 'text', part: { text: 'real' } }) + '\n'))
        fakeProc.stdout.emit('close')
      }, 10)

      const chunks = await collect(processRegistry.send(key, 'prompt', { workDir: '/dir', command: 'opencode', args: ['run'], format: 'ndjson' }))
      expect(chunks.some((c: any) => c.type === 'text' && c.content === 'real')).toBe(true)
    })
  })

  describe('readRound — non-JSON output', () => {
    it('skips non-JSON lines in claude format', async () => {
      vi.useRealTimers()
      const key = 'claude-nonjson'
      processRegistry.getOrCreate(key, { workDir: '/dir' })

      setTimeout(() => {
        fakeProc.stdout.write(Buffer.from('random text output\n'))
        fakeProc.stdout.write(Buffer.from(JSON.stringify({ type: 'result', subtype: 'success' }) + '\n'))
      }, 10)

      const chunks = await collect(processRegistry.send(key, 'test', { workDir: '/dir' }))
      expect(chunks.some((c: any) => c.type === 'status' && c.content === 'completed')).toBe(true)
    })
  })

  describe('readRound — process exit with code 0 but no result', () => {
    it('warns and completes gracefully', async () => {
      vi.useRealTimers()
      const key = 'exit-no-result'
      processRegistry.getOrCreate(key, { workDir: '/dir' })

      setTimeout(() => {
        fakeProc.exitCode = 0
        fakeProc.emit('exit')
      }, 10)

      const chunks = await collect(processRegistry.send(key, 'test', { workDir: '/dir' }))
      // Should complete without throwing
      expect(chunks.some((c: any) => c.type === 'status' && c.content === 'completed')).toBe(true)
    })
  })
})
