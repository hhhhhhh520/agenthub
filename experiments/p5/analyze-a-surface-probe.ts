export type State = 'idle' | 'align_pm' | 'align_arch' | 'align_qa' | 'exec' | 'done'
export type Action = 'self' | 'delegate' | 'discuss' | 'align_confirm' | 'align_decompose' | 'align_qa' | 'execute' | 'verify' | 'done'
export const MAX_TRACE = 500
export const NON_TRANSITIONING: ReadonlySet<Action> = new Set(['self', 'delegate', 'discuss', 'verify'])
// 内联副本：与 src/lib/orchestrator/state-machine.ts TRANSITIONS 逐字一致（漂移测试守护）
export const TRANSITIONS: Record<State, Partial<Record<Action, State>>> = {
  idle: { align_confirm: 'align_pm', align_decompose: 'align_arch', execute: 'exec', done: 'done' },
  align_pm: { align_decompose: 'align_arch', align_confirm: 'align_pm' },
  align_arch: { align_qa: 'align_qa', execute: 'exec', align_decompose: 'align_arch' },
  align_qa: { execute: 'exec', align_qa: 'align_qa', align_decompose: 'align_arch' },
  exec: { done: 'done', execute: 'exec', align_decompose: 'align_arch' },
  done: { align_confirm: 'align_pm', align_decompose: 'align_arch', execute: 'exec', done: 'done' },
}
export function seqgatePredicate(state: string, action: string, taskCount: number): boolean {
  return state === 'idle' && action === 'done' && taskCount === 0
}
