import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readDecisionModelEnv, openAiChatUrl, resolveDecisionLLMConfig, callDecisionLLM } from '@/lib/orchestrator/decision-llm'
import { TimeoutError } from '@/lib/orchestrator/timeout'

// ── ISSUE-028 T2：决策/分析类结构化 LLM 调用的快模型通道（OpenAI 兼容直连）──
//
// 根因：决策调用共用执行 agent 线路（mimo 推理模型）——推理长 + JSON 不稳定 +
// 2min 超时叠加网关 60s，parseJSON 频繁失败（曾致静默回退，见 ISSUE-028）。
// 设 AGENTHUB_DECISION_MODEL 启用快通道；凭据优先 env，缺省复用 orchestrator
// agent 的 baseUrl/apiKey（DB 通道，key 不落盘）；未设 env → null 走原路径。

const ENV_KEYS = ['AGENTHUB_DECISION_MODEL', 'AGENTHUB_DECISION_BASE_URL', 'AGENTHUB_DECISION_API_KEY'] as const
const savedEnv: Record<string, string | undefined> = {}

beforeEach(() => {
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k]
    delete process.env[k]
  }
})

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
  vi.unstubAllGlobals()
})

describe('readDecisionModelEnv', () => {
  it('未设 / 空 / 纯空白 → null（快通道关闭）', () => {
    expect(readDecisionModelEnv()).toBeNull()
    process.env.AGENTHUB_DECISION_MODEL = ''
    expect(readDecisionModelEnv()).toBeNull()
    process.env.AGENTHUB_DECISION_MODEL = '   '
    expect(readDecisionModelEnv()).toBeNull()
  })

  it('设定 → 返回去空白模型名', () => {
    process.env.AGENTHUB_DECISION_MODEL = ' qwen3.8-flash '
    expect(readDecisionModelEnv()).toBe('qwen3.8-flash')
  })
})

describe('openAiChatUrl', () => {
  it('带 /v1 的 baseUrl → 直接拼 /chat/completions（tokenrhythm 形态）', () => {
    expect(openAiChatUrl('https://tokenrhythm.studio/v1')).toBe('https://tokenrhythm.studio/v1/chat/completions')
    expect(openAiChatUrl('https://tokenrhythm.studio/v1/')).toBe('https://tokenrhythm.studio/v1/chat/completions')
  })

  it('裸域 → 补 /v1/chat/completions', () => {
    expect(openAiChatUrl('https://gw.example.com')).toBe('https://gw.example.com/v1/chat/completions')
    expect(openAiChatUrl('https://gw.example.com/')).toBe('https://gw.example.com/v1/chat/completions')
  })

  it('已带完整端点 → 原样返回', () => {
    expect(openAiChatUrl('https://gw.example.com/v1/chat/completions')).toBe('https://gw.example.com/v1/chat/completions')
  })
})

describe('resolveDecisionLLMConfig', () => {
  const orch = { baseUrl: 'https://orch-gw.test/v1', apiKey: 'sk-orch' }

  it('env 显式 BASE_URL/API_KEY 优先于 orchestrator 凭据', () => {
    process.env.AGENTHUB_DECISION_MODEL = 'glm-5.3-flash'
    process.env.AGENTHUB_DECISION_BASE_URL = 'https://env-gw.test/v1'
    process.env.AGENTHUB_DECISION_API_KEY = 'sk-env'
    expect(resolveDecisionLLMConfig('glm-5.3-flash', orch)).toEqual({
      baseUrl: 'https://env-gw.test/v1', apiKey: 'sk-env', model: 'glm-5.3-flash',
    })
  })

  it('env 未设 → 复用 orchestrator agent 的 baseUrl/apiKey（DB 通道）', () => {
    expect(resolveDecisionLLMConfig('qwen3.8-flash', orch)).toEqual({
      baseUrl: 'https://orch-gw.test/v1', apiKey: 'sk-orch', model: 'qwen3.8-flash',
    })
  })

  it('凭据缺失（无 baseUrl / 无 apiKey）→ null', () => {
    expect(resolveDecisionLLMConfig('m', { baseUrl: '', apiKey: 'sk' })).toBeNull()
    expect(resolveDecisionLLMConfig('m', { baseUrl: 'https://x.test', apiKey: '' })).toBeNull()
    expect(resolveDecisionLLMConfig('m', { baseUrl: undefined, apiKey: undefined })).toBeNull()
  })

  it('model 为空 → null（防御）', () => {
    expect(resolveDecisionLLMConfig('', orch)).toBeNull()
  })

  it('scheme 校验（同 adapter 层规则）：https 任意放行，http 仅回环，其余拒绝', () => {
    expect(resolveDecisionLLMConfig('m', { baseUrl: 'https://x.test/v1', apiKey: 'k' })).not.toBeNull()
    expect(() => resolveDecisionLLMConfig('m', { baseUrl: 'http://192.168.1.5:3000/v1', apiKey: 'k' })).toThrow()
    expect(() => resolveDecisionLLMConfig('m', { baseUrl: 'ftp://x.test', apiKey: 'k' })).toThrow()
    expect(() => resolveDecisionLLMConfig('m', { baseUrl: 'not-a-url', apiKey: 'k' })).toThrow()
    expect(resolveDecisionLLMConfig('m', { baseUrl: 'http://localhost:3000/v1', apiKey: 'k' })).not.toBeNull()
    expect(resolveDecisionLLMConfig('m', { baseUrl: 'http://127.0.0.1:8080/v1', apiKey: 'k' })).not.toBeNull()
    // IPv6 回环括号形态（WHATWG hostname 对 [::1] 返回带括号），与 adapter 层双胞胎对齐（审查 🟢）
    expect(resolveDecisionLLMConfig('m', { baseUrl: 'http://[::1]:3000/v1', apiKey: 'k' })).not.toBeNull()
  })
})

