import { describe, it, expect } from 'vitest'

// All tests use the real exported functions from src/lib/agent-colors.ts.
// hashName and hexToHsl are internal (not exported), so we test their
// behavior indirectly through getAgentStyle.

describe('getAgentStyle — deterministic color assignment', () => {
  it('same agentId always returns the same style', async () => {
    const { getAgentStyle } = await import('../src/lib/agent-colors')
    const a = getAgentStyle('frontend-dev')
    const b = getAgentStyle('frontend-dev')
    expect(a.bg).toBe(b.bg)
    expect(a.avatarBg).toBe(b.avatarBg)
    expect(a.initial).toBe(b.initial)
  })

  it('different agentIds get different styles (most of the time)', async () => {
    const { getAgentStyle } = await import('../src/lib/agent-colors')
    // With 8 colors, two different names should differ at least once
    const styles = ['a', 'b', 'c', 'd', 'e'].map(id => getAgentStyle(id).bg)
    const unique = new Set(styles)
    expect(unique.size).toBeGreaterThan(1)
  })

  it('initial is first character uppercased', async () => {
    const { getAgentStyle } = await import('../src/lib/agent-colors')
    expect(getAgentStyle('frontend').initial).toBe('F')
    expect(getAgentStyle('backend').initial).toBe('B')
    expect(getAgentStyle('架构师').initial).toBe('架')
  })

  it('style object has required keys', async () => {
    const { getAgentStyle } = await import('../src/lib/agent-colors')
    const style = getAgentStyle('test')
    expect(style).toHaveProperty('bg')
    expect(style).toHaveProperty('avatarBg')
    expect(style).toHaveProperty('initial')
    expect(typeof style.bg).toBe('string')
    expect(typeof style.avatarBg).toBe('string')
  })

  it('styles contain tailwind bg- classes', async () => {
    const { getAgentStyle } = await import('../src/lib/agent-colors')
    const style = getAgentStyle('any-agent')
    expect(style.bg).toContain('bg-')
    expect(style.avatarBg).toContain('bg-')
  })
})

describe('getAgentStyle — accent color (hexToHsl path)', () => {
  it('accent color produces hsl-based classes', async () => {
    const { getAgentStyle } = await import('../src/lib/agent-colors')
    const style = getAgentStyle('any-id', '#ff0000')
    expect(style.bg).toContain('hsl')
    expect(style.avatarBg).toContain('hsl')
  })

  it('different accent colors produce different styles', async () => {
    const { getAgentStyle } = await import('../src/lib/agent-colors')
    const red = getAgentStyle('x', '#ff0000')
    const blue = getAgentStyle('x', '#0000ff')
    expect(red.bg).not.toBe(blue.bg)
  })

  it('same accent color produces same style regardless of agentId', async () => {
    const { getAgentStyle } = await import('../src/lib/agent-colors')
    const a = getAgentStyle('agent-1', '#3b82f6')
    const b = getAgentStyle('agent-2', '#3b82f6')
    // Same hex → same hsl → same classes
    expect(a.bg).toBe(b.bg)
    expect(a.avatarBg).toBe(b.avatarBg)
  })

  it('accent color overrides agentId-based color selection', async () => {
    const { getAgentStyle } = await import('../src/lib/agent-colors')
    const without = getAgentStyle('test-agent')
    const withAccent = getAgentStyle('test-agent', '#10b981')
    expect(without.bg).not.toBe(withAccent.bg)
  })

  it('returns valid hsl values in class strings', async () => {
    const { getAgentStyle } = await import('../src/lib/agent-colors')
    const style = getAgentStyle('x', '#ff0000')
    // Should contain numeric hsl values, not NaN
    expect(style.bg).not.toContain('NaN')
    expect(style.avatarBg).not.toContain('NaN')
  })
})

describe('STATUS_COLORS', () => {
  it('has all required status keys', async () => {
    const { STATUS_COLORS } = await import('../src/lib/agent-colors')
    expect(STATUS_COLORS).toHaveProperty('idle')
    expect(STATUS_COLORS).toHaveProperty('working')
    expect(STATUS_COLORS).toHaveProperty('done')
    expect(STATUS_COLORS).toHaveProperty('error')
  })

  it('all values are valid tailwind bg- classes', async () => {
    const { STATUS_COLORS } = await import('../src/lib/agent-colors')
    for (const [status, cls] of Object.entries(STATUS_COLORS)) {
      expect(cls, `${status} should contain bg-`).toContain('bg-')
    }
  })

  it('working status has animate-pulse', async () => {
    const { STATUS_COLORS } = await import('../src/lib/agent-colors')
    expect(STATUS_COLORS.working).toContain('animate-pulse')
  })

  it('idle status has no animation', async () => {
    const { STATUS_COLORS } = await import('../src/lib/agent-colors')
    expect(STATUS_COLORS.idle).not.toContain('animate')
  })
})
