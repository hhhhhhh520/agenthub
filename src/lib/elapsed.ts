export function formatElapsed(startMs: number, nowMs: number): string {
  const totalSeconds = Math.max(0, Math.floor((nowMs - startMs) / 1000))
  const days = Math.floor(totalSeconds / 86400)
  const hours = Math.floor((totalSeconds % 86400) / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  const pad = (n: number) => String(n).padStart(2, '0')

  if (days > 0) return `${days}天 ${pad(hours)}:${pad(minutes)}:${pad(seconds)}`
  return hours > 0
    ? `${hours}:${pad(minutes)}:${pad(seconds)}`
    : `${minutes}:${pad(seconds)}`
}