describe('callDecisionLLM', () => {
  const cfg = { baseUrl: 'https://gw.test/v1', apiKey: 'sk-test-key', model: 'qwen3.8-flash' }

  function mockFetchRes(ok: boolean, status: number, body: unknown) {
    return vi.fn().mockResolvedValue({
      ok, status,
      json: async () => body,
      text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    })
  }

  it('200 → 返回 choices[0].message.content；请求形状（URL/Bearer/temperature/max_tokens/messages）正确', async () => {
    const fetchMock = mockFetchRes(true, 200, { choices: [{ message: { content: '{"action":"self","message":"hi","reason":"r"}' } }] })
    vi.stubGlobal('fetch', fetchMock)
    const result = await callDecisionLLM(cfg, '系统提示', '用户输入')
    expect(result).toBe('{"action":"self","message":"hi","reason":"r"}')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://gw.test/v1/chat/completions')
    expect(init.method).toBe('POST')
    // 重定向禁止：https 入口被 302 降级 http 会绕过 scheme 校验对终点的约束（审查 🟡）
    expect(init.redirect).toBe('error')
    const headers = init.headers as Record<string, string>
    expect(headers['Content-Type']).toBe('application/json')
    expect(headers['Authorization']).toBe('Bearer sk-test-key')
    const payload = JSON.parse(init.body as string)
    expect(payload.model).toBe('qwen3.8-flash')
    expect(payload.temperature).toBe(0.2)
    expect(payload.max_tokens).toBe(2048)
    expect(payload.messages).toEqual([
      { role: 'system', content: '系统提示' },
      { role: 'user', content: '用户输入' },
    ])
  })

  it('非 2xx → throw 且含状态码与响应体片段（诊断层级要求）', async () => {
    vi.stubGlobal('fetch', mockFetchRes(false, 401, 'unauthorized body'))
    await expect(callDecisionLLM(cfg, 's', 'u')).rejects.toThrow(/HTTP 401.*unauthorized body/s)
  })

  it('非 2xx 错误体中的 key 形态被脱敏（401 回显面，异常消息会进持久化 trace）', async () => {
    vi.stubGlobal('fetch', mockFetchRes(false, 401, 'invalid key: Bearer sk-abcdef123456789, also sk-qqqqwwwwwwww'))
    const err = await callDecisionLLM(cfg, 's', 'u').catch(e => e as Error)
    expect(err.message).toContain('HTTP 401')
    expect(err.message).toContain('sk-***')
    expect(err.message).not.toContain('sk-abcdef')
    expect(err.message).not.toContain('sk-qqqq')
  })

  it('非 JSON 响应（HTML 错误页）→ 通用消息，不携带响应体片段', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, status: 200,
      json: async () => { throw new SyntaxError('Unexpected token < in JSON at position 0: <html>sk-abcdef123456789</html>') },
      text: async () => '<html>sk-abcdef123456789</html>',
    }))
    const err = await callDecisionLLM(cfg, 's', 'u').catch(e => e as Error)
    expect(err.message).toContain('非 JSON')
    expect(err.message).not.toContain('sk-abcdef')
    expect(err.message).not.toContain('<html>')
  })

  it('AbortSignal 超时（DOMException name=TimeoutError）→ 转译为自定义 TimeoutError（chat-router 超时分支单源生效）', async () => {
    const domLike = new Error('The operation was aborted due to timeout')
    ;(domLike as Error & { name: string }).name = 'TimeoutError'
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(domLike))
    await expect(callDecisionLLM(cfg, 's', 'u')).rejects.toBeInstanceOf(TimeoutError)
  })

  it('200 但 content 空 / choices 缺失 → throw（推理模型 reasoning_content 陷阱防御）', async () => {
    vi.stubGlobal('fetch', mockFetchRes(true, 200, { choices: [{ message: { content: '   ' } }] }))
    await expect(callDecisionLLM(cfg, 's', 'u')).rejects.toThrow('content')
    vi.stubGlobal('fetch', mockFetchRes(true, 200, { choices: [] }))
    await expect(callDecisionLLM(cfg, 's', 'u')).rejects.toThrow('content')
  })

  it('fetch 网络异常 → 原样上抛（调用方显性处理，禁止静默回落慢路径）', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')))
    await expect(callDecisionLLM(cfg, 's', 'u')).rejects.toThrow('ECONNREFUSED')
  })
})
