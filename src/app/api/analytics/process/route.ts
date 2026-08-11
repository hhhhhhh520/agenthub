import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { checkConformance, parseTrace, type StoredDecisionTraceEntry } from '@/lib/orchestrator/decision-trace'
import { discoverProcess, findVariants, type SessionTrace } from '@/lib/orchestrator/process-mining'

/**
 * P4 T4: 跨会话流程挖掘（B 方向的聚合消费方）。
 * 遍历全部有决策轨迹的 session，聚合 checkConformance + discoverProcess + findVariants。
 * totalSessions=全部会话数, tracedSessions=有非空 trace 的会话数（用于评估覆盖率）。
 *
 * 已知边界（pre-commit 审查记录）：
 * - 只扫最近 1000 个 traced session（按 updatedAt 降序 take）——dev 工具的安全阀，防全表无界放大；
 *   超出的 session 不入挖掘，覆盖率口径以 tracedSessions 为准
 * - 聚合 checkConformance 把跨 session 条目拍平成一条流：violations[].index 是全局下标、
 *   ratio 是全局混合比（非逐 session 平均），且 violations 不含 sessionId——消费方需自行定位归属
 * - 空 trace 语义与单会话端点不同：per-session 把 entries=[] 视为"1 个空签名变体"，
 *   本端点把 entries.length===0 的 session 视为"无 trace"跳过（见 /api/sessions/[id]/process 注释）
 */
export async function GET() {
  const totalSessions = await prisma.session.count()
  const tracedSessions = await prisma.session.findMany({
    where: { decisionTrace: { not: '[]' } },
    orderBy: { updatedAt: 'desc' },
    take: 1000,
    select: { id: true, title: true, decisionTrace: true },
  })

  const traces: SessionTrace[] = []
  const allEntries: StoredDecisionTraceEntry[] = []
  const sessions: Array<{ id: string; title: string }> = []
  for (const s of tracedSessions) {
    const entries = parseTrace(s.decisionTrace) as StoredDecisionTraceEntry[]
    if (entries.length === 0) continue // 非空但畸形 → 跳过，不计入 tracedSessions
    traces.push({ sessionId: s.id, entries })
    // 循环 push 而非 spread(...entries)——防单 session 超长数组击穿 V8 参数上限（攻击者审查 ⚠️）
    for (const entry of entries) allEntries.push(entry)
    sessions.push({ id: s.id, title: s.title })
  }

  return NextResponse.json({
    totalSessions,
    tracedSessions: traces.length,
    sessions,
    conformance: checkConformance(allEntries),
    process: discoverProcess(traces),
    variants: findVariants(traces),
  })
}
