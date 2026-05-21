const AGENT_COLORS = [
  { bg: 'bg-rose-100 text-rose-900', avatar: 'bg-rose-200 text-rose-800' },
  { bg: 'bg-emerald-100 text-emerald-900', avatar: 'bg-emerald-200 text-emerald-800' },
  { bg: 'bg-amber-100 text-amber-900', avatar: 'bg-amber-200 text-amber-800' },
  { bg: 'bg-cyan-100 text-cyan-900', avatar: 'bg-cyan-200 text-cyan-800' },
  { bg: 'bg-pink-100 text-pink-900', avatar: 'bg-pink-200 text-pink-800' },
  { bg: 'bg-lime-100 text-lime-900', avatar: 'bg-lime-200 text-lime-800' },
  { bg: 'bg-violet-100 text-violet-900', avatar: 'bg-violet-200 text-violet-800' },
  { bg: 'bg-teal-100 text-teal-900', avatar: 'bg-teal-200 text-teal-800' },
]

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

export function getAgentStyle(agentId: string, accentColor?: string) {
  if (accentColor) {
    const [h, s] = hexToHsl(accentColor)
    return {
      bg: `bg-[hsl(${h},${Math.min(s, 40)}%,92%)] text-[hsl(${h},${Math.min(s, 60)}%,20%)]`,
      avatarBg: `bg-[hsl(${h},${Math.min(s, 50)}%,85%)] text-[hsl(${h},${Math.min(s, 60)}%,25%)]`,
      initial: agentId.charAt(0).toUpperCase(),
    }
  }
  const idx = hashName(agentId) % AGENT_COLORS.length
  const color = AGENT_COLORS[idx]
  return {
    bg: color.bg,
    avatarBg: color.avatar,
    initial: agentId.charAt(0).toUpperCase(),
  }
}
