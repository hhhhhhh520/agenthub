import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockExecFileSync, mockExistsSync, mockMkdirSync, mockWriteFileSync, mockRmSync } = vi.hoisted(() => ({
  mockExecFileSync: vi.fn(),
  mockExistsSync: vi.fn(),
  mockMkdirSync: vi.fn(),
  mockWriteFileSync: vi.fn(),
  mockRmSync: vi.fn(),
}))

vi.mock('child_process', () => ({
  execFileSync: mockExecFileSync,
}))

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs')
  return {
    ...actual,
    existsSync: mockExistsSync,
    mkdirSync: mockMkdirSync,
    writeFileSync: mockWriteFileSync,
    rmSync: mockRmSync,
  }
})

import {
  getChangedFiles,
  getGitSnapshot,
  cleanupShadowGit,
} from '@/lib/services/shadow-git'

beforeEach(() => {
  vi.clearAllMocks()
  // 默认:影子 git 已存在,跳过 init
  mockExistsSync.mockReturnValue(true)
})

describe('getGitSnapshot', () => {
  it('返回 modified + untracked 的合集', () => {
    mockExecFileSync.mockReturnValueOnce('src/a.ts\nsrc/b.ts\n') // diff
    mockExecFileSync.mockReturnValueOnce('src/c.ts\n')             // ls-files
    const result = getGitSnapshot('/project', 'sess-1')
    expect(result).toEqual(new Set(['src/a.ts', 'src/b.ts', 'src/c.ts']))
  })

  it('去重 modified 和 untracked 中的重复文件', () => {
    mockExecFileSync.mockReturnValueOnce('src/a.ts\n')
    mockExecFileSync.mockReturnValueOnce('src/a.ts\n')
    const result = getGitSnapshot('/project', 'sess-1')
    expect(result.size).toBe(1)
    expect(result.has('src/a.ts')).toBe(true)
  })

  it('过滤掉空行', () => {
    mockExecFileSync.mockReturnValueOnce('\n\n')
    mockExecFileSync.mockReturnValueOnce('\n\n')
    const result = getGitSnapshot('/project', 'sess-1')
    expect(result).toEqual(new Set())
  })

  it('git 命令失败时返回空 Set(降级)', () => {
    mockExecFileSync.mockImplementation(() => { throw new Error('git command failed') })
    const result = getGitSnapshot('/project', 'sess-1')
    expect(result).toEqual(new Set())
  })

  it('未初始化时自动调用 git init --bare + add -A + commit', () => {
    // 第一次调用时影子目录不存在
    mockExistsSync.mockReturnValue(false)
    mockExecFileSync.mockReturnValue('')

    getGitSnapshot('/project', 'sess-new')

    // execFileSync('git', argsArray, opts) → 拼接 argsArray 检查命令语义
    const allCalls = mockExecFileSync.mock.calls.map(c => (c[1] as string[]).join(' ')).join('\n')
    expect(allCalls).toMatch(/init --bare/)
    expect(allCalls).toMatch(/add -A/)
    expect(allCalls).toMatch(/commit/)
    expect(mockMkdirSync).toHaveBeenCalled()
  })

  it('影子 git 命令使用 --git-dir 和 --work-tree 不污染 workDir 自身', () => {
    mockExecFileSync.mockReturnValue('')
    getGitSnapshot('/some/work/dir', 'sess-1')
    const calls = mockExecFileSync.mock.calls.map(c => c[1] as string[])
    // 至少有一条命令带 --git-dir 和 --work-tree
    const hasShadowFlags = calls.some(args =>
      args.includes('--git-dir') && args.includes('--work-tree')
    )
    expect(hasShadowFlags).toBe(true)
  })
})

describe('getChangedFiles', () => {
  it('返回自 before 以来新增的脏文件', () => {
    mockExecFileSync.mockReturnValueOnce('src/a.ts\nsrc/b.ts\n')
    mockExecFileSync.mockReturnValueOnce('src/new.ts\n')
    const before = new Set(['src/a.ts'])
    const result = getChangedFiles('/project', 'sess-1', before)
    expect(result).toContain('src/b.ts')
    expect(result).toContain('src/new.ts')
    expect(result).not.toContain('src/a.ts')
  })

  it('git 失败时返回空数组(降级)', () => {
    mockExecFileSync.mockImplementation(() => { throw new Error('git failed') })
    const result = getChangedFiles('/project', 'sess-1', new Set())
    expect(result).toEqual([])
  })

  it('过滤空行', () => {
    mockExecFileSync.mockReturnValueOnce('\n\n')
    mockExecFileSync.mockReturnValueOnce('\n\n')
    const result = getChangedFiles('/project', 'sess-1', new Set())
    expect(result).toEqual([])
  })
})

describe('cleanupShadowGit', () => {
  it('影子目录存在时调用 rmSync 清理', () => {
    mockExistsSync.mockReturnValue(true)
    cleanupShadowGit('/project', 'sess-1')
    expect(mockRmSync).toHaveBeenCalledWith(
      expect.stringContaining('sess-1'),
      expect.objectContaining({ recursive: true, force: true }),
    )
  })

  it('影子目录不存在时不抛错', () => {
    mockExistsSync.mockReturnValue(false)
    expect(() => cleanupShadowGit('/project', 'sess-1')).not.toThrow()
    expect(mockRmSync).not.toHaveBeenCalled()
  })
})
