const CLOCK_FORMAT = new Intl.DateTimeFormat('zh-CN', {
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
})

const FULL_FORMAT = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
})

function toDate(value: string): Date | null {
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? date : null
}

export function formatMessageClock(value: string): string {
  const date = toDate(value)
  return date ? CLOCK_FORMAT.format(date) : ''
}

export function formatMessageFullTime(value: string): string {
  const date = toDate(value)
  return date ? FULL_FORMAT.format(date) : ''
}
