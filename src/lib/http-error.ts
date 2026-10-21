export async function assertOkResponse(res: Response, fallback: string): Promise<Response> {
  if (res.ok) return res

  let detail = ''
  try {
    const data = await res.clone().json() as { error?: unknown }
    if (typeof data?.error === 'string' && data.error) detail = data.error
  } catch {
    // 非 JSON 错误体不直接展示（可能是 HTML/网关文本），统一用调用方 fallback。
  }

  throw new Error(`${detail || fallback} (${res.status})`)
}
