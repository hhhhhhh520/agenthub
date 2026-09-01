import { defineConfig } from 'vitest/config'
import path from 'path'

// P5 实验独立 vitest config：
// - test.env 设 DATABASE_URL 指向独立 p5.db（prisma 是模块加载期单例，必须在 @/lib/db 首次求值前生效）
// - testTimeout 设到小时级（60 次（4 配置 × 3 任务 × 5 seed）真实 LLM run 串行）
// - fileParallelism:false（串行，避免 on/off env 串扰 + DB 竞争）
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['**/run.test.ts', '**/setup.test.ts', '**/analyze-cross-batch.test.ts', '**/analyze-port-replay.test.ts'],
    testTimeout: 35 * 60 * 1000,      // P10 F7：比 CONFIG.timeoutMs(30min) 多 5min——内部 deadline 必先触发，kill+finally+teardown 有余量
    hookTimeout: 35 * 60 * 1000,      // beforeAll 真实 preflight，同值
    fileParallelism: false,
    env: {
      DATABASE_URL: 'file:D:/ai全栈挑战赛/agenthub/experiments/p5/p5.db', // 绝对路径，消除 cwd 歧义
    },
  },
  resolve: {
    alias: { '@': path.resolve(__dirname, '../../src') },
  },
})
