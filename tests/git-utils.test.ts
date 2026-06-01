import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockExecSync } = vi.hoisted(() => ({
  mockExecSync: vi.fn(),
}))

vi.mock('child_process', () => ({
  execSync: mockExecSync,
}))

import { getChangedFiles, getGitSnapshot } from '@/lib/services/git-utils'

beforeEach(() => {
  vi.clearAllMocks()
})

describe('getChangedFiles', () => {
  it('returns files changed since snapshot (diff + untracked - before)', () => {
    // First call: git diff --name-only HEAD
    mockExecSync.mockReturnValueOnce('src/a.ts\nsrc/b.ts\n')
    // Second call: git ls-files --others --exclude-standard
    mockExecSync.mockReturnValueOnce('src/new.ts\n')
    const before = new Set(['src/a.ts'])
    const result = getChangedFiles('/project', before)
    expect(result).toContain('src/b.ts')
    expect(result).toContain('src/new.ts')
    expect(result).not.toContain('src/a.ts') // was in before set
  })

  it('returns empty array when git commands fail', () => {
    mockExecSync.mockImplementation(() => { throw new Error('not a git repo') })
    const result = getChangedFiles('/project', new Set())
    expect(result).toEqual([])
  })

  it('filters out empty lines from git output', () => {
    mockExecSync.mockReturnValueOnce('\n\n')
    mockExecSync.mockReturnValueOnce('\n\n')
    const result = getChangedFiles('/project', new Set())
    expect(result).toEqual([])
  })
})

describe('getGitSnapshot', () => {
  it('returns set of tracked + untracked files', () => {
    mockExecSync.mockReturnValueOnce('src/a.ts\nsrc/b.ts\n')
    mockExecSync.mockReturnValueOnce('src/c.ts\n')
    const result = getGitSnapshot('/project')
    expect(result).toEqual(new Set(['src/a.ts', 'src/b.ts', 'src/c.ts']))
  })

  it('returns empty set when git commands fail', () => {
    mockExecSync.mockImplementation(() => { throw new Error('not a git repo') })
    const result = getGitSnapshot('/project')
    expect(result).toEqual(new Set())
  })

  it('deduplicates files across diff and untracked', () => {
    mockExecSync.mockReturnValueOnce('src/a.ts\n')
    mockExecSync.mockReturnValueOnce('src/a.ts\n')
    const result = getGitSnapshot('/project')
    expect(result.size).toBe(1)
    expect(result.has('src/a.ts')).toBe(true)
  })
})
