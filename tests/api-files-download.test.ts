import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockReadFile, mockFindUnique } = vi.hoisted(() => ({
  mockReadFile: vi.fn(),
  mockFindUnique: vi.fn(),
}))

vi.mock('fs/promises', () => ({ readFile: mockReadFile }))
vi.mock('@/lib/db', () => ({ prisma: { session: { findUnique: mockFindUnique } } }))

import { GET } from '@/app/api/sessions/[id]/files/[filename]/route'

const VALID_SESSION_ID = '550e8400-e29b-41d4-a716-446655440000'

function makeReq(sessionId = VALID_SESSION_ID, filename = 'test.txt') {
  return new Request(`http://localhost/api/sessions/${sessionId}/files/${encodeURIComponent(filename)}`)
}

const params = (sessionId = VALID_SESSION_ID, filename = 'test.txt') => ({
  params: Promise.resolve({ id: sessionId, filename }),
})

beforeEach(() => {
  vi.clearAllMocks()
  mockFindUnique.mockResolvedValue({ id: VALID_SESSION_ID })
  mockReadFile.mockResolvedValue(Buffer.from('hello'))
})

describe('GET /api/sessions/[id]/files/[filename]', () => {
  it('downloads file successfully', async () => {
    const res = await GET(makeReq(), params())
    expect(res.status).toBe(200)
  })

  it('returns 400 when sessionId is not a valid UUID', async () => {
    const res = await GET(makeReq('not-a-uuid', 'test.txt'), params('not-a-uuid', 'test.txt'))
    expect(res.status).toBe(400)
    expect(mockFindUnique).not.toHaveBeenCalled()
  })

  it('returns 400 when sessionId contains path traversal (..) — blocks .env read', async () => {
    const res = await GET(makeReq('..', '.env'), params('..', '.env'))
    expect(res.status).toBe(400)
  })

  it('returns 404 when session does not exist', async () => {
    mockFindUnique.mockResolvedValueOnce(null)
    const res = await GET(makeReq(), params())
    expect(res.status).toBe(404)
    expect(mockReadFile).not.toHaveBeenCalled()
  })

  it('returns 400 when filename contains ..', async () => {
    const res = await GET(makeReq(VALID_SESSION_ID, '../etc/passwd'), params(VALID_SESSION_ID, '../etc/passwd'))
    expect(res.status).toBe(400)
  })

  it('returns 400 when filename contains /', async () => {
    const res = await GET(makeReq(VALID_SESSION_ID, 'a/b'), params(VALID_SESSION_ID, 'a/b'))
    expect(res.status).toBe(400)
  })

  it('returns 404 when file does not exist', async () => {
    mockReadFile.mockRejectedValueOnce(new Error('ENOENT'))
    const res = await GET(makeReq(), params())
    expect(res.status).toBe(404)
  })
})
