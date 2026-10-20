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

// Import after mocks
const { processRegistry } = await import('@/lib/adapter/process-registry')

describe('Tool Restriction', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    fakeProc = createFakeProcess()
    mockSpawn.mockReturnValue(fakeProc)
    mockExistsSync.mockReturnValue(true)
  })

  afterEach(() => {
    processRegistry.killAll()
  })

  describe('Claude Code — 可用性 vs 审批', () => {
    it('agent.tools 走 --tools（可用性），不再使用受 --bare 限制的 3 工具集', () => {
      processRegistry.getOrCreate('claude-tools', {
        workDir: '/tmp/test',
        allowedTools: ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep'],
      })

      const args = mockSpawn.mock.calls[0][1] as string[]
      const toolsIdx = args.indexOf('--tools')
      expect(toolsIdx).toBeGreaterThanOrEqual(0)
      expect(args[toolsIdx + 1]).toBe('Read,Write,Edit,Bash,Glob,Grep')
      expect(args).not.toContain('--bare')
      expect(args[args.indexOf('--setting-sources') + 1]).toBe('user')
      // default 模式不预批准，必须走 control_request
      expect(args).not.toContain('--allowedTools')
      expect(args[args.indexOf('--permission-mode') + 1]).toBe('default')
    })

    it('auto 模式把可用工具加入 --allowedTools（减少往返），CLI 仍用 default 拿 control_request', () => {
      processRegistry.getOrCreate('claude-auto', {
        workDir: '/tmp/test',
        permissionMode: 'auto',
        allowedTools: ['Read', 'Edit'],
      })

      const args = mockSpawn.mock.calls[0][1] as string[]
      expect(args[args.indexOf('--allowedTools') + 1]).toBe('Read,Edit')
      expect(args[args.indexOf('--permission-mode') + 1]).toBe('default')
    })

    it('空 tools → --tools default（不限制内置工具），不是无参数', () => {
      processRegistry.getOrCreate('claude-empty', {
        workDir: '/tmp/test',
        allowedTools: [],
      })

      const args = mockSpawn.mock.calls[0][1] as string[]
      expect(args[args.indexOf('--tools') + 1]).toBe('default')
      expect(args).not.toContain('--allowedTools')
    })

    it('显式 disallowedTools 仍透传', () => {
      processRegistry.getOrCreate('claude-disallowed', {
        workDir: '/tmp/test',
        allowedTools: ['Read'],
        disallowedTools: ['Agent', 'WebSearch'],
      })

      const args = mockSpawn.mock.calls[0][1] as string[]
      expect(args[args.indexOf('--disallowedTools') + 1]).toBe('Agent,WebSearch')
    })

    it('settingsPath 走 --settings（受管 provider 配置）', () => {
      processRegistry.getOrCreate('claude-settings', {
        workDir: '/tmp/test',
        settingsPath: 'C:/safe/settings.json',
      })

      const args = mockSpawn.mock.calls[0][1] as string[]
      expect(args[args.indexOf('--settings') + 1]).toBe('C:/safe/settings.json')
    })
  })

  describe('OpenCode — 权限不再走临时配置/env', () => {
    it('不写 agenthub-oc-* 临时权限文件，也不注入 OPENCODE_CONFIG', () => {
      processRegistry.getOrCreate('oc-key-1', {
        workDir: '/tmp/test',
        command: 'opencode',
        args: ['run', '--format', 'json'],
        format: 'ndjson',
        allowedTools: ['Read', 'Edit'],
      })

      expect(mockWriteFileSync.mock.calls.some(
        (c: any[]) => typeof c[0] === 'string' && String(c[0]).includes('agenthub-oc-')
      )).toBe(false)
      const spawnEnv = mockSpawn.mock.calls[0][2]?.env
      expect(spawnEnv?.OPENCODE_CONFIG).toBeUndefined()
      expect(spawnEnv?.OPENCODE_PERMISSION).toBeUndefined()
    })
  })

  describe('进程 key 隔离', () => {
    it('不同 tools 配置生成不同 key，进程不复用', () => {
      processRegistry.getOrCreate('same-base-key', {
        workDir: '/tmp/test',
        allowedTools: ['Read', 'Write'],
      })

      processRegistry.getOrCreate('same-base-key', {
        workDir: '/tmp/test',
        allowedTools: ['Read', 'Bash'],
      })

      expect(mockSpawn).toHaveBeenCalledTimes(2)
    })

    it('相同 tools 配置复用进程', () => {
      const entry1 = processRegistry.getOrCreate('reuse-key', {
        workDir: '/tmp/test',
        allowedTools: ['Read', 'Write'],
      })

      const entry2 = processRegistry.getOrCreate('reuse-key', {
        workDir: '/tmp/test',
        allowedTools: ['Read', 'Write'],
      })

      expect(mockSpawn).toHaveBeenCalledTimes(1)
      expect(entry1).toBe(entry2)
    })

    it('相同 tools 不同顺序生成相同 key', () => {
      processRegistry.getOrCreate('order-key', {
        workDir: '/tmp/test',
        allowedTools: ['Read', 'Write'],
      })

      processRegistry.getOrCreate('order-key', {
        workDir: '/tmp/test',
        allowedTools: ['Write', 'Read'],
      })

      expect(mockSpawn).toHaveBeenCalledTimes(1)
    })

    it('无 tools 和有 tools 生成不同 key', () => {
      processRegistry.getOrCreate('no-tools-key', {
        workDir: '/tmp/test',
      })

      processRegistry.getOrCreate('no-tools-key', {
        workDir: '/tmp/test',
        allowedTools: ['Read'],
      })

      expect(mockSpawn).toHaveBeenCalledTimes(2)
    })
  })
})
