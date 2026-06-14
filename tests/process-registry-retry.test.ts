import { describe, it, expect } from 'vitest'
import { isPermanentError, getRetryDelay } from '../src/lib/adapter/process-registry'

describe('ProcessRegistry error classification', () => {
  describe('isPermanentError', () => {
    it('should classify API_KEY_INVALID as permanent', () => {
      expect(isPermanentError('API_KEY_INVALID')).toBe(true)
    })

    it('should classify authentication_error as permanent', () => {
      expect(isPermanentError('Authentication error: invalid key')).toBe(true)
    })

    it('should classify permission_denied as permanent (case insensitive)', () => {
      expect(isPermanentError('Permission denied for model')).toBe(true)
      expect(isPermanentError('PERMISSION_DENIED')).toBe(true)
    })

    it('should classify MODEL_NOT_FOUND as permanent', () => {
      expect(isPermanentError('Model not found: claude-xyz')).toBe(true)
    })

    it('should classify invalid_prompt as permanent', () => {
      expect(isPermanentError('invalid_prompt: empty input')).toBe(true)
    })

    it('should classify process crash as transient (not permanent)', () => {
      expect(isPermanentError('Process exited with code 1')).toBe(false)
    })

    it('should classify timeout as transient', () => {
      expect(isPermanentError('No data received for 60s')).toBe(false)
    })

    it('should classify unknown errors as transient', () => {
      expect(isPermanentError('Something went wrong')).toBe(false)
    })

    it('should handle empty error string', () => {
      expect(isPermanentError('')).toBe(false)
    })
  })

  describe('getRetryDelay (exponential backoff)', () => {
    it('should return 1s for attempt 0', () => {
      expect(getRetryDelay(0)).toBe(1000)
    })

    it('should return 2s for attempt 1', () => {
      expect(getRetryDelay(1)).toBe(2000)
    })

    it('should return 4s for attempt 2', () => {
      expect(getRetryDelay(2)).toBe(4000)
    })

    it('should cap at 16s', () => {
      expect(getRetryDelay(10)).toBe(16000)
    })
  })
})
