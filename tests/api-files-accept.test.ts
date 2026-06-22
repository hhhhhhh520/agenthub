import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock fs/promises
const { mockReadFile, mockWriteFile, mockMkdir, mockFindUnique } = vi.hoisted(() => ({
  mockReadFile: vi.fn(),
  mockWriteFile: vi.fn(),
  mockMkdir: vi.fn(),
  mockFindUnique: vi.fn(),
}))

vi.mock('fs/promises', () => ({
  readFile: mockReadFile,
  writeFile: mockWriteFile,
  mkdir: mockMkdir,
}))

vi.mock('@/lib/db', () => ({
  prisma: {
    session: {
      findUnique: mockFindUnique,
    },
  },
}))

import { POST } from '@/app/api/sessions/[id]/files/accept/route'

const VALID_SESSION_ID = '550e8400-e29b-41d4-a716-446655440000'

function makeReq(body: object, sessionId = VALID_SESSION_ID) {
  return new Request(`http://localhost/api/sessions/${sessionId}/files/accept`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

const params = (sessionId = VALID_SESSION_ID) => ({ params: Promise.resolve({ id: sessionId }) })

beforeEach(() => {
  vi.clearAllMocks()
  mockMkdir.mockResolvedValue(undefined)
  mockWriteFile.mockResolvedValue(undefined)
  // 默认：session 存在
  mockFindUnique.mockResolvedValue({ id: VALID_SESSION_ID, projectDir: '' })
})

describe('POST /api/sessions/[id]/files/accept', () => {
  it('writes file successfully when file does not exist', async () => {
    mockReadFile.mockRejectedValueOnce(new Error('ENOENT'))
    const res = await POST(makeReq({ filePath: 'test.txt', content: 'hello' }), params())
    expect(res.status).toBe(200)
    expect(mockWriteFile).toHaveBeenCalled()
  })

  it('writes file when content matches existing file', async () => {
    mockReadFile.mockResolvedValueOnce('hello')
    const res = await POST(makeReq({ filePath: 'test.txt', content: 'hello' }), params())
    expect(res.status).toBe(200)
    expect(mockWriteFile).toHaveBeenCalled()
  })

  it('returns 409 when file content differs and force is not set', async () => {
    mockReadFile.mockResolvedValueOnce('old content')
    const res = await POST(makeReq({ filePath: 'test.txt', content: 'new content' }), params())
    expect(res.status).toBe(409)
    const json = await res.json()
    expect(json.error).toBe('file_modified')
    expect(mockWriteFile).not.toHaveBeenCalled()
  })

  it('writes file when force=true even if content differs', async () => {
    mockReadFile.mockResolvedValueOnce('old content')
    const res = await POST(makeReq({ filePath: 'test.txt', content: 'new content', force: true }), params())
    expect(res.status).toBe(200)
    expect(mockWriteFile).toHaveBeenCalled()
  })

  it('returns 400 when filePath is missing', async () => {
    const res = await POST(makeReq({ content: 'hello' }), params())
    expect(res.status).toBe(400)
  })

  it('returns 400 when content is missing', async () => {
    const res = await POST(makeReq({ filePath: 'test.txt' }), params())
    expect(res.status).toBe(400)
  })

  it('returns 400 for path traversal', async () => {
    const res = await POST(makeReq({ filePath: '../etc/passwd', content: 'hello' }), params())
    expect(res.status).toBe(400)
  })

  it('returns 403 for sensitive paths', async () => {
    const res = await POST(makeReq({ filePath: '.env', content: 'hello' }), params())
    expect(res.status).toBe(403)
  })

  // ─── #3 修复：sessionId 归属校验 ───

  it('returns 400 when sessionId is not a valid UUID', async () => {
    const res = await POST(makeReq({ filePath: 'test.txt', content: 'hello' }, 'not-a-uuid'), params('not-a-uuid'))
    expect(res.status).toBe(400)
    expect(mockFindUnique).not.toHaveBeenCalled()
  })

  it('returns 400 when sessionId contains path traversal (..)', async () => {
    const res = await POST(makeReq({ filePath: 'test.txt', content: 'hello' }, '..%2F..%2F'), params('..%2F..%2F'))
    expect(res.status).toBe(400)
    expect(mockFindUnique).not.toHaveBeenCalled()
  })

  it('returns 404 when session does not exist in DB', async () => {
    mockFindUnique.mockResolvedValueOnce(null)
    const res = await POST(makeReq({ filePath: 'test.txt', content: 'hello' }), params())
    expect(res.status).toBe(404)
    expect(mockWriteFile).not.toHaveBeenCalled()
  })

  // ─── #4 修复：禁用 target=project（防 RCE 链核心） ───

  it('returns 403 when target=project (writes to source tree disabled)', async () => {
    const res = await POST(
      makeReq({ filePath: 'src/app/api/evil/route.ts', content: 'export function GET() {}', target: 'project' }),
      params()
    )
    expect(res.status).toBe(403)
    expect(mockWriteFile).not.toHaveBeenCalled()
  })

  it('returns 403 when target=project even for page.tsx', async () => {
    const res = await POST(
      makeReq({ filePath: 'src/app/page.tsx', content: '<script>evil</script>', target: 'project' }),
      params()
    )
    expect(res.status).toBe(403)
    expect(mockWriteFile).not.toHaveBeenCalled()
  })

  // ─── #4 修复：路径遍历加固（isPathSafe） ───

  it('returns 400 for absolute file path', async () => {
    const res = await POST(makeReq({ filePath: '/etc/passwd', content: 'hello' }), params())
    expect(res.status).toBe(400)
  })

  it('returns 400 when filePath resolves to base dir itself (.)', async () => {
    const res = await POST(makeReq({ filePath: '.', content: 'hello' }), params())
    expect(res.status).toBe(400)
  })

  // ─── #4 修复：敏感路径列表加固（前缀匹配 + 扩展 + 大小写不敏感） ───

  it('returns 403 for .env.local (env prefix bypass)', async () => {
    const res = await POST(makeReq({ filePath: '.env.local', content: 'hello' }), params())
    expect(res.status).toBe(403)
  })

  it('returns 403 for .env.production', async () => {
    const res = await POST(makeReq({ filePath: '.env.production', content: 'hello' }), params())
    expect(res.status).toBe(403)
  })

  it('returns 403 for .github/workflows (CI poisoning)', async () => {
    const res = await POST(makeReq({ filePath: '.github/workflows/ci.yml', content: 'hello' }), params())
    expect(res.status).toBe(403)
  })

  it('returns 403 for .ENV case-insensitive', async () => {
    const res = await POST(makeReq({ filePath: '.ENV', content: 'hello' }), params())
    expect(res.status).toBe(403)
  })

  it('returns 403 for package.json (RCE entrypoint)', async () => {
    const res = await POST(makeReq({ filePath: 'package.json', content: '{}' }), params())
    expect(res.status).toBe(403)
  })

  it('returns 403 for next.config.mjs (RCE entrypoint)', async () => {
    const res = await POST(makeReq({ filePath: 'next.config.mjs', content: 'export default {}' }), params())
    expect(res.status).toBe(403)
  })
})
