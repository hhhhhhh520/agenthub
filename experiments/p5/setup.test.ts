import { describe, it, expect, vi, afterAll, beforeEach } from 'vitest'

// —— P6 A4 upsert 守卫：mock @/lib/db（db.ts 模块级 PrismaClient 单例，不 mock 会真实构造 libsql adapter）——
// GLM_MODEL/GLM_BASE_URL 置空放 vi.hoisted（先于 config.ts 模块求值），保证 CONFIG.model 与 baseUrl 走默认钉死值；
// 不用真实 key——GLM_API_KEY 只 stub 'fake-key'，测试永不触碰真实 key（feedback_test_real_apikey_ban）
const env = vi.hoisted(() => {
  const orig = { GLM_MODEL: process.env.GLM_MODEL, GLM_BASE_URL: process.env.GLM_BASE_URL, GLM_API_KEY: process.env.GLM_API_KEY }
  process.env.GLM_MODEL = ''
  process.env.GLM_BASE_URL = ''
  return { orig, upsert: vi.fn() }
})
vi.mock('@/lib/db', () => ({
  prisma: { agent: { upsert: env.upsert } },
}))

import { CONFIG } from './config'
import { assertCliConfigDir, ensureExperimentAgents, isValidModelId } from './setup'

afterAll(() => {
  // 防御：同 worker 顺序执行时恢复 env，不污染其他文件（含 GLM_API_KEY——throw 测试会改它）
  for (const k of ['GLM_MODEL', 'GLM_BASE_URL', 'GLM_API_KEY'] as const) {
    if (env.orig[k] === undefined) delete process.env[k]
    else process.env[k] = env.orig[k]
  }
})

describe('P6 A4: ensureExperimentAgents upsert 守卫（二次运行刷新 model/baseUrl/apiKey）', () => {
  beforeEach(() => {
    vi.stubEnv('GLM_API_KEY', 'fake-key')
    vi.stubEnv('GLM_BASE_URL', '')
    vi.stubEnv('GLM_MODEL', '') // 默认钉死值；override 测试单独设置
    env.upsert.mockClear()
  })

  it('CONFIG 默认钉死 deepseek-v4-flash（P6 模型钉死，GLM_MODEL env 可覆盖）', () => {
    expect(CONFIG.model).toBe('deepseek-v4-flash')
  })

  it('GLM_MODEL env 覆盖默认（CONFIG.model 以 env 为准）', async () => {
    vi.stubEnv('GLM_MODEL', 'glm-4.7-flash')
    vi.resetModules()
    const { CONFIG: c2 } = await import('./config')
    expect(c2.model).toBe('glm-4.7-flash')
  })

  it('预置已存在 agent（旧 model）→ upsert update 携带新 model/baseUrl/apiKey，不再空子句', async () => {
    // 模拟二次运行：agent 已存在，upsert 走 update 分支（若 update 空子句会保留旧 model/baseUrl——这正是 A4 修的 bug）
    env.upsert.mockImplementation(async ({ create }: any) => ({
      id: 'agent-1',
      name: create.name,
      model: 'glm-4.7-flash', // 旧 model
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4', // 旧智谱端点
      apiKey: 'old-key',
    }))
    await ensureExperimentAgents()
    expect(env.upsert).toHaveBeenCalledTimes(4) // 产品经理/架构师/后端工程师/测试工程师
    for (const [args] of env.upsert.mock.calls) {
      expect(args.where).toHaveProperty('name')
      // update 与 create 同构：模型钉死 + 默认端点 + env key
      expect(args.update).toEqual({
        model: 'deepseek-v4-flash',
        baseUrl: 'https://opencode.ai/zen/go',
        apiKey: 'fake-key',
      })
      expect(args.create).toMatchObject({
        model: 'deepseek-v4-flash',
        baseUrl: 'https://opencode.ai/zen/go',
        apiKey: 'fake-key',
      })
      // 回归守卫：update 非空对象（旧 update:{} 是错配根因）
      expect(Object.keys(args.update).length).toBeGreaterThan(0)
    }
  })

  it('GLM_BASE_URL env 覆盖默认端点（baseUrl 以 env 为准）', async () => {
    vi.stubEnv('GLM_BASE_URL', 'https://custom.example/v1')
    await ensureExperimentAgents()
    const [args] = env.upsert.mock.calls[0]!
    expect(args.update.baseUrl).toBe('https://custom.example/v1')
    expect(args.create.baseUrl).toBe('https://custom.example/v1')
  })

  it('GLM_API_KEY 缺失 → throw（顶部守卫，key 永不硬编码）', async () => {
    vi.stubEnv('GLM_API_KEY', '') // 空串过不了 !key.trim() 守卫；不用 raw delete（避免漏恢复）
    await expect(ensureExperimentAgents()).rejects.toThrow('GLM_API_KEY env 未设置')
  })

  it('畸形 GLM_MODEL → ensureExperimentAgents throw（F2 模型 ID 入口闸门，upsert 前拦截）', async () => {
    // P9-乙 T4：模型 ID 真实流向 GLM_MODEL→CONFIG.model→ensureExperimentAgents upsert→spawn，
    // 畸形 ID（cmd.exe 元字符）即注入面——入口闸门必须在 upsert 前拦下。
    // CONFIG 是模块级常量：resetModules 后必须用新注册表里的 ensureExperimentAgents，
    // 顶层绑定仍指向旧模块实例（旧 CONFIG.model 合法），调它会误放行
    vi.stubEnv('GLM_MODEL', 'a;rm -rf')
    vi.resetModules()
    const { CONFIG: c2 } = await import('./config')
    const { ensureExperimentAgents: ea2 } = await import('./setup')
    expect(c2.model).toBe('a;rm -rf') // 前置：新实例的 CONFIG.model 确被 env 覆盖为畸形值（ea2 内引用同实例）
    await expect(ea2()).rejects.toThrow('model ID')
    expect(env.upsert).not.toHaveBeenCalled() // 闸门在 upsert 之前
    vi.resetModules()
  })
})

