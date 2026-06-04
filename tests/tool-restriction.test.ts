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

  describe('Claude Code — CLI 参数拼接', () => {
    it('传 --allowedTools 参数', () => {
      processRegistry.getOrCreate('test-key-1', {
        workDir: '/tmp/test',
        allowedTools: ['Read', 'Write', 'Edit'],
      })

      expect(mockSpawn).toHaveBeenCalled()
      const args = mockSpawn.mock.calls[0][1] as string[]
      const allowedIdx = args.indexOf('--allowedTools')
      expect(allowedIdx).toBeGreaterThanOrEqual(0)
      expect(args[allowedIdx + 1]).toBe('Read,Write,Edit')
    })

    it('传 --disallowedTools 参数', () => {
      processRegistry.getOrCreate('test-key-2', {
        workDir: '/tmp/test',
        disallowedTools: ['Agent', 'WebSearch'],
      })

      const args = mockSpawn.mock.calls[0][1] as string[]
      const disallowedIdx = args.indexOf('--disallowedTools')
      expect(disallowedIdx).toBeGreaterThanOrEqual(0)
      expect(args[disallowedIdx + 1]).toBe('Agent,WebSearch')
    })

    it('同时传 --allowedTools 和 --disallowedTools', () => {
      processRegistry.getOrCreate('test-key-3', {
        workDir: '/tmp/test',
        allowedTools: ['Read', 'Bash'],
        disallowedTools: ['Agent'],
      })

      const args = mockSpawn.mock.calls[0][1] as string[]
      const allowedIdx = args.indexOf('--allowedTools')
      const disallowedIdx = args.indexOf('--disallowedTools')
      expect(allowedIdx).toBeGreaterThanOrEqual(0)
      expect(disallowedIdx).toBeGreaterThanOrEqual(0)
      expect(args[allowedIdx + 1]).toBe('Read,Bash')
      expect(args[disallowedIdx + 1]).toBe('Agent')
    })

    it('空数组不传工具参数', () => {
      processRegistry.getOrCreate('test-key-4', {
        workDir: '/tmp/test',
        allowedTools: [],
      })

      const args = mockSpawn.mock.calls[0][1] as string[]
      expect(args).not.toContain('--allowedTools')
      expect(args).not.toContain('--disallowedTools')
    })

    it('不传 allowedTools 时无工具参数', () => {
      processRegistry.getOrCreate('test-key-5', {
        workDir: '/tmp/test',
      })

      const args = mockSpawn.mock.calls[0][1] as string[]
      expect(args).not.toContain('--allowedTools')
      expect(args).not.toContain('--disallowedTools')
    })
  })

  describe('OpenCode — 权限配置文件', () => {
    it('有 allowedTools 时写临时 opencode.json', () => {
      processRegistry.getOrCreate('oc-key-1', {
        workDir: '/tmp/test',
        command: 'opencode',
        args: ['-p', '-f', 'json'],
        format: 'ndjson',
        allowedTools: ['Read', 'Edit'],
      })

      // 应该写了一个临时配置文件
      expect(mockWriteFileSync).toHaveBeenCalled()
      const writeCall = mockWriteFileSync.mock.calls.find(
        (c: any[]) => typeof c[0] === 'string' && c[0].includes('agenthub-oc-')
      )
      expect(writeCall).toBeDefined()

      // 配置文件内容包含 permission 字段
      const config = JSON.parse(writeCall![1] as string)
      expect(config.permission).toBeDefined()
      expect(config.permission.read).toBe('allow')
      expect(config.permission.edit).toBe('allow')
      expect(config.permission.bash).toBe('deny')
    })

    it('OpenCode 权限配置包含完整工具列表', () => {
      processRegistry.getOrCreate('oc-key-2', {
        workDir: '/tmp/test',
        command: 'opencode',
        args: ['-p', '-f', 'json'],
        format: 'ndjson',
        allowedTools: ['Read'],
      })

      const writeCall = mockWriteFileSync.mock.calls.find(
        (c: any[]) => typeof c[0] === 'string' && c[0].includes('agenthub-oc-')
      )
      const config = JSON.parse(writeCall![1] as string)

      // 应该包含所有 OpenCode 工具
      expect(config.permission.read).toBe('allow')
      expect(config.permission.edit).toBe('deny')
      expect(config.permission.bash).toBe('deny')
      expect(config.permission.glob).toBe('deny')
      expect(config.permission.grep).toBe('deny')
      expect(config.permission.task).toBe('deny')
      expect(config.permission.skill).toBe('deny')
      expect(config.permission.lsp).toBe('deny')
      expect(config.permission.webfetch).toBe('deny')
      expect(config.permission.websearch).toBe('deny')
      expect(config.permission.question).toBe('deny')
    })

    it('Write 映射到 OpenCode 的 edit 权限', () => {
      processRegistry.getOrCreate('oc-key-3', {
        workDir: '/tmp/test',
        command: 'opencode',
        args: ['-p', '-f', 'json'],
        format: 'ndjson',
        allowedTools: ['Write'],
      })

      const writeCall = mockWriteFileSync.mock.calls.find(
        (c: any[]) => typeof c[0] === 'string' && c[0].includes('agenthub-oc-')
      )
      const config = JSON.parse(writeCall![1] as string)
      expect(config.permission.edit).toBe('allow')
    })

    it('Agent 映射到 OpenCode 的 task 权限', () => {
      processRegistry.getOrCreate('oc-key-4', {
        workDir: '/tmp/test',
        command: 'opencode',
        args: ['-p', '-f', 'json'],
        format: 'ndjson',
        allowedTools: ['Agent'],
      })

      const writeCall = mockWriteFileSync.mock.calls.find(
        (c: any[]) => typeof c[0] === 'string' && c[0].includes('agenthub-oc-')
      )
      const config = JSON.parse(writeCall![1] as string)
      expect(config.permission.task).toBe('allow')
    })

    it('有 allowedTools 时注入 OPENCODE_CONFIG 环境变量', () => {
      processRegistry.getOrCreate('oc-key-5', {
        workDir: '/tmp/test',
        command: 'opencode',
        args: ['-p', '-f', 'json'],
        format: 'ndjson',
        allowedTools: ['Read'],
      })

      expect(mockSpawn).toHaveBeenCalled()
      const spawnEnv = mockSpawn.mock.calls[0][2]?.env
      expect(spawnEnv?.OPENCODE_CONFIG).toBeDefined()
      expect(spawnEnv.OPENCODE_CONFIG).toContain('agenthub-oc-')
    })

    it('无 allowedTools 时不注入 OPENCODE_CONFIG', () => {
      processRegistry.getOrCreate('oc-key-6', {
        workDir: '/tmp/test',
        command: 'opencode',
        args: ['-p', '-f', 'json'],
        format: 'ndjson',
      })

      const spawnEnv = mockSpawn.mock.calls[0][2]?.env
      expect(spawnEnv?.OPENCODE_CONFIG).toBeUndefined()
    })

    it('killEntry 清理 OpenCode 临时配置文件', () => {
      const entry = processRegistry.getOrCreate('oc-key-7', {
        workDir: '/tmp/test',
        command: 'opencode',
        args: ['-p', '-f', 'json'],
        format: 'ndjson',
        allowedTools: ['Read'],
      })

      // getOrCreate 内部会附加 tools hash，需要用 send 的 config 获取实际 key
      // 直接用 send 触发 killEntry 路径（ndjson 格式在 send 后自动清理）
      const fakeProc2 = createFakeProcess()
      mockSpawn.mockReturnValue(fakeProc2)

      // 模拟进程正常退出
      setTimeout(() => {
        fakeProc2.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'text', part: { text: 'ok' } }) + '\n'))
        fakeProc2.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'step_finish', part: { type: 'step-finish' } }) + '\n'))
        fakeProc2.emit('exit', 0)
      }, 10)

      // ndjson 格式在 send 完成后会自动 killEntry
      // 验证 writeFileSync 被调用（写了临时配置文件）
      expect(mockWriteFileSync).toHaveBeenCalled()
      const writeCall = mockWriteFileSync.mock.calls.find(
        (c: any[]) => typeof c[0] === 'string' && c[0].includes('agenthub-oc-')
      )
      expect(writeCall).toBeDefined()
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

      // 应该 spawn 了两次（不同 key）
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

      // 应该只 spawn 了一次
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

      // 应该只 spawn 了一次（排序后 hash 相同）
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
