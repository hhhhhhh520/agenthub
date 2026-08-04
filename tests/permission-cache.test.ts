/**
 * ISSUE-006 针对性测试：权限缓存机制（permissionCache）
 *
 * 背景：permissionMode='default' 时，CLI 每次 can_use_tool 请求都推给前端等用户批准，
 * 导致依赖安装等重复操作需要反复审批。修复：同会话内已批准/拒绝的操作自动放行/拒绝。
 *
 * 覆盖：
 * 1. respondPermission 写入 allow 缓存
 * 2. respondPermission 写入 deny 缓存
 * 3. 缓存上限 100 条，超出淘汰最早条目
 * 4. 缓存命中（allow）：相同 tool+input 第二次请求自动批准，不再推 permission_request
 * 5. 缓存命中（deny）：相同 tool+input 第二次请求自动拒绝
 * 6. 缓存不跨 input 命中：input 不同必须重新审批（安全属性）
 */
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
const mockSpawn = vi.fn((..._args: any[]) => fakeProc)

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
  try { processRegistry.killAll() } catch {}
})

function writeControlRequest(requestId: string, toolName: string, input: Record<string, unknown>) {
  fakeProc.stdout.write(Buffer.from(JSON.stringify({
    type: 'control_request',
    request_id: requestId,
    request: { subtype: 'can_use_tool', tool_name: toolName, input },
  }) + '\n'))
}

function writeResult() {
  fakeProc.stdout.write(Buffer.from(JSON.stringify({ type: 'result', subtype: 'success' }) + '\n'))
}

function spyOnStdinWrites(): string[] {
  const writes: string[] = []
  const originalWrite = fakeProc.stdin.write.bind(fakeProc.stdin)
  vi.spyOn(fakeProc.stdin, 'write').mockImplementation((chunk: any, ...args: any[]) => {
    writes.push(Buffer.isBuffer(chunk) ? chunk.toString('utf-8') : String(chunk))
    return originalWrite(chunk, ...args)
  })
  return writes
}

