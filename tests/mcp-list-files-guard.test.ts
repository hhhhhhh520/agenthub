import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { isListDirSafe } from '../src/lib/path-safety'

const WORK_DIR = '/test/project'

describe('MCP list_files — isListDirSafe（目录校验）', () => {
  it('allows subdirectories and root', () => {
    expect(isListDirSafe('frontend/', WORK_DIR)).toBe(true)
    expect(isListDirSafe('backend', WORK_DIR)).toBe(true)
    expect(isListDirSafe('.', WORK_DIR)).toBe(true)
    expect(isListDirSafe(undefined, WORK_DIR)).toBe(true)
  })

  it('rejects parent directory traversal', () => {
    expect(isListDirSafe('..', WORK_DIR)).toBe(false)
    expect(isListDirSafe('../', WORK_DIR)).toBe(false)
  })

  it('rejects prefix-sibling directories（startsWith 前缀绕过）', () => {
    // /test/project-evil 以 /test/project 为前缀——裸 startsWith 会放行，必须拒绝
    expect(isListDirSafe('../project-evil', WORK_DIR)).toBe(false)
    expect(isListDirSafe('../project2', WORK_DIR)).toBe(false)
  })

  it('rejects absolute paths outside project', () => {
    expect(isListDirSafe('/etc', WORK_DIR)).toBe(false)
    expect(isListDirSafe('/tmp/malicious', WORK_DIR)).toBe(false)
  })
})

describe('MCP list_files — 源码守卫', () => {
  it('目录校验与列举模块不得使用裸 startsWith 前缀判断', () => {
    const indexSrc = readFileSync(new URL('../src/mcp-server/index.ts', import.meta.url), 'utf-8')
    const listDirSrc = readFileSync(new URL('../src/lib/list-dir.ts', import.meta.url), 'utf-8')
    expect(indexSrc).not.toContain('startsWith(WORK_DIR)')
    expect(listDirSrc).not.toContain('startsWith(')
  })
})
