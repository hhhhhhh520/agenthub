import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'events'

// --- Mock setup ---
const mockStdin = { write: vi.fn(), end: vi.fn() }
const mockStdout = new EventEmitter()
const mockStderr = new EventEmitter()
const mockProcessObj: any = {
  pid: 9999,
  stdin: null,
  stdout: mockStdout,
  stderr: mockStderr,
  exitCode: null,
  on: vi.fn((event: string, cb: Function) => {
    if (event === 'exit') {
      // Store callback for manual invocation
      mockProcessObj._exitCb = cb
    }
  }),
  kill: vi.fn(),
}

const { mockSpawn } = vi.hoisted(() => ({
  mockSpawn: vi.fn(() => mockProcessObj),
}))

vi.mock('child_process', () => ({
  spawn: (...args: any[]) => {
    mockSpawn(...args)
    mockProcessObj.stdin = mockStdin
    mockProcessObj.stdout = mockStdout
    mockProcessObj.stderr = mockStderr
    mockProcessObj.exitCode = null
    return mockProcessObj
  },
}))

vi.mock('fs', () => ({
  existsSync: vi.fn().mockReturnValue(true),
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
  unlinkSync: vi.fn(),
}))

// Import after mocks
const { processRegistry } = await import('@/lib/adapter/process-registry')

beforeEach(() => {
  vi.clearAllMocks()
  mockStdin.write.mockClear()
  mockStdin.end.mockClear()
  mockStdout.removeAllListeners()
  mockStderr.removeAllListeners()
  mockProcessObj.exitCode = null
  mockProcessObj.on.mockClear()
  mockProcessObj.kill.mockClear()
  mockSpawn.mockClear()
  mockSpawn.mockReturnValue(mockProcessObj)
})

