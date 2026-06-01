import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function hasLoneSurrogates(str: string): boolean {
  let i = 0
  while (i < str.length) {
    const code = str.charCodeAt(i)
    if (code >= 0xD800 && code <= 0xDBFF) {
      const next = str.charCodeAt(i + 1)
      if (!(next >= 0xDC00 && next <= 0xDFFF)) return true
      i += 2
    } else if (code >= 0xDC00 && code <= 0xDFFF) {
      return true
    } else {
      i++
    }
  }
  return false
}

export function maskApiKey(key: string): string {
  if (!key) return ''
  if (key.length <= 4) return '***'
  return `***${key.slice(-4)}`
}
