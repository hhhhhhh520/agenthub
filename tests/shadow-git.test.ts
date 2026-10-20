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
  getChangedFilesDetailed,
  getGitSnapshot,
  getGitSnapshotDetailed,
  cleanupShadowGit,
} from '@/lib/services/shadow-git'

beforeEach(() => {
  vi.clearAllMocks()
  // 默认:影子 git 已存在,跳过 init；第三次 ignore 列表查询返回空
  mockExistsSync.mockReturnValue(true)
  mockExecFileSync.mockReturnValue('')
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

  it('git 命令失败时抛错，不再伪装成空快照', () => {
    mockExecFileSync.mockImplementation(() => { throw new Error('git command failed') })
    expect(() => getGitSnapshot('/project', 'sess-1')).toThrow(/影子 git 不可用.*git command failed/)
  })

  it('detailed: 成功返回 ok + 文件集合 + 内容证据', () => {
    mockExecFileSync.mockReturnValueOnce('src/a.ts\n')
    mockExecFileSync.mockReturnValueOnce('src/b.ts\n')
    const result = getGitSnapshotDetailed('/project', 'sess-1')
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(result.reason)
    expect(result.files).toEqual(new Set(['src/a.ts', 'src/b.ts']))
    // 测试目录不存在：证据存在但内容指纹为 null
    expect(result.evidence).toEqual(new Map([
      ['src/a.ts', null],
      ['src/b.ts', null],
    ]))
  })

  it('detailed: 失败返回 ok:false + reason（审计三态可区分空集合）', () => {
    mockExecFileSync.mockImplementation(() => { throw new Error('git timed out') })
    const result = getGitSnapshotDetailed('/project', 'sess-1')
    expect(result).toEqual({ ok: false, reason: 'git timed out' })
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

  it('git 失败时抛错，不再伪装成空 diff', () => {
    mockExecFileSync.mockImplementation(() => { throw new Error('git failed') })
    expect(() => getChangedFiles('/project', 'sess-1', new Set())).toThrow(/影子 git 不可用.*git failed/)
  })

  it('detailed: 成功返回 ok + 新增文件', () => {
    mockExecFileSync.mockReturnValueOnce('src/a.ts\nsrc/b.ts\n')
    mockExecFileSync.mockReturnValueOnce('src/new.ts\n')
    const result = getChangedFilesDetailed('/project', 'sess-1', new Set(['src/a.ts']))
    expect(result).toEqual({ ok: true, files: expect.arrayContaining(['src/b.ts', 'src/new.ts']) })
  })

  it('detailed: 失败返回 ok:false + reason', () => {
    mockExecFileSync.mockImplementation(() => { throw new Error('git failed') })
    const result = getChangedFilesDetailed('/project', 'sess-1', new Set())
    expect(result).toEqual({ ok: false, reason: 'git failed' })
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
