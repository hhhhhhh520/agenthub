/**
 * ISSUE-011 F1: 直接 String(reason) 对 null-prototype 对象/toString 抛异常的对象会抛 TypeError,
 * 一次怪异 rejection 会击穿整批处理。对象走 JSON.stringify 避免退化成 "[object Object]"。
 *
 * 独立成叶子模块：chat-router（ISSUE-028 回退显性化）复用时不受各测试文件
 * vi.mock('@/lib/orchestrator') 整体 mock 影响，真实现进测试。
 */
export function reasonToString(reason: unknown): string {
  if (reason instanceof Error) return reason.message || String(reason)
  try {
    if (reason !== null && typeof reason === 'object') return JSON.stringify(reason)
    return String(reason)
  } catch {
    return '[unserializable reason]'
  }
}
