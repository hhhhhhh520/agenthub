"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import { Badge } from "@/components/ui/badge"
import { STATE_LABELS, VIOLATION_LABELS } from "@/lib/process-labels"
import type { ProcessModel } from "@/lib/orchestrator/process-mining"
import { DfgGraph } from "./dfg-graph"

/**
 * P4 T6: 最小 analytics 可视化页（B 方向"可视化原型"）。
 * 渲染 /api/analytics/process 三块：conformance 指标 / directly-follows 边表 / 流程变体列表。
 * 无图库、无新依赖；数据为空显示空态。
 * §4.1 G2/G4/G5（phase3-4.1-visualization-gap.md）：casRejectCount 展示 + violations 会话归属列 +
 * 变体/会话可点击跳转（单会话追踪视图 /analytics/sessions/[id]）。
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
// process 块直接用 lib 的 ProcessModel（API 返回即 discoverProcess 产出，类型同源防漂移）
interface TraceVariant {
  id: string
  stateSeq: string[]
  count: number
  sessionIds: string[]
  correctionCount: number
  escalateCount: number
}
interface AnalyticsData {
  totalSessions: number
  tracedSessions: number
  sessions: Array<{ id: string; title: string }>
  conformance: Conformance
  process: ProcessModel
  variants: TraceVariant[]
}

function stateLabel(s: string) {
  return STATE_LABELS[s] ?? s
}

export default function AnalyticsPage() {
  const [data, setData] = useState<AnalyticsData | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    fetch("/api/analytics/process")
      .then(r => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d: AnalyticsData) => setData(d))
      .catch(e => setError(e instanceof Error ? e.message : String(e)))
  }, [])

  if (error) {
    return (
      <div className="p-6">
        <h1 className="text-xl font-semibold">流程分析</h1>
        <p className="mt-4 text-red-600">加载失败：{error}</p>
      </div>
    )
  }
  if (!data) {
    return (
      <div className="p-6">
        <h1 className="text-xl font-semibold">流程分析</h1>
        <p className="mt-4 text-gray-500">加载中...</p>
      </div>
    )
  }
  if (data.tracedSessions === 0) {
    return (
      <div className="p-6">
        <h1 className="text-xl font-semibold">流程分析</h1>
        <p className="mt-4 text-gray-500">暂无带决策轨迹的会话。跑一个协作流程后，这里会展示 conformance 指标与流程变体。</p>
      </div>
    )
  }

  const { conformance, process, variants } = data
  const ratioPct = (conformance.ratio * 100).toFixed(1)

  return (
    <div className="p-6 space-y-8">
      <header>
        <h1 className="text-xl font-semibold">流程分析</h1>
        <p className="mt-1 text-sm text-gray-500">
          基于 {data.tracedSessions}/{data.totalSessions} 个会话的决策轨迹（AgentFlow 流程挖掘：directly-follows 图 + 变体聚类 + conformance）
        </p>
      </header>

      {/* 1. conformance 指标 */}
      <section>
        <h2 className="mb-3 text-lg font-semibold">Conformance（转移一致性）</h2>
        <div className="flex flex-wrap gap-3">
          <Stat label="一致性" value={`${ratioPct}%`} hint={`${conformance.conforming}/${conformance.total}`} />
          <Stat label="升级(LLM 越界被拦)" value={String(conformance.escalateCount)} hint="A 的核心信号" />
          <Stat label="纠正" value={String(conformance.correctionCount)} hint="守卫/规范重定向" />
          <Stat label="CAS 拒绝回执" value={String(conformance.casRejectCount ?? 0)} hint="并发拒写，按设计" />
          <Stat label="转移总数" value={String(conformance.total)} />
        </div>
        {conformance.violations.length > 0 && (
          <table className="mt-4 w-full text-sm">
            <thead>
              <tr className="border-b text-left text-gray-500">
                <th className="py-2 pr-4" title="跨会话条目的全局下标（与单会话追踪页的逐会话序号不同）">全局#</th>
                <th className="py-2 pr-4">类型</th>
                <th className="py-2 pr-4">转移</th>
                <th className="py-2 pr-4">会话</th>
                <th className="py-2">详情</th>
              </tr>
            </thead>
            <tbody>
              {conformance.violations.map(v => {
                const vc = VIOLATION_LABELS[v.kind] ?? { text: v.kind, color: "bg-gray-100 text-gray-700" }
                return (
                  <tr key={v.index} className="border-b">
                    <td className="py-2 pr-4 text-gray-500">{v.index}</td>
                    <td className="py-2 pr-4"><Badge className={vc.color}>{vc.text}</Badge></td>
                    <td className="py-2 pr-4 font-mono">{stateLabel(v.from)} + {v.action} → {stateLabel(v.to)}</td>
                    <td className="py-2 pr-4">
                      {v.sessionId ? (
                        <Link href={`/analytics/sessions/${v.sessionId}`} className="font-mono text-xs text-blue-600 hover:underline">
                          {v.sessionId.slice(0, 8)}…
                        </Link>
                      ) : (
                        <span className="text-gray-400">—</span>
                      )}
                    </td>
                    <td className="py-2 text-gray-600">{v.detail}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </section>

      {/* 2. directly-follows 图 */}
      <section>
        <h2 className="mb-3 text-lg font-semibold">Directly-Follows 图（流程转移频次）</h2>
        <DfgGraph edges={process.edges} stateSignals={process.stateSignals} />
        <h3 className="mb-2 mt-4 text-sm font-medium text-gray-600">边表明细</h3>
        {process.edges.length === 0 ? (
          <p className="text-sm text-gray-500">无实际转移</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-gray-500">
                <th className="py-2 pr-4">#</th>
                <th className="py-2 pr-4">从</th>
                <th className="py-2 pr-4">动作</th>
                <th className="py-2 pr-4">到</th>
                <th className="py-2">次数</th>
              </tr>
            </thead>
            <tbody>
              {process.edges.map((e, i) => (
                <tr key={`${e.from}>${e.to}`} className="border-b">
                  <td className="py-2 pr-4 text-gray-500">{i + 1}</td>
                  <td className="py-2 pr-4">{stateLabel(e.from)}</td>
                  <td className="py-2 pr-4 font-mono text-gray-600">→</td>
                  <td className="py-2 pr-4">{stateLabel(e.to)}</td>
                  <td className="py-2"><Badge>{e.count}</Badge></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div className="mt-4">
          <h3 className="mb-2 text-sm font-medium text-gray-600">每状态信号（升级/纠正叠加在图上）</h3>
          <div className="flex flex-wrap gap-2">
            {Object.entries(process.stateSignals).map(([state, s]) => (
              <span key={state} className="rounded border px-2 py-1 text-xs text-gray-600">
                {stateLabel(state)}：入 {s.visits}
                {s.escalateCount > 0 && <span className="ml-1 text-yellow-700">升 {s.escalateCount}</span>}
                {s.correctionCount > 0 && <span className="ml-1 text-blue-700">纠 {s.correctionCount}</span>}
              </span>
            ))}
          </div>
        </div>
      </section>

      {/* 3. 流程变体 */}
      <section>
        <h2 className="mb-3 text-lg font-semibold">流程变体（{variants.length}）</h2>
        <div className="space-y-3">
          {variants.map(v => (
            <div key={v.id} className="rounded border p-3">
              <div className="flex flex-wrap items-center gap-2">
                <Badge>{v.id}</Badge>
                <span className="text-sm font-medium">{v.stateSeq.length === 0 ? "（无推进）" : v.stateSeq.map(stateLabel).join(" → ")}</span>
                <span className="text-sm text-gray-500">× {v.count}</span>
                {v.correctionCount > 0 && <Badge className="bg-blue-100 text-blue-800">纠正 {v.correctionCount}</Badge>}
                {v.escalateCount > 0 && <Badge className="bg-yellow-100 text-yellow-800">升级 {v.escalateCount}</Badge>}
              </div>
              <p className="mt-1 text-xs text-gray-400">
                会话：
                {v.sessionIds.length > 0
                  ? v.sessionIds.map((sid, si) => (
                      <span key={sid}>
                        {si > 0 && "、"}
                        <Link href={`/analytics/sessions/${sid}`} className="font-mono text-blue-600 hover:underline">
                          {sid.slice(0, 8)}…
                        </Link>
                      </span>
                    ))
                  : "—"}
              </p>
            </div>
          ))}
        </div>
      </section>

      {/* 4. 会话列表（§4.1 G5：会话 → 单会话追踪视图的导航入口） */}
      <section>
        <h2 className="mb-3 text-lg font-semibold">会话（{data.sessions.length}）</h2>
        {data.sessions.length === 0 ? (
          <p className="text-sm text-gray-500">无带决策轨迹的会话</p>
        ) : (
          <div className="max-h-72 space-y-1 overflow-y-auto rounded border p-2">
            {data.sessions.map(s => (
              <Link
                key={s.id}
                href={`/analytics/sessions/${s.id}`}
                className="block rounded px-2 py-1 text-sm hover:bg-gray-50"
              >
                <span>{s.title || "（无标题）"}</span>
                <span className="ml-2 font-mono text-xs text-gray-400">{s.id.slice(0, 8)}…</span>
              </Link>
            ))}
          </div>
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
