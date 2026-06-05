import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock fs/promises
const { mockReadFile, mockWriteFile, mockMkdir } = vi.hoisted(() => ({
  mockReadFile: vi.fn(),
  mockWriteFile: vi.fn(),
  mockMkdir: vi.fn(),
}))

vi.mock('fs/promises', () => ({
  readFile: mockReadFile,
  writeFile: mockWriteFile,
  mkdir: mockMkdir,
}))

import { POST } from '@/app/api/sessions/[id]/files/accept/route'

function makeReq(body: object) {
  return new Request('http://localhost/api/sessions/s1/files/accept', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

const params = { params: Promise.resolve({ id: 's1' }) }

beforeEach(() => {
  vi.clearAllMocks()
  mockMkdir.mockResolvedValue(undefined)
  mockWriteFile.mockResolvedValue(undefined)
})

describe('POST /api/sessions/[id]/files/accept', () => {
  it('writes file successfully when file does not exist', async () => {
    mockReadFile.mockRejectedValueOnce(new Error('ENOENT'))
    const res = await POST(makeReq({ filePath: 'test.txt', content: 'hello' }), params)
    expect(res.status).toBe(200)
    expect(mockWriteFile).toHaveBeenCalled()
  })

  it('writes file when content matches existing file', async () => {
    mockReadFile.mockResolvedValueOnce('hello')
    const res = await POST(makeReq({ filePath: 'test.txt', content: 'hello' }), params)
    expect(res.status).toBe(200)
    expect(mockWriteFile).toHaveBeenCalled()
  })

  it('returns 409 when file content differs and force is not set', async () => {
    mockReadFile.mockResolvedValueOnce('old content')
    const res = await POST(makeReq({ filePath: 'test.txt', content: 'new content' }), params)
    expect(res.status).toBe(409)
    const json = await res.json()
    expect(json.error).toBe('file_modified')
    expect(mockWriteFile).not.toHaveBeenCalled()
  })

  it('writes file when force=true even if content differs', async () => {
    mockReadFile.mockResolvedValueOnce('old content')
    const res = await POST(makeReq({ filePath: 'test.txt', content: 'new content', force: true }), params)
    expect(res.status).toBe(200)
    expect(mockWriteFile).toHaveBeenCalled()
  })

  it('returns 400 when filePath is missing', async () => {
    const res = await POST(makeReq({ content: 'hello' }), params)
    expect(res.status).toBe(400)
  })

  it('returns 400 when content is missing', async () => {
    const res = await POST(makeReq({ filePath: 'test.txt' }), params)
    expect(res.status).toBe(400)
  })

  it('returns 400 for path traversal', async () => {
    const res = await POST(makeReq({ filePath: '../etc/passwd', content: 'hello' }), params)
    expect(res.status).toBe(400)
  })

  it('returns 403 for sensitive paths', async () => {
    const res = await POST(makeReq({ filePath: '.env', content: 'hello' }), params)
    expect(res.status).toBe(403)
  })
})
