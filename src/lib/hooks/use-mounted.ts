'use client'
import { useState, useEffect } from 'react'

/**
 * Returns true after the component has mounted on the client.
 * Use to avoid hydration mismatches when rendering theme-dependent content.
 */
export function useMounted() {
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])
  return mounted
}
