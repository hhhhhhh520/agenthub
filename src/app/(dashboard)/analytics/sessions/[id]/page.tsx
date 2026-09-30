"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import { Badge } from "@/components/ui/badge"
import { STATE_LABELS, VIOLATION_LABELS } from "@/lib/process-labels"

/**
 * §4.1 G1：单会话追踪视图（phase3-4.1-visualization-gap.md）。
 * 消费 /api/sessions/[id]/process（entries 为 G1 新增字段），核心是纠偏时间线：
 * 每个决策条目回答"AI 想干什么 → 被什么机制拦住 → 实际走了哪一步"。
 * 验收（roadmap §4.1）：随机 3 个真实会话，仅用 dashboard，5 分钟内说清跑偏点与拦截机制。
 * 数据防御：entries 来自 parseTrace（形状不保证，decision-trace.ts 契约"消费方自行逐元素防御"）。
 */

interface ConformanceViolation {
  index: number
  kind: string
  from: string
  action: string
  to: string
  detail: string
  sessionId?: string | null
}
interface Conformance {
  total: number
  conforming: number
  escalateCount: number
  correctionCount: number
  casRejectCount: number
  ratio: number
  violations: ConformanceViolation[]
}
interface TimelineEntry {
  ts?: string
  decisionPoint?: string
  llmProposal?: { action?: string; target?: string | null; targets?: string[] | null; reason?: string }
  corrections?: Array<{ from?: string; to?: string; reason?: string }>
  actualTransition?: { from?: string; to?: string; action?: string; applied?: boolean; escalated?: boolean; casRejected?: boolean }
}

/** 状态文本安全化：entries 来自 parseTrace 原始透传（元素形状不保证），对象/数组值不得进 React child */
function safeText(v: unknown): string {
  return typeof v === "string" ? v : ""
}
interface SessionProcessData {
  sessionId: string
  entries: TimelineEntry[]
  conformance: Conformance
}

function stateLabel(s?: string) {
  if (typeof s !== "string") return "?"
  return STATE_LABELS[s] ?? s
}

/** violation kind → 徽标样式（单会话端点的 violations[].index 与 entries 下标一一对应） */
function violationBadge(kind: string) {
  const vc = VIOLATION_LABELS[kind] ?? { text: kind, color: "bg-gray-100 text-gray-700" }
  return <Badge className={vc.color}>{vc.text}</Badge>
}

/** 一条时间线卡片右侧的"实际转移"徽标：优先级 casRejected > violation > escalated/applied */
function outcomeBadge(e: TimelineEntry, violation?: ConformanceViolation) {
  if (e.actualTransition?.casRejected === true) {
    return <Badge className="bg-gray-100 text-gray-600">CAS 拒绝回执（并发拒写，按设计）</Badge>
  }
  if (violation) return violationBadge(violation.kind)
  if (e.actualTransition?.escalated === true) {
    return <Badge className="bg-yellow-100 text-yellow-800">LLM 越界被拦</Badge>
  }
  if (e.actualTransition?.applied === true) {
    return <Badge className="bg-green-100 text-green-800">已应用</Badge>
  }
  return <Badge className="bg-gray-100 text-gray-600">未应用</Badge>
}

