import { describe, it, expect } from 'vitest'
import { diffFileLists } from '../src/lib/workspace'

describe('workspace — diffFileLists', () => {
  it('detects added files', () => {
    const before = ['a.ts', 'b.ts']
    const after = ['a.ts', 'b.ts', 'c.ts']
    const diff = diffFileLists(before, after)
    expect(diff.added).toEqual(['c.ts'])
    expect(diff.removed).toEqual([])
  })

  it('detects removed files', () => {
    const before = ['a.ts', 'b.ts', 'c.ts']
    const after = ['a.ts']
    const diff = diffFileLists(before, after)
    expect(diff.removed).toEqual(['b.ts', 'c.ts'])
    expect(diff.added).toEqual([])
  })

  it('detects both added and removed', () => {
    const before = ['a.ts', 'b.ts']
    const after = ['b.ts', 'c.ts']
    const diff = diffFileLists(before, after)
    expect(diff.added).toEqual(['c.ts'])
    expect(diff.removed).toEqual(['a.ts'])
  })

  it('returns empty diff for identical lists', () => {
    const before = ['a.ts', 'b.ts']
    const after = ['a.ts', 'b.ts']
    const diff = diffFileLists(before, after)
    expect(diff.added).toEqual([])
    expect(diff.removed).toEqual([])
    expect(diff.modified).toEqual([])
  })

  it('handles empty before list (all added)', () => {
    const before: string[] = []
    const after = ['a.ts', 'b.ts']
    const diff = diffFileLists(before, after)
    expect(diff.added).toEqual(['a.ts', 'b.ts'])
    expect(diff.removed).toEqual([])
  })

  it('handles empty after list (all removed)', () => {
    const before = ['a.ts', 'b.ts']
    const after: string[] = []
    const diff = diffFileLists(before, after)
    expect(diff.added).toEqual([])
    expect(diff.removed).toEqual(['a.ts', 'b.ts'])
  })

  it('handles both empty lists', () => {
    const diff = diffFileLists([], [])
    expect(diff.added).toEqual([])
    expect(diff.removed).toEqual([])
    expect(diff.modified).toEqual([])
  })

  it('handles duplicate entries in lists', () => {
    const before = ['a.ts', 'a.ts', 'b.ts']
    const after = ['a.ts', 'c.ts']
    const diff = diffFileLists(before, after)
    // 'a.ts' is in both sets, so not added or removed
    // 'b.ts' is removed, 'c.ts' is added
    expect(diff.added).toEqual(['c.ts'])
    expect(diff.removed).toEqual(['b.ts'])
  })
})
