import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('child_process', () => ({
  execSync: vi.fn(),
}))

import { execSync } from 'child_process'
import { detectCLIPlatform } from '@/lib/cli-detect'

const mockExecSync = vi.mocked(execSync)

describe('detectCLIPlatform', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('should return claude-code when claude CLI is available', () => {
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd === 'claude --version') return 'claude 1.0.0'
      throw new Error('not found')
    })
    expect(detectCLIPlatform()).toBe('claude-code')
    expect(mockExecSync).toHaveBeenCalledWith('claude --version', { timeout: 3000, stdio: 'pipe' })
  })

  it('should return opencode when only opencode CLI is available', () => {
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd === 'opencode --version') return 'opencode 0.1.0'
      throw new Error('not found')
    })
    expect(detectCLIPlatform()).toBe('opencode')
    expect(mockExecSync).toHaveBeenCalledWith('claude --version', { timeout: 3000, stdio: 'pipe' })
    expect(mockExecSync).toHaveBeenCalledWith('opencode --version', { timeout: 3000, stdio: 'pipe' })
  })

  it('should return null when no CLI is available', () => {
    mockExecSync.mockImplementation(() => {
      throw new Error('command not found')
    })
    expect(detectCLIPlatform()).toBeNull()
  })
})
