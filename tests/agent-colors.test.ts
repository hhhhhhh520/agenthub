import { describe, it, expect } from 'vitest'

// Import functions from agent-colors (need to extract for testing)
// Since hashName and hexToHsl are not exported, we test getAgentStyle behavior

// Recreate the logic for testing (internal functions)
function hashName(name: string): number {
  let hash = 0
  for (let i = 0; i < name.length; i++) {
    hash = (hash * 31 + name.charCodeAt(i)) | 0
  }
  return Math.abs(hash)
}

function hexToHsl(hex: string): [number, number, number] {
  const r = parseInt(hex.slice(1, 3), 16) / 255
  const g = parseInt(hex.slice(3, 5), 16) / 255
  const b = parseInt(hex.slice(5, 7), 16) / 255
  const max = Math.max(r, g, b), min = Math.min(r, g, b)
  let h = 0, s = 0
  const l = (max + min) / 2
  if (max !== min) {
    const d = max - min
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6
    else if (max === g) h = ((b - r) / d + 2) / 6
    else h = ((r - g) / d + 4) / 6
  }
  return [h * 360, s * 100, l * 100]
}

describe('hashName', () => {
  it('should return consistent hash for same input', () => {
    const hash1 = hashName('agent-1')
    const hash2 = hashName('agent-1')
    expect(hash1).toBe(hash2)
  })

  it('should return different hash for different inputs', () => {
    const hash1 = hashName('agent-1')
    const hash2 = hashName('agent-2')
    expect(hash1).not.toBe(hash2)
  })

  it('should return positive number', () => {
    expect(hashName('test')).toBeGreaterThanOrEqual(0)
  })

  it('should handle empty string', () => {
    expect(hashName('')).toBe(0)
  })

  it('should handle unicode characters', () => {
    const hash = hashName('中文Agent')
    expect(typeof hash).toBe('number')
    expect(hash).toBeGreaterThanOrEqual(0)
  })

  it('should produce deterministic color index', () => {
    // 8 colors in AGENT_COLORS, so index should be 0-7
    const idx = hashName('frontend-dev') % 8
    expect(idx).toBeGreaterThanOrEqual(0)
    expect(idx).toBeLessThan(8)
  })
})

describe('hexToHsl', () => {
  it('should convert red correctly', () => {
    const [h, s, l] = hexToHsl('#ff0000')
    expect(h).toBeCloseTo(0, 1)
    expect(s).toBeCloseTo(100, 1)
    expect(l).toBeCloseTo(50, 1)
  })

  it('should convert green correctly', () => {
    const [h, s, l] = hexToHsl('#00ff00')
    expect(h).toBeCloseTo(120, 1)
    expect(s).toBeCloseTo(100, 1)
    expect(l).toBeCloseTo(50, 1)
  })

  it('should convert blue correctly', () => {
    const [h, s, l] = hexToHsl('#0000ff')
    expect(h).toBeCloseTo(240, 1)
    expect(s).toBeCloseTo(100, 1)
    expect(l).toBeCloseTo(50, 1)
  })

  it('should convert white correctly', () => {
    const [h, s, l] = hexToHsl('#ffffff')
    expect(l).toBeCloseTo(100, 1)
    expect(s).toBeCloseTo(0, 1)
  })

  it('should convert black correctly', () => {
    const [h, s, l] = hexToHsl('#000000')
    expect(l).toBeCloseTo(0, 1)
    expect(s).toBeCloseTo(0, 1)
  })

  it('should convert gray correctly', () => {
    const [h, s, l] = hexToHsl('#808080')
    expect(s).toBeCloseTo(0, 1)
    // #808080 is actually 50.2% lightness, not exactly 50
    expect(l).toBeCloseTo(50.2, 0)
  })

  it('should handle 6-char hex format', () => {
    const result = hexToHsl('#1a2b3c')
    expect(result).toHaveLength(3)
    result.forEach(v => expect(typeof v).toBe('number'))
  })
})

describe('getAgentStyle (via module import)', () => {
  it('should be importable', async () => {
    const { getAgentStyle } = await import('../src/lib/agent-colors')
    expect(typeof getAgentStyle).toBe('function')
  })

  it('should return style object with required keys', async () => {
    const { getAgentStyle } = await import('../src/lib/agent-colors')
    const style = getAgentStyle('test-agent')
    expect(style).toHaveProperty('bg')
    expect(style).toHaveProperty('avatarBg')
    expect(style).toHaveProperty('initial')
  })

  it('should return first character uppercase as initial', async () => {
    const { getAgentStyle } = await import('../src/lib/agent-colors')
    const style = getAgentStyle('frontend')
    expect(style.initial).toBe('F')
  })

  it('should return same style for same agentId', async () => {
    const { getAgentStyle } = await import('../src/lib/agent-colors')
    const style1 = getAgentStyle('agent-1')
    const style2 = getAgentStyle('agent-1')
    expect(style1.bg).toBe(style2.bg)
  })

  it('should use accent color when provided', async () => {
    const { getAgentStyle } = await import('../src/lib/agent-colors')
    const style = getAgentStyle('any-id', '#ff0000')
    // With accent color, should return hsl-based classes
    expect(style.bg).toContain('hsl')
    expect(style.avatarBg).toContain('hsl')
  })
})

describe('STATUS_COLORS constant', () => {
  it('should have all required status keys', async () => {
    const { STATUS_COLORS } = await import('../src/lib/agent-colors')
    expect(STATUS_COLORS).toHaveProperty('idle')
    expect(STATUS_COLORS).toHaveProperty('working')
    expect(STATUS_COLORS).toHaveProperty('done')
    expect(STATUS_COLORS).toHaveProperty('error')
  })

  it('should have valid tailwind classes', async () => {
    const { STATUS_COLORS } = await import('../src/lib/agent-colors')
    expect(STATUS_COLORS.idle).toContain('bg-')
    expect(STATUS_COLORS.working).toContain('bg-')
    expect(STATUS_COLORS.done).toContain('bg-')
    expect(STATUS_COLORS.error).toContain('bg-')
  })

  it('working status should have animate-pulse', async () => {
    const { STATUS_COLORS } = await import('../src/lib/agent-colors')
    expect(STATUS_COLORS.working).toContain('animate-pulse')
  })
})