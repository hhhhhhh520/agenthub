/**
 * ISSUE-028 T3：read_messages 的频道过滤条件。
 *
 * 根因：旧实现 role:'agent' 单角色过滤——盲测会话里消息全是 user/orchestrator
 * 角色，工具恒返回「暂无消息」，orchestrator 据此声称"这是我们对话的第一条消息"
 * （失忆，见 issues/ISSUE-028-decision-fallback-bypasses-trace.md 连带 bug）。
 *
 * 频道语义 = 会话全部协作发言：用户需求（user）、Orchestrator 编排发言
 * （orchestrator）、Agent 产出与讨论（agent），全角色可见。
 *
 * 独立成叶子模块：mcp-server/index.ts 是启动脚本（import 即 connect stdio），
 * 不可在测试中导入；此处提供可测的纯函数 + 供接线守卫断言的单一来源。
 */

export const CHANNEL_ROLES = ['user', 'orchestrator', 'agent'] as const

/** 构造 read_messages 的 prisma where。since 行为与旧实现一致（不校验非法时间串）。 */
export function buildChannelWhere(sessionId: string, since?: string): Record<string, unknown> {
  const where: Record<string, unknown> = { sessionId, role: { in: [...CHANNEL_ROLES] } }
  if (since) {
    where.createdAt = { gt: new Date(since) }
  }
  return where
}
