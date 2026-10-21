import { describe, it, expect, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  sessionFindUnique: vi.fn(),
  attachmentCreate: vi.fn(),
  transaction: vi.fn(),
  mkdir: vi.fn(),
  writeFile: vi.fn(),
  unlink: vi.fn(),
}))

vi.mock('@/lib/db', () => ({
  prisma: {
    session: { findUnique: mocks.sessionFindUnique },
    attachment: { create: mocks.attachmentCreate },
    $transaction: mocks.transaction,
  },
}))

vi.mock('fs/promises', () => ({
  mkdir: mocks.mkdir,
  writeFile: mocks.writeFile,
  unlink: mocks.unlink,
}))

import {
  POST,
  MAX_ATTACHMENT_FILES,
  MAX_ATTACHMENT_TOTAL_BYTES,
  MAX_ATTACHMENT_REQUEST_BYTES,
} from '@/app/api/sessions/[id]/attachments/route'

const SESSION_ID = '11111111-1111-4111-8111-111111111111'
const params = { params: Promise.resolve({ id: SESSION_ID }) }

function fakeFile(name: string, type: string, size: number): File {
  const file = new File(['x'], name, { type })
  Object.defineProperty(file, 'size', { value: size })
  return file
}

function makeRequest(files: File[], contentLength?: number): Request {
  const formData = new FormData()
  for (const file of files) formData.append('files', file)
  return new Request(`http://localhost/api/sessions/${SESSION_ID}/attachments`, {
    method: 'POST',
    body: formData,
    ...(contentLength !== undefined ? { headers: { 'content-length': String(contentLength) } } : {}),
  })
}

// FormData.append 会克隆 File（丢失测试里改写的 size），总大小边界用直接 formData 替身。
function makeRawRequest(files: File[]): Request {
  return {
    headers: new Headers(),
    formData: async () => ({ getAll: () => files }),
  } as unknown as Request
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.sessionFindUnique.mockResolvedValue({ id: SESSION_ID })
  mocks.mkdir.mockResolvedValue(undefined)
  mocks.writeFile.mockResolvedValue(undefined)
  mocks.unlink.mockResolvedValue(undefined)
  mocks.attachmentCreate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    id: `att-${mocks.attachmentCreate.mock.calls.length}`,
    ...data,
  }))
  mocks.transaction.mockImplementation(async (ops: Promise<unknown>[]) => Promise.all(ops))
})

describe('POST /api/sessions/[id]/attachments — P3 #14 上传边界', () => {
  it('超过文件数上限时在写盘前拒绝', async () => {
    const files = Array.from({ length: MAX_ATTACHMENT_FILES + 1 }, (_, i) => fakeFile(`f${i}.txt`, 'text/plain', 1))
    const res = await POST(makeRequest(files), params)

    expect(res.status).toBe(400)
    expect(mocks.mkdir).not.toHaveBeenCalled()
    expect(mocks.writeFile).not.toHaveBeenCalled()
  })

  it('总大小超过上限时在写盘前拒绝', async () => {
    const perFile = Math.ceil(MAX_ATTACHMENT_TOTAL_BYTES / 9) + 1
    const files = Array.from({ length: 9 }, (_, i) => fakeFile(`f${i}.txt`, 'text/plain', perFile))
    expect(files.reduce((sum, f) => sum + f.size, 0)).toBeGreaterThan(MAX_ATTACHMENT_TOTAL_BYTES)

    const res = await POST(makeRawRequest(files), params)

    expect(res.status).toBe(413)
    expect(mocks.mkdir).not.toHaveBeenCalled()
    expect(mocks.writeFile).not.toHaveBeenCalled()
  })

  it('Content-Length 超过请求上限时在 formData 解析前拒绝', async () => {
    const res = await POST(
      new Request(`http://localhost/api/sessions/${SESSION_ID}/attachments`, {
        method: 'POST',
        body: 'x',
        headers: { 'content-length': String(MAX_ATTACHMENT_REQUEST_BYTES + 1) },
      }),
      params,
    )

    expect(res.status).toBe(413)
    expect(mocks.mkdir).not.toHaveBeenCalled()
  })

  it('DB 事务失败时删除已写入文件并返回 500', async () => {
    const files = [fakeFile('a.txt', 'text/plain', 4), fakeFile('b.txt', 'text/plain', 4)]
    mocks.transaction.mockRejectedValueOnce(new Error('db down'))

    const res = await POST(makeRequest(files), params)

    expect(res.status).toBe(500)
    expect(mocks.writeFile).toHaveBeenCalledTimes(2)
    expect(mocks.unlink).toHaveBeenCalledTimes(2)
    const unlinked = mocks.unlink.mock.calls.map(c => String(c[0]))
    expect(unlinked.every(p => p.includes('uploads'))).toBe(true)
  })

  it('正常上传在事务成功后返回全部附件', async () => {
    const files = [fakeFile('a.txt', 'text/plain', 4), fakeFile('b.txt', 'text/plain', 4)]
    const res = await POST(makeRequest(files), params)

    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json).toHaveLength(2)
    expect(mocks.mkdir).toHaveBeenCalledTimes(1)
    expect(mocks.writeFile).toHaveBeenCalledTimes(2)
    expect(mocks.transaction).toHaveBeenCalledTimes(1)
    expect(mocks.unlink).not.toHaveBeenCalled()
  })
})
