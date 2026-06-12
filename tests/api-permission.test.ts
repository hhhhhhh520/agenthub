import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockSessionFindUnique, mockRespondPermissionByRequestId } = vi.hoisted(() => ({
  mockSessionFindUnique: vi.fn(),
  mockRespondPermissionByRequestId: vi.fn(),
}))

vi.mock('@/lib/db', () => ({
  prisma: { session: { findUnique: mockSessionFindUnique } },
}))

vi.mock('@/lib/adapter/process-registry', () => ({
  processRegistry: { respondPermissionByRequestId: mockRespondPermissionByRequestId },
}))

import { POST } from '@/app/api/sessions/[id]/permission/route'

function makeReq(body: Record<string, unknown>) {
  return new Request('http://localhost/api/sessions/s1/permission', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  })
}

const params = { params: Promise.resolve({ id: 's1' }) }

beforeEach(() => {
  vi.clearAllMocks()
  mockSessionFindUnique.mockResolvedValue({ id: 's1', projectDir: '/test' })
  mockRespondPermissionByRequestId.mockReturnValue(true)
})

describe('POST /api/sessions/[id]/permission', () => {
  it('returns 400 when required fields missing', async () => {
    const res = await POST(makeReq({ requestId: 'r1' }), params)
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('Missing required fields')
  })

  it('returns 400 when agentId missing', async () => {
    const res = await POST(makeReq({ requestId: 'r1', behavior: 'allow' }), params)
    expect(res.status).toBe(400)
  })

  it('returns 404 when session not found', async () => {
    mockSessionFindUnique.mockResolvedValue(null)
    const res = await POST(
      makeReq({ requestId: 'r1', behavior: 'allow', agentId: 'a1' }),
      { params: Promise.resolve({ id: 'nonexistent' }) }
    )
    expect(res.status).toBe(404)
  })

  it('calls respondPermissionByRequestId with correct params', async () => {
    const res = await POST(makeReq({
      requestId: 'req-123',
      behavior: 'allow',
      agentId: 'agent-1',
      updatedInput: { command: 'ls' },
    }), params)
    expect(res.status).toBe(200)
    expect(mockRespondPermissionByRequestId).toHaveBeenCalledWith(
      'req-123',
      expect.objectContaining({ behavior: 'allow', updatedInput: { command: 'ls' } })
    )
  })

  it('supports deny behavior with message', async () => {
    await POST(makeReq({
      requestId: 'req-456',
      behavior: 'deny',
      agentId: 'agent-1',
      message: 'User denied this tool use',
    }), params)
    expect(mockRespondPermissionByRequestId).toHaveBeenCalledWith(
      'req-456',
      expect.objectContaining({ behavior: 'deny', message: 'User denied this tool use' })
    )
  })

  it('returns ok:true on success', async () => {
    const res = await POST(makeReq({
      requestId: 'r1', behavior: 'allow', agentId: 'a1',
    }), params)
    const body = await res.json()
    expect(body.ok).toBe(true)
  })

  it('returns 404 when permission request not found', async () => {
    mockRespondPermissionByRequestId.mockReturnValue(false)
    const res = await POST(makeReq({
      requestId: 'r1', behavior: 'allow', agentId: 'a1',
    }), params)
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error).toContain('Permission request not found')
  })
})