// —— P9-乙 T4: 运行纪律硬化——纯函数单测（白名单包含判定逐字采用 brief 审查 F 必修版反例）——
describe('P9-乙 T4: 运行纪律硬化', () => {
  it('preflight 断言 CLAUDE_CONFIG_DIR 白名单包含判定（F3，审查 F 必修版）', () => {
    // 实现 = resolve 后必须等于或位于 experiments/p5 之内（白名单前缀，非子串猜测）
    expect(() => assertCliConfigDir(undefined)).toThrow()
    expect(() => assertCliConfigDir('C:\\Users\\18387\\.claude')).toThrow()      // 用户默认（反斜杠）
    expect(() => assertCliConfigDir('C:/Users/18387/.claude')).toThrow()        // 用户默认（正斜杠——原方案 fail-open 实锤反例）
    expect(() => assertCliConfigDir('~/.claude')).toThrow()                     // 家目录形态
    expect(() => assertCliConfigDir('C:\\Users\\p5fan\\.claude')).toThrow()     // 用户名恰含 p5 的击穿反例
    expect(() => assertCliConfigDir('D:\\ai全栈挑战赛\\agenthub\\experiments\\p5\\.claude-cfg')).not.toThrow()
    expect(() => assertCliConfigDir('D:/ai全栈挑战赛/agenthub/experiments/p5/.claude-cfg')).not.toThrow()
  })
  it('候选模型 ID 白名单校验（F2）', () => {
    expect(isValidModelId('xopdeepseekv4flash0731')).toBe(true)
    expect(isValidModelId('stealth/ox-alpha')).toBe(true)
    expect(isValidModelId('deepseek-v4-flash')).toBe(true)
    for (const bad of ['a;rm -rf', 'x"&&calc', 'a b', '中文模型', 'id\ninjection', '%PATH%', 'a^b', 'x|y', '`id`'])
      expect(isValidModelId(bad)).toBe(false)
  })
})
