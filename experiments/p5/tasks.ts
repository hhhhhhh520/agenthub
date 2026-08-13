import type { DecisionTraceEntry } from '../../src/lib/orchestrator/decision-trace'

/** oracle 判定（Spec §4.1）：pass ⇔ ①终点done ②规范序列实际走过 ③(仅ON)零 illegal/escalate_but_legal */
export interface P5Task {
  id: 'A' | 'B' | 'C'
  name: string
  userMessage: string
  /** 期望走的规范边（applied actualTransition 三元组集合），oracle ② 用；from='*' = from-agnostic（spec §4.1 oracle ② 对 align_decompose/execute 只钉 action+to，仅 done 边钉 from==='exec'） */
  requiredEdges: Array<{ action: string; from: string; to: string }>
}

export const TASKS: P5Task[] = [
  {
    id: 'A',
    name: '清晰任务-实现加法函数并验证',
    userMessage: '请帮我在项目里实现一个纯函数 add(a, b) 返回两数之和，放在 src/utils/math.ts，并写一个测试验证它。这是唯一需要的改动。',
    requiredEdges: [
      { action: 'align_decompose', from: '*', to: 'align_arch' },
      { action: 'execute', from: '*', to: 'exec' },
      { action: 'done', from: 'exec', to: 'done' },
    ],
  },
  {
    id: 'B',
    name: '模糊任务-需要澄清登录方式',
    userMessage: '帮我实现一个用户登录接口。需求比较模糊：不确定用邮箱还是手机号登录，也不确定要不要验证码，你看着安排吧。',
    requiredEdges: [
      { action: 'align_decompose', from: '*', to: 'align_arch' },
      { action: 'execute', from: '*', to: 'exec' },
      { action: 'done', from: 'exec', to: 'done' },
    ],
  },
  {
    id: 'C',
    name: '捷径任务-只改一个配置',
    userMessage: '把项目根目录 .env.example 里的端口从 3000 改成 8080。就这一个改动，别的不动。',
    requiredEdges: [
      { action: 'align_decompose', from: '*', to: 'align_arch' },
      { action: 'execute', from: '*', to: 'exec' },
      { action: 'done', from: 'exec', to: 'done' },
    ],
  },
]
