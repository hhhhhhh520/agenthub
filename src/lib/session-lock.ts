const sessionLocks = new Map<string, Promise<void>>()
const LOCK_TIMEOUT_MS = 60_000

export async function acquireSessionLock(sessionId: string, signal?: AbortSignal): Promise<() => void> {
  let release: () => void
  const current = new Promise<void>(r => { release = r })
  const prev = sessionLocks.get(sessionId) || Promise.resolve()
  sessionLocks.set(sessionId, current)

  const prevWithTimeout = Promise.race([
    prev,
    new Promise<void>((_, reject) =>
      setTimeout(() => reject(new Error('Previous request timed out')), LOCK_TIMEOUT_MS)
    ),
  ])

  const abortHandler = signal
    ? () => { release(); if (sessionLocks.get(sessionId) === current) sessionLocks.delete(sessionId) }
    : null
  if (abortHandler && signal) signal.addEventListener('abort', abortHandler, { once: true })

  try {
    await prevWithTimeout
  } catch {
    console.warn(`[session-lock] Previous request for ${sessionId} timed out after ${LOCK_TIMEOUT_MS}ms, proceeding`)
  }

  return () => {
    release()
    if (abortHandler && signal) signal.removeEventListener('abort', abortHandler)
    if (sessionLocks.get(sessionId) === current) sessionLocks.delete(sessionId)
  }
}
