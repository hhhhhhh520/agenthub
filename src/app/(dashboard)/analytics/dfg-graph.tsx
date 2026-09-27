"use client"

import type { ProcessEdge } from "@/lib/orchestrator/process-mining"
import { STATE_LABELS } from "@/lib/process-labels"

/**
 * §4.1 G3：directly-follows 图形化（无新依赖，内联 SVG 静态布局）。
 * 6 状态按主线横向排布；主线相邻边=直线，跳步/回边=上方弧线（顶点钳制防裁切），
 * 自环=节点右侧绕行（防与节点下方信号文字重叠）；边粗细=count（封顶 6px）。
 * 数据防御：edges 来自 API 的已校验 State 值（safeTransition 预过滤）；signals 可能缺键（coalesce 兜底）。
 */

const ORDER = ["idle", "align_pm", "align_arch", "align_qa", "exec", "done"] as const

const NODE_W = 96
const NODE_H = 40
const NODE_Y = 70 // 节点顶部 y
const CX = (i: number) => 64 + i * 128 // 节点中心 x

interface Props {
  edges: ProcessEdge[]
  stateSignals: Record<string, { visits: number; escalateCount: number; correctionCount: number }>
}

export function DfgGraph({ edges, stateSignals }: Props) {
  if (edges.length === 0) {
    return <p className="text-sm text-gray-500">无实际转移</p>
  }
  const edgeCountMax = Math.max(...edges.map(e => e.count))
  const stroked = (c: number) => 1.5 + Math.min(4.5, (c / edgeCountMax) * 4.5)
  const stateText = (s: string) => STATE_LABELS[s] ?? s

  return (
    <svg viewBox="0 0 760 175" className="w-full" role="img" aria-label="directly-follows 流程图">
      <defs>
        <marker id="dfg-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
          <path d="M0,0 L8,4 L0,8 z" fill="#6b7280" />
        </marker>
      </defs>

      {edges.map(e => {
        const fi = ORDER.indexOf(e.from as (typeof ORDER)[number])
        const ti = ORDER.indexOf(e.to as (typeof ORDER)[number])
        if (fi < 0 || ti < 0) return null // 上游 safeTransition 已保证，死防御
        const sw = stroked(e.count)
        const label = `${stateText(e.from)}→${stateText(e.to)} ×${e.count}`
        if (fi === ti) {
          // 自环：节点右侧绕行（起点=右缘上部，终点=右缘下部）——避开节点下方信号文字
          const x = CX(fi) + NODE_W / 2
          const y1 = NODE_Y + 6
          const y2 = NODE_Y + NODE_H - 6
          const bulge = 26
          return (
            <g key={`${e.from}>${e.to}`}>
              <path d={`M ${x} ${y1} C ${x + bulge} ${y1}, ${x + bulge} ${y2}, ${x} ${y2}`} fill="none" stroke="#6b7280" strokeWidth={sw} markerEnd="url(#dfg-arrow)" />
              <text x={x + bulge + 6} y={(y1 + y2) / 2 + 4} className="fill-gray-500 text-[10px]">×{e.count}</text>
              <title>{label}</title>
            </g>
          )
        }
        if (ti === fi + 1) {
          // 主线直线：右缘 → 左缘
          const x1 = CX(fi) + NODE_W / 2
          const x2 = CX(ti) - NODE_W / 2
          return (
            <g key={`${e.from}>${e.to}`}>
              <line x1={x1} y1={NODE_Y + NODE_H / 2} x2={x2} y2={NODE_Y + NODE_H / 2} stroke="#6b7280" strokeWidth={sw} markerEnd="url(#dfg-arrow)" />
              <text x={(x1 + x2) / 2} y={NODE_Y + NODE_H / 2 - 6} textAnchor="middle" className="fill-gray-500 text-[10px]">×{e.count}</text>
              <title>{label}</title>
            </g>
          )
        }
        // 跳步/回边：上方弧（跨度越大弧越高，顶点钳制在画布内防裁切）
        const x1 = CX(fi) + (ti > fi ? NODE_W / 2 : -NODE_W / 2)
        const x2 = CX(ti) + (ti > fi ? -NODE_W / 2 : NODE_W / 2)
        const lift = 14 + Math.abs(ti - fi) * 8
        const apex = Math.max(10, NODE_Y / 2 - lift) // 控制点 y 不高于画布顶
        return (
          <g key={`${e.from}>${e.to}`}>
            <path d={`M ${x1} ${NODE_Y + NODE_H / 2} C ${x1} ${apex}, ${x2} ${apex}, ${x2} ${NODE_Y + NODE_H / 2}`} fill="none" stroke="#6b7280" strokeWidth={sw} markerEnd="url(#dfg-arrow)" />
            <text x={(x1 + x2) / 2} y={apex + 12} textAnchor="middle" className="fill-gray-500 text-[10px]">×{e.count}</text>
            <title>{label}</title>
          </g>
        )
      })}

      {ORDER.map((s, i) => {
        const sig = stateSignals[s] ?? { visits: 0, escalateCount: 0, correctionCount: 0 }
        const hot = sig.escalateCount > 0 || sig.correctionCount > 0
        return (
          <g key={s}>
            <rect
              x={CX(i) - NODE_W / 2}
              y={NODE_Y}
              width={NODE_W}
              height={NODE_H}
              rx={8}
              fill="#ffffff"
              stroke={sig.escalateCount > 0 ? "#d97706" : sig.correctionCount > 0 ? "#2563eb" : "#d1d5db"}
              strokeWidth={hot ? 2.5 : 1.5}
            />
            <text x={CX(i)} y={NODE_Y + 25} textAnchor="middle" className="fill-gray-700 text-[13px]">
              {stateText(s)}
            </text>
            <text x={CX(i)} y={NODE_Y + NODE_H + 14} textAnchor="middle" className="fill-gray-400 text-[10px]">
              入{sig.visits}
              {sig.escalateCount > 0 && <tspan className="fill-yellow-700"> 升{sig.escalateCount}</tspan>}
              {sig.correctionCount > 0 && <tspan className="fill-blue-700"> 纠{sig.correctionCount}</tspan>}
            </text>
          </g>
        )
      })}
    </svg>
  )
}
