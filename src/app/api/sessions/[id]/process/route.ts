import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { checkConformance, parseTrace, type StoredDecisionTraceEntry } from '@/lib/orchestrator/decision-trace'
import { discoverProcess, findVariants } from '@/lib/orchestrator/process-mining'

/**
 * P4 T4: 单会话流程挖掘消费方（checkConformance 接线 + discoverProcess/findVariants）。
 * decisionTrace 是内部 analytics（T5 已从 sessions GET/PUT/list 排除），此处是它的权威 API 通道。
 * 返回该会话的 conformance 指标 + directly-follows 图 + 变体（单 trace → 至多 1 个变体）。
 *
 * 空 trace 语义（与 /api/analytics/process 不同，pre-commit 审查记录）：entries=[]（无 applied 转移）
 * → findVariants 归入 1 个空签名变体（stateSeq:[]）——本端点视作"有 trace 但未推进"；
 * analytics 端点把 entries.length===0 的 session 视为"无 trace"跳过。消费方注意两端口径差异。
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const session = await prisma.session.findUnique({
    where: { id },
    select: { decisionTrace: true },
  })
  if (!session) {
    return NextResponse.json({ error: 'Session not found' }, { status: 404 })
  }
  const entries = parseTrace(session.decisionTrace) as StoredDecisionTraceEntry[]
  const trace = { sessionId: id, entries }
  return NextResponse.json({
    sessionId: id,
    conformance: checkConformance(entries),
    process: discoverProcess([trace]),
    variants: findVariants([trace]),
  })
}
