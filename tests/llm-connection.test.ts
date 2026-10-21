import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createServer, type Server } from 'node:http'
import { testLLMConnection } from '@/lib/llm-connection'

let server: Server
let baseUrl: string

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url !== '/v1/chat/completions' || req.method !== 'POST') {
      res.writeHead(404).end()
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({
      id: 'chatcmpl-test',
      object: 'chat.completion',
      created: 1,
      model: 'gpt-test',
      choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
    }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('no port')
  baseUrl = `http://127.0.0.1:${address.port}/v1`
})

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()))
})

describe('testLLMConnection', () => {
  it('真实请求 OpenAI 兼容端点并返回模型文本', async () => {
    await expect(testLLMConnection({ apiKey: 'test-key', model: 'gpt-test', baseUrl })).resolves.toBe('OK')
  })

  it('拒绝非 https 且非回环的 baseUrl', async () => {
    await expect(testLLMConnection({
      apiKey: 'test-key',
      model: 'gpt-test',
      baseUrl: 'http://example.com/v1',
    })).rejects.toThrow(/不安全/)
  })
})
