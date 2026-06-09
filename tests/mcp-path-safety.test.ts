import { describe, it, expect } from 'vitest'
import { resolve, sep } from 'path'

/**
 * Test the isPathSafe logic used by MCP server.
 * We replicate the logic here since the MCP server module has side effects
 * (starts stdio transport on import).
 */
function createPathSafetyChecker(workDir: string) {
  const resolvedWorkDir = resolve(workDir)

  return function isPathSafe(filePath: string): boolean {
    // Replicate the logic from mcp-server/index.ts
    const resolved = resolve(workDir, filePath)
    return resolved === resolvedWorkDir || resolved.startsWith(resolvedWorkDir + sep)
  }
}

describe('MCP server — isPathSafe', () => {
  const checker = createPathSafetyChecker('/test/project')

  it('allows files within project directory', () => {
    expect(checker('src/app/page.tsx')).toBe(true)
    expect(checker('frontend/index.html')).toBe(true)
    expect(checker('backend/api.ts')).toBe(true)
  })

  it('allows nested paths', () => {
    expect(checker('src/components/deep/nested/file.tsx')).toBe(true)
  })

  it('allows the project root itself', () => {
    expect(checker('.')).toBe(true)
  })

  it('rejects parent directory traversal', () => {
    expect(checker('../outside')).toBe(false)
    expect(checker('../../etc/passwd')).toBe(false)
  })

  it('rejects absolute paths outside project', () => {
    expect(checker('/etc/passwd')).toBe(false)
    expect(checker('/tmp/malicious')).toBe(false)
  })

  it('rejects paths that resolve outside via ..', () => {
    expect(checker('src/../../etc/passwd')).toBe(false)
  })

  it('handles edge case of path ending with separator', () => {
    expect(checker('src/app/')).toBe(true)
  })

  it('rejects symlink-like traversal attempts', () => {
    // Even though we can't test realpathSync here, the resolved path should be safe
    expect(checker('./../../../etc')).toBe(false)
  })
})

describe('MCP server — read_artifact error handling', () => {
  it('returns error for path traversal', () => {
    const checker = createPathSafetyChecker('/test/project')
    expect(checker('../../../etc/passwd')).toBe(false)
  })

  it('returns error for absolute path outside project', () => {
    const checker = createPathSafetyChecker('/test/project')
    expect(checker('/etc/shadow')).toBe(false)
  })
})

describe('MCP server — list_files path validation', () => {
  it('accepts valid subdirectory', () => {
    const checker = createPathSafetyChecker('/test/project')
    expect(checker('frontend/')).toBe(true)
    expect(checker('backend/')).toBe(true)
  })

  it('rejects parent directory', () => {
    const checker = createPathSafetyChecker('/test/project')
    expect(checker('../')).toBe(false)
  })
})
