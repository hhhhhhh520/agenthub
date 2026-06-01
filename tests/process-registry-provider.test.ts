import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'events'
import type { ChildProcess } from 'child_process'

// Mock child_process.spawn to capture env and args
let capturedArgs: string[] = []
let capturedEnv: Record<string, string> = {}

function createMockProcess(): ChildProcess {
  const proc = new EventEmitter() as any
  proc.stdin = new EventEmitter() as any
  proc.stdin.write = vi.fn()
  proc.stdin.end = vi.fn()
  proc.stdout = new EventEmitter() as any
  proc.stderr = new EventEmitter() as any
  proc.pid = 12345
  proc.exitCode = null
  proc.killed = false
  proc.kill = vi.fn(() => { proc.exitCode = null; return true })
  return proc as ChildProcess
}

vi.mock('child_process', () => ({
  spawn: vi.fn((cmd: string, args: string[], options: any) => {
    capturedArgs = args
    capturedEnv = options?.env || {}
    return createMockProcess()
  }),
}))

// Must import after mocking
const { processRegistry } = await import('../src/lib/adapter/process-registry')

describe('ProcessRegistry provider env injection', () => {
  beforeEach(() => {
    capturedArgs = []
    capturedEnv = {}
    vi.clearAllMocks()
  })

  it('should inject ANTHROPIC_API_KEY and ANTHROPIC_BASE_URL when provider config is provided', () => {
    const key = `test-${Date.now()}-provider`
    processRegistry.getOrCreate(key, {
      workDir: '/tmp/test',
      apiKey: 'sk-test-key-123',
      baseUrl: 'https://api.example.com',
    })

    expect(capturedEnv.ANTHROPIC_API_KEY).toBe('sk-test-key-123')
    expect(capturedEnv.ANTHROPIC_BASE_URL).toBe('https://api.example.com')
  })

  it('should add --model CLI arg when model is provided', () => {
    const key = `test-${Date.now()}-model`
    processRegistry.getOrCreate(key, {
      workDir: '/tmp/test',
      model: 'claude-sonnet-4-20250514',
    })

    expect(capturedArgs).toContain('--model')
    const modelIndex = capturedArgs.indexOf('--model')
    expect(capturedArgs[modelIndex + 1]).toBe('claude-sonnet-4-20250514')
  })

  it('should NOT inject provider env when config has no apiKey or baseUrl (inherits from process.env)', () => {
    const key = `test-${Date.now()}-noprovider`
    processRegistry.getOrCreate(key, {
      workDir: '/tmp/test',
    })

    // Without provider config, env inherits from process.env (no agent-specific override)
    // The values may exist if the system has them set, but no NEW injection happens
    expect(capturedEnv.ANTHROPIC_API_KEY).toBe(process.env.ANTHROPIC_API_KEY || undefined)
    expect(capturedEnv.ANTHROPIC_BASE_URL).toBe(process.env.ANTHROPIC_BASE_URL || undefined)
  })

  it('should NOT add --model arg when model is not provided', () => {
    const key = `test-${Date.now()}-nomodel`
    processRegistry.getOrCreate(key, {
      workDir: '/tmp/test',
    })

    expect(capturedArgs).not.toContain('--model')
  })

  it('should inject all three: apiKey + baseUrl + model together', () => {
    const key = `test-${Date.now()}-all`
    processRegistry.getOrCreate(key, {
      workDir: '/tmp/test',
      apiKey: 'sk-full-test',
      baseUrl: 'https://proxy.example.com',
      model: 'deepseek-chat',
    })

    expect(capturedEnv.ANTHROPIC_API_KEY).toBe('sk-full-test')
    expect(capturedEnv.ANTHROPIC_BASE_URL).toBe('https://proxy.example.com')
    const modelIndex = capturedArgs.indexOf('--model')
    expect(capturedArgs[modelIndex + 1]).toBe('deepseek-chat')
  })

  it('should not overwrite existing process.env values when provider config is empty', () => {
    // Set a system-level env var
    const original = process.env.ANTHROPIC_API_KEY
    process.env.ANTHROPIC_API_KEY = 'system-key'

    const key = `test-${Date.now()}-inherit`
    processRegistry.getOrCreate(key, {
      workDir: '/tmp/test',
    })

    // Should inherit from process.env
    expect(capturedEnv.ANTHROPIC_API_KEY).toBe('system-key')

    // Restore
    if (original !== undefined) {
      process.env.ANTHROPIC_API_KEY = original
    } else {
      delete process.env.ANTHROPIC_API_KEY
    }
  })

  it('should override process.env when provider config is set', () => {
    const original = process.env.ANTHROPIC_API_KEY
    process.env.ANTHROPIC_API_KEY = 'system-key'

    const key = `test-${Date.now()}-override`
    processRegistry.getOrCreate(key, {
      workDir: '/tmp/test',
      apiKey: 'agent-specific-key',
    })

    // Agent-specific key should win
    expect(capturedEnv.ANTHROPIC_API_KEY).toBe('agent-specific-key')

    // Restore
    if (original !== undefined) {
      process.env.ANTHROPIC_API_KEY = original
    } else {
      delete process.env.ANTHROPIC_API_KEY
    }
  })
})
