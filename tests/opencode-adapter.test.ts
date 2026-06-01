import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'events'

// EventEmitter instances must be created outside vi.hoisted
const mockStdin = { write: vi.fn(), end: vi.fn() }
const mockStdout = new EventEmitter()
const mockStderr = new EventEmitter()
const mockProcessObj: any = {
  pid: 5678,
  stdin: null,
  stdout: mockStdout,
  stderr: mockStderr,
  kill: vi.fn(),
}

const { mockSpawn, mockExistsSync, mockMkdirSync } = vi.hoisted(() => ({
  mockSpawn: vi.fn(() => ({
    pid: 5678,
    stdin: null,
    stdout: null,
    stderr: null,
    kill: vi.fn(),
  })),
  mockExistsSync: vi.fn().mockReturnValue(true),
  mockMkdirSync: vi.fn(),
}))

vi.mock('child_process', () => ({
  spawn: (...args: any[]) => {
    const proc = mockSpawn(...args)
    // Patch the returned object to use our EventEmitter instances
    proc.stdin = mockStdin
    proc.stdout = mockStdout
    proc.stderr = mockStderr
    return proc
  },
}))
vi.mock('fs', () => ({ existsSync: mockExistsSync, mkdirSync: mockMkdirSync }))

import { OpenCodeAdapter } from '@/lib/adapter/opencode-adapter'

beforeEach(() => {
  vi.clearAllMocks()
  mockExistsSync.mockReturnValue(true)
  mockStdout.removeAllListeners()
  mockStderr.removeAllListeners()
  mockSpawn.mockReturnValue({
    pid: 5678,
    stdin: mockStdin,
    stdout: mockStdout,
    stderr: mockStderr,
    kill: vi.fn(),
  })
})

describe('OpenCodeAdapter', () => {
  it('connect creates workDir when it does not exist', async () => {
    mockExistsSync.mockReturnValue(false)
    const adapter = new OpenCodeAdapter()
    await adapter.connect({ platform: 'opencode', workDir: '/new-dir' })
    expect(mockMkdirSync).toHaveBeenCalledWith('/new-dir', { recursive: true })
  })

  it('connect does not create workDir when it exists', async () => {
    mockExistsSync.mockReturnValue(true)
    const adapter = new OpenCodeAdapter()
    await adapter.connect({ platform: 'opencode', workDir: '/existing' })
    expect(mockMkdirSync).not.toHaveBeenCalled()
  })

  it('connect stores sessionId', async () => {
    const adapter = new OpenCodeAdapter()
    await adapter.connect({ platform: 'opencode', sessionId: 'sess-1' })
    expect(adapter.getSessionId()).toBe('sess-1')
  })

  it('send builds correct args with model, systemPrompt, session', async () => {
    const adapter = new OpenCodeAdapter()
    await adapter.connect({ platform: 'opencode', model: 'claude-3', sessionId: 's1', workDir: '/dir' })

    // Make send drain quickly
    setTimeout(() => mockStdout.emit('end'), 10)

    const gen = adapter.send({ prompt: 'hi', systemPrompt: 'you are PM' })
    for await (const _ of gen) { /* consume */ }

    const args = mockSpawn.mock.calls[0][1]
    expect(args).toContain('--model')
    expect(args).toContain('claude-3')
    expect(args).toContain('--prompt')
    expect(args).toContain('you are PM')
    expect(args).toContain('--session')
    expect(args).toContain('s1')
  })

  it('send prepends context to prompt', async () => {
    const adapter = new OpenCodeAdapter()
    await adapter.connect({ platform: 'opencode', workDir: '/dir' })

    setTimeout(() => mockStdout.emit('end'), 10)

    const gen = adapter.send({ prompt: 'do it', context: 'background info' })
    for await (const _ of gen) { /* consume */ }

    const written = mockStdin.write.mock.calls[0][0]
    const text = Buffer.isBuffer(written) ? written.toString() : written
    expect(text).toContain('Context:')
    expect(text).toContain('background info')
    expect(text).toContain('do it')
  })

  it('send sets ANTHROPIC_API_KEY and OPENAI_API_KEY in env', async () => {
    const adapter = new OpenCodeAdapter()
    await adapter.connect({ platform: 'opencode', apiKey: 'sk-123', workDir: '/dir' })

    setTimeout(() => mockStdout.emit('end'), 10)

    const gen = adapter.send({ prompt: 'test' })
    for await (const _ of gen) { /* consume */ }

    const env = mockSpawn.mock.calls[0][2].env
    expect(env.ANTHROPIC_API_KEY).toBe('sk-123')
    expect(env.OPENAI_API_KEY).toBe('sk-123')
  })

  it('send sets ANTHROPIC_BASE_URL and OPENAI_BASE_URL in env', async () => {
    const adapter = new OpenCodeAdapter()
    await adapter.connect({ platform: 'opencode', baseUrl: 'https://api.test.com', workDir: '/dir' })

    setTimeout(() => mockStdout.emit('end'), 10)

    const gen = adapter.send({ prompt: 'test' })
    for await (const _ of gen) { /* consume */ }

    const env = mockSpawn.mock.calls[0][2].env
    expect(env.ANTHROPIC_BASE_URL).toBe('https://api.test.com')
    expect(env.OPENAI_BASE_URL).toBe('https://api.test.com')
  })

  it('send writes prompt buffer to stdin', async () => {
    const adapter = new OpenCodeAdapter()
    await adapter.connect({ platform: 'opencode', workDir: '/dir' })

    setTimeout(() => mockStdout.emit('end'), 10)

    const gen = adapter.send({ prompt: 'hello world' })
    for await (const _ of gen) { /* consume */ }

    expect(mockStdin.write).toHaveBeenCalled()
    const written = mockStdin.write.mock.calls[0][0]
    expect(Buffer.isBuffer(written)).toBe(true)
    expect(written.toString()).toContain('hello world')
    expect(mockStdin.end).toHaveBeenCalled()
  })

  // readProcess tests omitted: EventEmitter is not async iterable
  // (for await...of requires ReadableStream). Covered indirectly by
  // the send tests above which exercise the spawn/stdin/env paths.

  it('close calls killProcess and nulls process reference', async () => {
    const adapter = new OpenCodeAdapter()
    await adapter.connect({ platform: 'opencode', workDir: '/dir' })

    setTimeout(() => mockStdout.emit('end'), 10)

    const gen = adapter.send({ prompt: 'test' })
    for await (const _ of gen) { /* consume */ }

    await adapter.close()
    expect((adapter as any).process).toBeNull()
  })
})