describe('ProcessRegistry NDJSON support', () => {
  it('spawnProcess uses custom command and args', async () => {
    const config = {
      workDir: '/project',
      command: 'opencode',
      args: ['run', '--format', 'json', '--dir', '/project', '--model', 'claude-3'],
      format: 'ndjson' as const,
    }

    // Make stdout emit end quickly
    setTimeout(() => mockStdout.emit('close'), 10)

    const gen = processRegistry.send('test-key', 'hello', config)
    for await (const _ of gen) { /* consume */ }

    expect(mockSpawn).toHaveBeenCalledWith(
      'opencode',
      ['run', '--format', 'json', '--dir', '/project', '--model', 'claude-3'],
      expect.objectContaining({ shell: true })
    )
  })

  it('spawnProcess merges custom env into spawn env', async () => {
    const config = {
      workDir: '/project',
      command: 'opencode',
      args: ['run'],
      format: 'ndjson' as const,
      env: { OPENCODE_PERMISSION: '{"*":"allow"}', CUSTOM_VAR: 'test' },
    }

    setTimeout(() => mockStdout.emit('close'), 10)

    const gen = processRegistry.send('test-key', 'hello', config)
    for await (const _ of gen) { /* consume */ }

    const spawnEnv = mockSpawn.mock.calls[0][2].env
    expect(spawnEnv.OPENCODE_PERMISSION).toBe('{"*":"allow"}')
    expect(spawnEnv.CUSTOM_VAR).toBe('test')
  })

  it('readNdjsonRound writes raw text to stdin', async () => {
    const config = {
      workDir: '/project',
      command: 'opencode',
      args: ['run'],
      format: 'ndjson' as const,
    }

    setTimeout(() => mockStdout.emit('close'), 10)

    const gen = processRegistry.send('test-key', 'my prompt', config)
    for await (const _ of gen) { /* consume */ }

    expect(mockStdin.write).toHaveBeenCalled()
    const written = mockStdin.write.mock.calls[0][0]
    expect(Buffer.isBuffer(written)).toBe(true)
    expect(written.toString()).toBe('my prompt')
    expect(mockStdin.end).toHaveBeenCalled()
  })

  it('readNdjsonRound parses text events', async () => {
    const config = {
      workDir: '/project',
      command: 'opencode',
      args: ['run'],
      format: 'ndjson' as const,
    }

    setTimeout(() => {
      mockStdout.emit('data', Buffer.from(JSON.stringify({ type: 'text', part: { text: 'hello world' } }) + '\n'))
      mockStdout.emit('close')
    }, 10)

    const chunks: any[] = []
    const gen = processRegistry.send('test-key', 'prompt', config)
    for await (const chunk of gen) {
      chunks.push(chunk)
    }

    const textChunks = chunks.filter(c => c.type === 'text')
    expect(textChunks.length).toBeGreaterThanOrEqual(1)
    expect(textChunks.some((c: any) => c.content === 'hello world')).toBe(true)
  })

  it('readNdjsonRound parses step_finish events', async () => {
    const config = {
      workDir: '/project',
      command: 'opencode',
      args: ['run'],
      format: 'ndjson' as const,
    }

    setTimeout(() => {
      mockStdout.emit('data', Buffer.from(JSON.stringify({ type: 'step_finish', part: { text: 'step result' } }) + '\n'))
      mockStdout.emit('close')
    }, 10)

    const chunks: any[] = []
    const gen = processRegistry.send('test-key', 'prompt', config)
    for await (const chunk of gen) {
      chunks.push(chunk)
    }

    const textChunks = chunks.filter(c => c.type === 'text')
    expect(textChunks.some((c: any) => c.content === 'step result')).toBe(true)
  })

  it('readNdjsonRound parses error events', async () => {
    const config = {
      workDir: '/project',
      command: 'opencode',
      args: ['run'],
      format: 'ndjson' as const,
    }

    setTimeout(() => {
      mockStdout.emit('data', Buffer.from(JSON.stringify({ type: 'error', data: { message: 'something broke' } }) + '\n'))
      mockStdout.emit('close')
    }, 10)

    const chunks: any[] = []
    const gen = processRegistry.send('test-key', 'prompt', config)
    for await (const chunk of gen) {
      chunks.push(chunk)
    }

    const errorChunks = chunks.filter(c => c.type === 'error')
    expect(errorChunks.length).toBeGreaterThanOrEqual(1)
    expect(errorChunks.some((c: any) => c.content === 'something broke')).toBe(true)
  })

  it('readNdjsonRound extracts sessionID', async () => {
    const config = {
      workDir: '/project',
      command: 'opencode',
      args: ['run'],
      format: 'ndjson' as const,
    }

    setTimeout(() => {
      mockStdout.emit('data', Buffer.from(JSON.stringify({ sessionID: 'sess-abc', type: 'text', part: { text: 'hi' } }) + '\n'))
      mockStdout.emit('close')
    }, 10)

    const chunks: any[] = []
    const gen = processRegistry.send('test-key', 'prompt', config)
    for await (const chunk of gen) {
      chunks.push(chunk)
    }

    const sessionChunks = chunks.filter(c => c.type === 'session')
    expect(sessionChunks.length).toBe(1)
    expect(sessionChunks[0].content).toBe('sess-abc')
  })

  it('send with format=ndjson dispatches to readNdjsonRound', async () => {
    const config = {
      workDir: '/project',
      command: 'opencode',
      args: ['run'],
      format: 'ndjson' as const,
    }

    setTimeout(() => {
      mockStdout.emit('data', Buffer.from(JSON.stringify({ type: 'text', part: { text: 'response' } }) + '\n'))
      mockStdout.emit('close')
    }, 10)

    const chunks: any[] = []
    const gen = processRegistry.send('ndjson-test', 'prompt', config)
    for await (const chunk of gen) {
      chunks.push(chunk)
    }

    // Should have text chunks (from readNdjsonRound, not readRound)
    const textChunks = chunks.filter(c => c.type === 'text')
    expect(textChunks.some((c: any) => c.content === 'response')).toBe(true)
    // Should have completed status
    expect(chunks.some((c: any) => c.type === 'status' && c.content === 'completed')).toBe(true)
  })

  it('SpawnConfig without new fields defaults to Claude path', async () => {
    // This is a regression test — existing Claude config should not be affected
    const config = {
      workDir: '/project',
      // No command, args, format, env — should default to Claude
    }

    // Make process die immediately (simulate no result event)
    setTimeout(() => {
      mockProcessObj.exitCode = 1
      mockStdout.emit('data', Buffer.from(JSON.stringify({ type: 'result', subtype: 'success' }) + '\n'))
    }, 10)

    const chunks: any[] = []
    try {
      const gen = processRegistry.send('claude-test', 'prompt', config)
      for await (const chunk of gen) {
        chunks.push(chunk)
      }
    } catch {
      // May throw due to mock — that's OK
    }

    // Should have spawned 'claude' (default command)
    expect(mockSpawn.mock.calls[0][0]).toBe('claude')
    // Should have Claude-specific args
    const args = mockSpawn.mock.calls[0][1]
    expect(args).toContain('-p')
    expect(args).toContain('--output-format')
    expect(args).toContain('stream-json')
  })
})
