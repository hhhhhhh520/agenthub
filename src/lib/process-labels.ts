/**
 * §4.1：流程分析页共享的状态/违规标签（G1 单会话视图、G3 DFG、G4 变体跳转共用）。
 * 从 analytics/page.tsx 的本地常量抽出（G4 改造时聚合页换 import，消除两份定义漂移）。
 */

export const STATE_LABELS: Record<string, string> = {
  idle: "空闲",
  align_pm: "需求确认",
  align_arch: "架构拆解",
  align_qa: "对齐问答",
  exec: "执行中",
  done: "已完成",
}

export const VIOLATION_LABELS: Record<string, { text: string; color: string }> = {
  escalate: { text: "LLM 越界被拦", color: "bg-yellow-100 text-yellow-800" },
  escalate_but_legal: { text: "代码误拦(漂移)", color: "bg-red-100 text-red-800" },
  illegal_transition: { text: "记录非法转移(漂移)", color: "bg-red-100 text-red-800" },
  malformed: { text: "畸形条目", color: "bg-gray-200 text-gray-700" },
}
