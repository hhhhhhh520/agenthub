import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

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
import { readFormDataWithLimit, RequestBodyTooLargeError } from '@/lib/request-body-limit'

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

  it('没有 Content-Length 时按实际读取字节拒绝超限请求', async () => {
    const chunk = new Uint8Array(1024 * 1024)
    let sent = 0
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent >= 54) {
          controller.close()
          return
        }
        sent++
        controller.enqueue(chunk)
      },
    })
    const request = new Request(`http://localhost/api/sessions/${SESSION_ID}/attachments`, {
      method: 'POST',
      headers: { 'content-type': 'multipart/form-data; boundary=x' },
      body,
      duplex: 'half',
    } as RequestInit)

    const res = await POST(request, params)

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

describe('readFormDataWithLimit — 无 Content-Length 的实际字节上限', () => {
  it('实际读取超过上限时取消源流并抛 413 错误', async () => {
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(32))
        controller.enqueue(new Uint8Array(32))
      },
      cancel() { cancelled = true },
    })
    const request = new Request(`http://localhost/api/sessions/${SESSION_ID}/attachments`, {
      method: 'POST',
      headers: { 'content-type': 'multipart/form-data; boundary=x' },
      body,
      duplex: 'half',
    } as RequestInit)

    await expect(readFormDataWithLimit(request, 40)).rejects.toBeInstanceOf(RequestBodyTooLargeError)
    expect(cancelled).toBe(true)
  })

  it('上限内的 multipart 正常解析，不依赖 Content-Length', async () => {
    const form = new FormData()
    form.append('description', 'hello')
    form.append('files', new File(['abc'], 'a.txt', { type: 'text/plain' }))
    const request = new Request(`http://localhost/api/sessions/${SESSION_ID}/attachments`, {
      method: 'POST',
      body: form,
    })

    expect(request.headers.get('content-length')).toBeNull()
    const parsed = await readFormDataWithLimit(request, 1024 * 1024)
    expect(parsed.get('description')).toBe('hello')
    expect((parsed.get('files') as File).name).toBe('a.txt')
  })

  it('多个 chunk 未超限时按字节顺序拼接并解析', async () => {
    const boundary = 'x'
    const payload =
      `--${boundary}\r\n` +
      'Content-Disposition: form-data; name="description"\r\n\r\n' +
      'hello\r\n' +
      `--${boundary}--\r\n`
    const bytes = new TextEncoder().encode(payload)
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, 10))
        controller.enqueue(bytes.slice(10, 35))
        controller.enqueue(bytes.slice(35))
        controller.close()
      },
    })
    const request = new Request(`http://localhost/api/sessions/${SESSION_ID}/attachments`, {
      method: 'POST',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      body,
      duplex: 'half',
    } as RequestInit)

    const parsed = await readFormDataWithLimit(request, 1024)
    expect(parsed.get('description')).toBe('hello')
  })

  it('上传路由接线到实际字节上限，不再直接 request.formData()', () => {
    const src = readFileSync(
      resolve(__dirname, '../src/app/api/sessions/[id]/attachments/route.ts'),
      'utf8',
    )
    expect(src).toContain('readFormDataWithLimit(request, MAX_ATTACHMENT_REQUEST_BYTES)')
  })
})
