import { describe, expect, it } from 'vitest'
import { assertOkResponse } from '@/lib/http-error'

describe('assertOkResponse', () => {
  it('2xx 原样返回', async () => {
    const res = new Response('ok', { status: 200 })
    await expect(assertOkResponse(res, '失败')).resolves.toBe(res)
  })

  it('非 2xx 优先透出服务端 error', async () => {
    const res = new Response(JSON.stringify({ error: '数据库不可用' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    })
    await expect(assertOkResponse(res, '保存失败')).rejects.toThrow('数据库不可用')
  })

  it('非 JSON 错误体使用 fallback + 状态码', async () => {
    const res = new Response('nope', { status: 502 })
    await expect(assertOkResponse(res, '保存失败')).rejects.toThrow('保存失败 (502)')
  })

  it('不消费原响应体，调用方之后仍可 json()', async () => {
    const res = new Response(JSON.stringify({ value: 1 }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
    await assertOkResponse(res, '失败')
    await expect(res.json()).resolves.toEqual({ value: 1 })
  })
})
