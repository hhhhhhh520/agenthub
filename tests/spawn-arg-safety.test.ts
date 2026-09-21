import { describe, it, expect, vi } from 'vitest'
import { tmpdir } from 'os'
import { join } from 'path'
import { assertSpawnSafe } from '../src/lib/adapter/arg-safety'

describe('assertSpawnSafe — shell:true 注入面（fail-closed）', () => {
  it('放行正常参数（Claude 路径）', () => {
    expect(() =>
      assertSpawnSafe('claude', [
        '-p', '--output-format', 'stream-json', '--model', 'claude-sonnet-4-6',
        '--resume', '550e8400-e29b-41d4-a716-446655440000',
        '--permission-mode', 'default',
      ])
    ).not.toThrow()
  })

  it('放行正常参数（OpenCode 路径）', () => {
    expect(() =>
      assertSpawnSafe('opencode', ['run', '--format', 'json', '--agent', 'agenthub-abc123'])
    ).not.toThrow()
  })

  it('放行 Windows 反斜杠路径（不误伤，含中文）', () => {
    expect(() =>
      assertSpawnSafe('opencode', ['run', '--dir', 'D:\\ai全栈挑战赛\\agenthub'])
    ).not.toThrow()
  })

  it.each([
    ['命令分隔 &', ['x & echo PWNED']],
    ['管道 |', ['y | echo PIPE']],
    ['重定向 >', ['z > out.txt']],
    ['重定向 <', ['a < in.txt']],
    ['转义符 ^', ['a ^ b']],
    ['环境变量展开 %', ['--resume', '%PATH%']],
    ['延迟展开 !', ['a!b']],
    ['双引号', ['--model', 'a"b']],
    ['换行', ['a\nb']],
    ['空格（参数会被 cmd 截断）', ['--dir', 'D:\\my project']],
    ['制表符', ['a\tb']],
  ])('拒绝：%s', (_name, args) => {
    expect(() => assertSpawnSafe('claude', args)).toThrow()
  })

  it('拒绝含不安全字符的 command 本身', () => {
    expect(() => assertSpawnSafe('claude & echo x', [])).toThrow()
    expect(() => assertSpawnSafe('claude cmd', [])).toThrow()
  })

  it('错误信息含被拒参数的 JSON 转义形式（可排查且防日志注入）', () => {
    let msg = ''
    try {
      assertSpawnSafe('claude', ['--model', 'evil & calc\nnext'])
    } catch (e) {
      msg = (e as Error).message
    }
    expect(msg).toContain('evil')
    expect(msg).not.toContain('\n')  // 换行必须被转义，不得原样进日志
  })
})

// --- 接线测试：mock spawn，验证 process-registry 真的调用了守卫（防"删一行守卫全量仍绿"） ---
const { mockSpawn } = vi.hoisted(() => ({ mockSpawn: vi.fn() }))
vi.mock('child_process', () => ({ spawn: mockSpawn }))

import { processRegistry } from '../src/lib/adapter/process-registry'

describe('assertSpawnSafe — 接线（process-registry 必须调用守卫）', () => {
  it('getOrCreate 收到含元字符的参数时拦截，且 spawn 不被调用、不创建目录', () => {
    mockSpawn.mockClear()
    const workDir = join(tmpdir(), 'agenthub-guard-test')
    expect(() =>
      processRegistry.getOrCreate('guard-test-inject', {
        workDir,
        command: 'claude',
        model: 'evil & calc',
      })
    ).toThrow(/不安全字符/)
    expect(mockSpawn).not.toHaveBeenCalled()
  })

  it('正常参数照常 spawn（守卫不误伤接线）', () => {
    mockSpawn.mockClear()
    mockSpawn.mockReturnValue({
      stdin: null, stdout: null, stderr: null, pid: 12345,
      exitCode: null, killed: false, kill: () => true,
      on: () => {}, once: () => {}, removeListener: () => {},
    })
    expect(() =>
      processRegistry.getOrCreate('guard-test-normal', {
        workDir: join(tmpdir(), 'agenthub-guard-normal'),
        command: 'claude',
        model: 'claude-sonnet-4-6',
      })
    ).not.toThrow()
    expect(mockSpawn).toHaveBeenCalledTimes(1)
  })
})
