/**
 * ISSUE-028 T2：决策/分析类结构化 LLM 调用的快模型通道（OpenAI 兼容直连）。
 *
 * 根因：决策调用（getOrchestratorDecision/callLLM）此前共用执行 agent 线路
 * （mimo-v2.6-flash，推理模型）——推理长 + JSON 输出不稳定，TIMEOUT.LLM_CALL(2min)
 * 与网关 60s 叠加，parseJSON 频繁失败（曾致 chat-router 静默回退，见 ISSUE-028）。
 *
 * 通道设计：
 * - 设 env AGENTHUB_DECISION_MODEL 即启用（非推理快模型，如 qwen3.8-flash）；
 * - 凭据：AGENTHUB_DECISION_BASE_URL / AGENTHUB_DECISION_API_KEY 显式优先，
 *   缺省复用 orchestrator agent 的 baseUrl/apiKey（DB 通道，key 不经磁盘）；
 * - 未设 env → readDecisionModelEnv 返回 null，调用方走原 adapter/CLI 路径（行为不变对照）；
 * - 已设但调用失败 → 原样上抛（不静默回落慢路径，让上层显性处理）。
 */

import { TIMEOUT, TimeoutError } from './timeout'

export interface DecisionLLMConfig {
  baseUrl: string
  apiKey: string
  model: string
}

/** 读决策模型 env；未设/空白 → null（快通道关闭，走原路径） */
export function readDecisionModelEnv(): string | null {
  const model = process.env.AGENTHUB_DECISION_MODEL?.trim()
  return model || null
}

/**
 * 拼 OpenAI 兼容 chat/completions 端点：
 * 已带 /chat/completions → 原样；路径以 /v1 结尾 → 补 /chat/completions；
 * 其余（裸域或自定义前缀）→ 补 /v1/chat/completions。
 */
export function openAiChatUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '')
  if (trimmed.endsWith('/chat/completions')) return trimmed
  if (/\/v1$/.test(trimmed)) return `${trimmed}/chat/completions`
  return `${trimmed}/v1/chat/completions`
}

/** scheme 校验（与 adapter 层 assertSafeBaseUrl 同规则）：https 任意，http 仅回环 */
function assertSafeBaseUrl(baseUrl: string): void {
  let url: URL
  try {
    url = new URL(baseUrl)
  } catch {
    throw new Error(`决策快模型 baseUrl 不合法: ${baseUrl}`)
  }
  const host = url.hostname.toLowerCase()
  const isLoopback = host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]'
  if (url.protocol === 'https:' || (url.protocol === 'http:' && isLoopback)) return
  throw new Error(`决策快模型 baseUrl 不安全（仅 https 或 http 回环）: ${baseUrl}`)
}

/**
 * 决策 LLM 配置解析。env 显式注入优先，缺省复用 orchestrator agent 凭据。
 * 凭据缺失 → null（快通道关闭）；scheme 不安全 → throw（已设模型却悄悄走慢路径
 * 会复活 ISSUE-028 的慢决策，宁可 fail-loud 让 env 配置问题立刻显形）。
 */
export function resolveDecisionLLMConfig(
  model: string,
  orch: { baseUrl?: string | null; apiKey?: string | null }
): DecisionLLMConfig | null {
  if (!model) return null
  const baseUrl = process.env.AGENTHUB_DECISION_BASE_URL?.trim() || orch.baseUrl?.trim() || ''
  const apiKey = process.env.AGENTHUB_DECISION_API_KEY?.trim() || orch.apiKey?.trim() || ''
  if (!baseUrl || !apiKey) return null
  assertSafeBaseUrl(baseUrl)
  return { baseUrl, apiKey, model }
}

/**
 * OpenAI 兼容 /chat/completions 非流式调用。
 * 非 2xx / 空 content（含推理模型只回 reasoning_content 的形态）→ throw。
 */
/**
 * 网关错误响应体可能回显 API key（401/403 常见）——进异常消息前脱敏。
 * 异常消息会经 reasonToString 进持久化 trace 并渲染到 analytics 页（审查 🟡 泄漏链）。
 */
function sanitizeGatewayBody(text: string): string {
  return text.replace(/(Bearer\s+)?sk-[A-Za-z0-9_-]{6,}/gi, 'sk-***')
}

export async function callDecisionLLM(
  cfg: DecisionLLMConfig,
  systemPrompt: string,
  userPrompt: string
): Promise<string> {
  // redirect:'error'——默认 follow 会让 https 入口被 302 降级到任意 http 目标，
  // 绕过下方 scheme 校验对"实际请求终点"的约束（审查 🟡）。
  let res: Response
  try {
    res = await fetch(openAiChatUrl(cfg.baseUrl), {
      method: 'POST',
      redirect: 'error',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify({
        model: cfg.model,
        temperature: 0.2,
        max_tokens: 8192,
        // 关闭混合思考模型的思考模式（Qwen3 系参数，tokenrhythm 后端识别；不识别的网关多忽略之）。
        // 思考对结构化决策无益：探针实测同 prompt 关思考 5.0s vs 带思考 45.7s，且思考耗尽
        // max_tokens 会让 content 为空（finish_reason=length）——ISSUE-028 验收实测根因。
        enable_thinking: false,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
      }),
      signal: AbortSignal.timeout(TIMEOUT.LLM_CALL),
    })
  } catch (err) {
    // AbortSignal.timeout 触发的是 DOMException(name='TimeoutError')，不是自定义
    // TimeoutError——不转译会被 chat-router 错诊为"解析失败"再叠一轮 CLI 直连（审查 🟡）。
    if (err instanceof TimeoutError || (err as { name?: string } | null)?.name === 'TimeoutError') {
      throw new TimeoutError(TIMEOUT.LLM_CALL, 'callDecisionLLM')
    }
    throw err
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`决策快模型 HTTP ${res.status}: ${sanitizeGatewayBody(body).slice(0, 200)}`)
  }
  let data: { choices?: Array<{ finish_reason?: string; message?: { content?: unknown } }> }
  try {
    data = await res.json()
  } catch {
    // HTML 错误页等非 JSON 响应：SyntaxError message 会带响应体片段（可能含 key 回显），收敛为通用消息
    throw new Error(`决策快模型响应非 JSON（HTTP ${res.status}）`)
  }
  const choice = data?.choices?.[0]
  const content = choice?.message?.content
  if (typeof content !== 'string' || !content.trim()) {
    // 空 content 的头号根因（验收实测）：混合思考模型的思考耗尽 max_tokens（finish_reason=length），
    // reasoning_content 有内容而 content 为空——把 finish_reason 带出来，别让下个人再猜
    const finishReason = (choice?.finish_reason ?? 'unknown').toString().slice(0, 40)
    const hint = finishReason === 'length' ? '，思考耗尽 max_tokens' : ''
    throw new Error(`决策快模型返回空 content（finish_reason=${finishReason}${hint}）`)
  }
  return content
}
