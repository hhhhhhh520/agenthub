import { describe, expect, it } from 'vitest'
import {
  isOpenCodePlatform,
  isPermissionMode,
  needsOpenCodePermissionWarning,
  requiresAutoForOpenCode,
  resolveSessionPermissionMode,
} from '../src/lib/permission-mode'

describe('permission-mode', () => {
  it('validates permission modes', () => {
    expect(isPermissionMode('default')).toBe(true)
    expect(isPermissionMode('auto')).toBe(true)
    expect(isPermissionMode('yolo')).toBe(false)
    expect(isPermissionMode(null)).toBe(false)
  })

  it('detects OpenCode platforms', () => {
    expect(isOpenCodePlatform('opencode')).toBe(true)
    expect(isOpenCodePlatform('claude-code')).toBe(false)
    expect(isOpenCodePlatform(undefined)).toBe(false)
  })

  it('forces auto when any selected agent is OpenCode', () => {
    expect(requiresAutoForOpenCode(['claude-code', 'opencode'])).toBe(true)
    expect(requiresAutoForOpenCode(['claude-code'])).toBe(false)
    expect(requiresAutoForOpenCode([])).toBe(false)
  })

  it('overrides requested default mode for OpenCode', () => {
    expect(resolveSessionPermissionMode('default', ['opencode'])).toBe('auto')
    expect(resolveSessionPermissionMode('default', ['claude-code'])).toBe('default')
    expect(resolveSessionPermissionMode('auto', ['claude-code'])).toBe('auto')
    expect(resolveSessionPermissionMode('auto', ['opencode'])).toBe('auto')
  })

  it('warns only for existing default-mode sessions with OpenCode', () => {
    expect(needsOpenCodePermissionWarning('default', ['opencode'])).toBe(true)
    expect(needsOpenCodePermissionWarning('default', ['claude-code'])).toBe(false)
    expect(needsOpenCodePermissionWarning('auto', ['opencode'])).toBe(false)
  })
})
