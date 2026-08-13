import type { ScheduledTask } from '../../src/lib/orchestrator/scheduler'

/** P5 执行 mock（Spec §5.2）：
 * executeTaskBatch 返回形状必须与 handleExecution 消费一致（execution.ts:292 解构 {result, sessionId}），
 * 全 SUCCESS + 4 键齐全，否则 30/30 error。
 *
 * 计划扫描修正：本任务只创建实现文件，不写独立测试文件（vitest 的 include 仅匹配 run.test.ts，
 * 其他测试文件会被挡掉）——mock 形状单测并入 Task 6 的 run.test.ts 统一写。
 */
export async function mockExecuteTaskBatch(
  tasks: ScheduledTask[],
  _agents: unknown,
  _onChunk: unknown,
  _chatSessionId?: string,
  _projectDir?: string,
  _priorResults?: unknown,
  _priorTaskMeta?: unknown
): Promise<{ results: Map<string, { result: string; sessionId?: string }>, preloadedIds: string[], failedTaskIds: string[], failedTaskReasons: Record<string, string> }> {
  const results = new Map<string, { result: string; sessionId?: string }>()
  for (const t of tasks) {
    results.set(t.id, { result: 'SUCCESS', sessionId: undefined })
  }
  return { results, preloadedIds: [], failedTaskIds: [], failedTaskReasons: {} }
}

/** monitoring 识别（execution.ts:437 用 systemPrompt '你是代码审查专家...'） */
export function isMonitoringCall(agent: { systemPrompt?: string }): boolean {
  return Boolean(agent.systemPrompt?.includes('代码审查专家'))
}

/** monitoring 固定返回不纠正（Spec §8.2：产物不可判，mock 恒 needsCorrection:false） */
export const mockMonitoringResult = JSON.stringify({ needsCorrection: false })