export default function SessionTracePage({ params }: { params: Promise<{ id: string }> }) {
  const [id, setId] = useState<string | null>(null)
  const [data, setData] = useState<SessionProcessData | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    params.then(p => setId(p.id))
  }, [params])

  useEffect(() => {
    if (!id) return
    fetch(`/api/sessions/${id}/process`)
      .then(r => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d: SessionProcessData) => setData(d))
      .catch(e => setError(e instanceof Error ? e.message : String(e)))
  }, [id])

  if (error) {
    return (
      <div className="p-6">
        <h1 className="text-xl font-semibold">会话追踪</h1>
        <p className="mt-4 text-red-600">加载失败：{error}</p>
      </div>
    )
  }
  if (!data) {
    return (
      <div className="p-6">
        <h1 className="text-xl font-semibold">会话追踪</h1>
        <p className="mt-4 text-gray-500">加载中...</p>
      </div>
    )
  }

  const { entries, conformance } = data
  // index→violation 映射（单会话端点：checkConformance(entries) 的 index 即 entries 下标）
  const violationByIndex = new Map(conformance.violations.map(v => [v.index, v]))
  const ratioPct = (conformance.ratio * 100).toFixed(1)

  return (
    <div className="p-6 space-y-6">
      <header className="flex flex-wrap items-center gap-3">
        <Link
          href="/analytics"
          className="rounded-lg border border-border bg-background px-2.5 py-1.5 text-sm text-gray-600 hover:bg-muted"
        >
          ← 返回流程分析
        </Link>
        <h1 className="text-xl font-semibold">会话追踪</h1>
        <code className="text-xs text-gray-400">{data.sessionId}</code>
      </header>

      {/* conformance 指标 */}
      <section className="flex flex-wrap gap-3">
        <Stat label="一致性" value={`${ratioPct}%`} hint={`${conformance.conforming}/${conformance.total}`} />
        <Stat label="LLM 越界被拦" value={String(conformance.escalateCount)} />
        <Stat label="纠正/重定向" value={String(conformance.correctionCount)} />
        <Stat label="CAS 拒绝回执" value={String(conformance.casRejectCount)} hint="并发拒写，按设计" />
        <Stat label="转移总数" value={String(conformance.total)} />
      </section>

      {/* 纠偏时间线 */}
      <section>
        <h2 className="mb-3 text-lg font-semibold">决策时间线（{entries.length} 条，按发生顺序）</h2>
        {entries.length === 0 ? (
          <p className="text-sm text-gray-500">
            该会话没有决策轨迹：要么尚未跑协作流程，要么轨迹为空（两者在本页表现一致，区别见聚合页口径）。
          </p>
        ) : (
          <ol className="space-y-3">
            {entries.map((e, i) => {
              // parseTrace 契约"元素形状不校验"（decision-trace.ts）：null/非对象渲染占位卡，
              // 不 filter（保持下标与 violationByIndex 对齐）
              if (!e || typeof e !== "object") {
                return (
                  <li key={i} className="rounded border border-dashed p-3">
                    <span className="font-mono text-xs text-gray-400">#{i + 1}</span>
                    <Badge className="ml-2 bg-gray-200 text-gray-700">畸形条目</Badge>
                  </li>
                )
              }
              const violation = violationByIndex.get(i)
              const at = e.actualTransition
              const corrections = Array.isArray(e.corrections) ? e.corrections : []
              const dp = safeText(e.decisionPoint)
              const proposal = e.llmProposal && typeof e.llmProposal === "object" ? e.llmProposal : {}
              const targets = Array.isArray(proposal.targets) ? proposal.targets.filter(t => typeof t === "string") : []
              return (
                <li key={i} className="rounded border p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-xs text-gray-400">#{i + 1}</span>
                    {safeText(e.ts) && <span className="font-mono text-xs text-gray-400">{safeText(e.ts)}</span>}
                    {dp && (
                      <Badge className={dp === "handleOrchestratorDecision" ? "bg-indigo-100 text-indigo-800" : dp === "decision-fallback" ? "bg-amber-100 text-amber-800" : "bg-slate-100 text-slate-600"}>
                        {dp === "handleOrchestratorDecision" ? "LLM 决策" : dp === "transitionPhase" ? "代码补记转移" : dp === "decision-fallback" ? "决策失败回退" : dp}
                      </Badge>
                    )}
                    {outcomeBadge(e, violation)}
                  </div>
                  <div className="mt-2 text-sm">
                    <span className="text-gray-500">提议：</span>
                    <span className="font-mono">{safeText(proposal.action) || "?"}</span>
                    {safeText(proposal.target) && <span className="text-gray-500"> → {safeText(proposal.target)}</span>}
                    {targets.length > 0 && <span className="text-gray-500"> → {targets.join("、")}</span>}
                    {safeText(proposal.reason) && <span className="ml-2 text-gray-500">（{safeText(proposal.reason)}）</span>}
                  </div>
                  {corrections.length > 0 && (
                    <div className="mt-1 text-sm">
                      <span className="text-blue-700">被守卫/规范重定向：</span>
                      {corrections.map((c, ci) => {
                        const cr = c && typeof c === "object" ? c : {}
                        return (
                          <span key={ci} className="ml-2 text-blue-700">
                            {stateLabel(cr.from)} → {stateLabel(cr.to)}
                            {safeText(cr.reason) ? `（${safeText(cr.reason)}）` : ""}
                          </span>
                        )
                      })}
                    </div>
                  )}
                  <div className="mt-1 text-sm">
                    <span className="text-gray-500">实际：</span>
                    <span className="font-mono">
                      {stateLabel(at?.from)} {at?.applied ? "→" : "⇢"} {stateLabel(at?.to)}
                    </span>
                    {at?.applied === false && !at?.escalated && at?.casRejected !== true && (
                      <span className="ml-2 text-xs text-gray-400">（转移未落库）</span>
                    )}
                  </div>
                </li>
              )
            })}
          </ol>
        )}
      </section>
    </div>
  )
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded border px-4 py-3">
      <div className="text-2xl font-semibold">{value}</div>
      <div className="text-xs text-gray-500">{label}</div>
      {hint && <div className="mt-0.5 text-xs text-gray-400">{hint}</div>}
    </div>
  )
}
