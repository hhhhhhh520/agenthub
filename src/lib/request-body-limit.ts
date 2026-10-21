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

  const replay = new Request(request.url, {
    method: request.method,
    headers: request.headers,
    body: new Blob(chunks, { type: request.headers.get('content-type') ?? '' }),
    signal: request.signal,
  })
  return replay.formData()
}
