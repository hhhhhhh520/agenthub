export class RequestBodyTooLargeError extends Error {
  readonly code = 'REQUEST_BODY_TOO_LARGE'

  constructor(maxBytes: number) {
    super(`Request body exceeds ${maxBytes} bytes limit`)
    this.name = 'RequestBodyTooLargeError'
  }
}

/**
 * 先按实际读取字节数截断请求体，再交给原生 multipart 解析。
 * Content-Length 可缺失/可伪造，不能作为唯一上限；超限时立刻 cancel 源流。
 */
export async function readFormDataWithLimit(request: Request, maxBytes: number): Promise<FormData> {
  if (!request.body) throw new Error('Request body is empty')

  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel().catch(() => {})
        throw new RequestBodyTooLargeError(maxBytes)
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }

  // TypeScript 5.9: BlobPart requires an ArrayBuffer-backed view. Chunks from
  // ReadableStream are Uint8Array<ArrayBufferLike>, so copy them into one
  // fresh buffer before constructing the Blob.
  const body = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }

  const replay = new Request(request.url, {
    method: request.method,
    headers: request.headers,
    body: new Blob([body], { type: request.headers.get('content-type') ?? '' }),
    signal: request.signal,
  })
  return replay.formData()
}
