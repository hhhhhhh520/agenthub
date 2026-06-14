import { describe, it, expect } from 'vitest'
import { isPathSafe } from '../src/lib/path-safety'

const WORK_DIR = '/test/project'

describe('MCP server — isPathSafe', () => {
  it('allows files within project directory', () => {
    expect(isPathSafe('src/app/page.tsx', WORK_DIR)).toBe(true)
    expect(isPathSafe('frontend/index.html', WORK_DIR)).toBe(true)
    expect(isPathSafe('backend/api.ts', WORK_DIR)).toBe(true)
  })

  it('allows nested paths', () => {
    expect(isPathSafe('src/components/deep/nested/file.tsx', WORK_DIR)).toBe(true)
  })

  it('allows the project root itself', () => {
    expect(isPathSafe('.', WORK_DIR)).toBe(true)
  })

  it('rejects parent directory traversal', () => {
    expect(isPathSafe('../outside', WORK_DIR)).toBe(false)
    expect(isPathSafe('../../etc/passwd', WORK_DIR)).toBe(false)
  })

  it('rejects absolute paths outside project', () => {
    expect(isPathSafe('/etc/passwd', WORK_DIR)).toBe(false)
    expect(isPathSafe('/tmp/malicious', WORK_DIR)).toBe(false)
  })

  it('rejects paths that resolve outside via ..', () => {
    expect(isPathSafe('src/../../etc/passwd', WORK_DIR)).toBe(false)
  })

  it('handles edge case of path ending with separator', () => {
    expect(isPathSafe('src/app/', WORK_DIR)).toBe(true)
  })

  it('rejects symlink-like traversal attempts', () => {
    expect(isPathSafe('./../../../etc', WORK_DIR)).toBe(false)
  })
})

describe('MCP server — read_artifact error handling', () => {
  it('returns error for path traversal', () => {
    expect(isPathSafe('../../../etc/passwd', WORK_DIR)).toBe(false)
  })

  it('returns error for absolute path outside project', () => {
    expect(isPathSafe('/etc/shadow', WORK_DIR)).toBe(false)
  })
})

describe('MCP server — list_files path validation', () => {
  it('accepts valid subdirectory', () => {
    expect(isPathSafe('frontend/', WORK_DIR)).toBe(true)
    expect(isPathSafe('backend/', WORK_DIR)).toBe(true)
  })

  it('rejects parent directory', () => {
    expect(isPathSafe('../', WORK_DIR)).toBe(false)
  })
})
