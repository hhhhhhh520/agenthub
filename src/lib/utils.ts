import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function maskApiKey(key: string): string {
  if (!key) return ''
  if (key.length <= 4) return '***'
  return `***${key.slice(-4)}`
}