describe('ISSUE-006: permissionCache', () => {
  describe('respondPermission 写入缓存', () => {
    it('allow 响应缓存为 true，key 为 toolName:JSON(input)', () => {
      const key = 'cache-allow-write'
      processRegistry.getOrCreate(key, { workDir: '/dir' })
      const entry = (globalThis as any).__processRegistry.get(key)
      entry.pendingPermissions.set('req-1', {
        requestId: 'req-1',
        toolName: 'Write',
        toolInput: { file_path: '/tmp/test.txt' },
        resolve: () => {},
      })

      const result = processRegistry.respondPermission(key, 'req-1', { behavior: 'allow' })
      expect(result).toBe(true)
      expect(entry.permissionCache).toBeDefined()
      expect(entry.permissionCache.get('Write:{"file_path":"/tmp/test.txt"}')).toBe(true)
    })

    it('deny 响应缓存为 false', () => {
      const key = 'cache-deny-write'
      processRegistry.getOrCreate(key, { workDir: '/dir' })
      const entry = (globalThis as any).__processRegistry.get(key)
      entry.pendingPermissions.set('req-2', {
        requestId: 'req-2',
        toolName: 'Bash',
        toolInput: { command: 'rm -rf /' },
        resolve: () => {},
      })

      processRegistry.respondPermission(key, 'req-2', { behavior: 'deny', message: 'Too dangerous' })
      expect(entry.permissionCache.get('Bash:{"command":"rm -rf /"}')).toBe(false)
    })

    it('用户修改 input 后批准（updatedInput 不同）→ 不写缓存，防审批反转', () => {
      const key = 'cache-modified-input'
      processRegistry.getOrCreate(key, { workDir: '/dir' })
      const entry = (globalThis as any).__processRegistry.get(key)
      entry.pendingPermissions.set('req-m', {
        requestId: 'req-m',
        toolName: 'Bash',
        toolInput: { command: 'rm -rf /' },
        resolve: () => {},
      })

      // 用户把危险命令改成安全命令后批准：一次性决策，原始命令不能被缓存放行
      processRegistry.respondPermission(key, 'req-m', {
        behavior: 'allow',
        updatedInput: { command: 'ls -la' },
      })

      expect(entry.permissionCache?.has('Bash:{"command":"rm -rf /"}')).toBeFalsy()
    })

    it('updatedInput 与原始 input 相同 → 正常写缓存', () => {
      const key = 'cache-same-input'
      processRegistry.getOrCreate(key, { workDir: '/dir' })
      const entry = (globalThis as any).__processRegistry.get(key)
      entry.pendingPermissions.set('req-s', {
        requestId: 'req-s',
        toolName: 'Bash',
        toolInput: { command: 'ls' },
        resolve: () => {},
      })

      processRegistry.respondPermission(key, 'req-s', {
        behavior: 'allow',
        updatedInput: { command: 'ls' },
      })

      expect(entry.permissionCache.get('Bash:{"command":"ls"}')).toBe(true)
    })

    it('缓存达到 100 条上限时淘汰最早条目', () => {
      const key = 'cache-evict'
      processRegistry.getOrCreate(key, { workDir: '/dir' })
      const entry = (globalThis as any).__processRegistry.get(key)
      entry.permissionCache = new Map<string, boolean>()
      for (let i = 0; i < 100; i++) {
        entry.permissionCache.set(`Tool${i}:${i}`, true)
      }
      entry.pendingPermissions.set('req-3', {
        requestId: 'req-3',
        toolName: 'Bash',
        toolInput: { command: 'ls' },
        resolve: () => {},
      })

      processRegistry.respondPermission(key, 'req-3', { behavior: 'allow' })

      expect(entry.permissionCache.size).toBe(100)
      expect(entry.permissionCache.has('Tool0:0')).toBe(false) // 最早的被淘汰
      expect(entry.permissionCache.has('Tool99:99')).toBe(true)
      expect(entry.permissionCache.get('Bash:{"command":"ls"}')).toBe(true)
    })
  })

  describe('readRound 缓存命中（端到端）', () => {
    it('相同 tool+input 第二次请求自动批准，不再推 permission_request', async () => {
      const writes = spyOnStdinWrites()
      const key = 'cache-hit-allow'
      processRegistry.getOrCreate(key, { workDir: '/dir', permissionMode: 'default' })

      const gen = processRegistry.send(key, 'install deps', { workDir: '/dir', permissionMode: 'default' })[Symbol.asyncIterator]()
      const input = { command: 'pip install pygame' }

      // 第一次请求：走正常审批流程
      setTimeout(() => writeControlRequest('req-1', 'Bash', input), 10)
      const first = await gen.next()
      expect(first.value.type).toBe('permission_request')
      expect(first.value.data.requestId).toBe('req-1')

      // 走生产真实路径：permission route 无法构造 effectiveKey（含 configHash），
      // 前端批准经 respondPermissionByRequestId 反查路由
      expect(processRegistry.respondPermissionByRequestId('req-1', { behavior: 'allow' })).toBe(true)

      // 第二次相同请求：必须被缓存自动批准
      writeControlRequest('req-2', 'Bash', input)
      writeResult()

      const rest: any[] = []
      while (true) {
        const r = await gen.next()
        if (r.done) break
        rest.push(r.value)
      }

      // 全程只产生 1 个 permission_request（req-1 的），req-2 没有再打扰用户
      expect(rest.filter((c: any) => c.type === 'permission_request')).toHaveLength(0)

      // stdin 收到 req-2 的自动批准响应
      const autoResp = writes.filter(w => w.includes('control_response') && w.includes('req-2'))
      expect(autoResp).toHaveLength(1)
      const parsed = JSON.parse(autoResp[0])
      expect(parsed.response.response.behavior).toBe('allow')
      expect(parsed.response.response.updatedInput).toEqual(input)
    })

    it('相同 tool+input 第二次请求自动拒绝（deny 也缓存）', async () => {
      const writes = spyOnStdinWrites()
      const key = 'cache-hit-deny'
      processRegistry.getOrCreate(key, { workDir: '/dir', permissionMode: 'default' })

      const gen = processRegistry.send(key, 'do risky thing', { workDir: '/dir', permissionMode: 'default' })[Symbol.asyncIterator]()
      const input = { command: 'rm -rf /' }

      setTimeout(() => writeControlRequest('req-1', 'Bash', input), 10)
      const first = await gen.next()
      expect(first.value.type).toBe('permission_request')

      expect(processRegistry.respondPermissionByRequestId('req-1', { behavior: 'deny', message: 'User denied this tool use.' })).toBe(true)

      writeControlRequest('req-2', 'Bash', input)
      writeResult()

      const rest: any[] = []
      while (true) {
        const r = await gen.next()
        if (r.done) break
        rest.push(r.value)
      }

      expect(rest.filter((c: any) => c.type === 'permission_request')).toHaveLength(0)

      const autoResp = writes.filter(w => w.includes('control_response') && w.includes('req-2'))
      expect(autoResp).toHaveLength(1)
      const parsed = JSON.parse(autoResp[0])
      expect(parsed.response.response.behavior).toBe('deny')
      expect(parsed.response.response.message).toBe('Previously denied by user.')
    })

    it('input 不同时缓存不命中，必须重新审批', async () => {
      spyOnStdinWrites()
      const key = 'cache-miss-diff-input'
      processRegistry.getOrCreate(key, { workDir: '/dir', permissionMode: 'default' })

      const gen = processRegistry.send(key, 'run commands', { workDir: '/dir', permissionMode: 'default' })[Symbol.asyncIterator]()

      // 批准第一条命令
      setTimeout(() => writeControlRequest('req-1', 'Bash', { command: 'pip install pygame' }), 10)
      const first = await gen.next()
      expect(first.value.type).toBe('permission_request')
      expect(processRegistry.respondPermissionByRequestId('req-1', { behavior: 'allow' })).toBe(true)

      // 不同命令：不能走缓存，必须再次推 permission_request
      writeControlRequest('req-2', 'Bash', { command: 'pip install requests' })
      const second = await gen.next()
      expect(second.value.type).toBe('permission_request')
      expect(second.value.data.requestId).toBe('req-2')

      // 清理：批准后结束
      expect(processRegistry.respondPermissionByRequestId('req-2', { behavior: 'allow' })).toBe(true)
      writeResult()
      while (!(await gen.next()).done) { /* drain */ }
    })
  })
})
