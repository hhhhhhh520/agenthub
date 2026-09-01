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
import { assertCliConfigDir, detectPreflightError, ensureExperimentAgents, isValidModelId, scrubInheritedProviderEnv, setupExperiment } from './setup'

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

// —— P9-乙 T5-1: 继承 provider env 清洗（Gate 冒烟 401 根因修复，ISSUE-013）——
describe('P9-乙 T5-1: scrubInheritedProviderEnv', () => {
  it('清除全部 ANTHROPIC_*/CLAUDE_*（豁免 CLAUDE_CONFIG_DIR）与 CLAUDECODE，不动 GLM_*/业务变量', () => {
    // 污染集 = 交互式 Claude Code 会话（qwen 代理 settings env 块）泄漏进子进程的真实形态
    process.env.ANTHROPIC_AUTH_TOKEN = 'PROXY_MANAGED'
    process.env.ANTHROPIC_MODEL = 'glm-5.3-flash[1m]'
    process.env.ANTHROPIC_DEFAULT_OPUS_MODEL_NAME = 'qwen3.8-max'
    process.env.ANTHROPIC_API_KEY = 'stale-key'
    process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:15721'
    process.env.CLAUDECODE = '1'
    process.env.CLAUDE_CODE_CHILD_SESSION = '1'
    process.env.CLAUDE_CODE_EFFORT_LEVEL = 'max'
    process.env.CLAUDE_PID = '12060'
    // 豁免/无关变量
    process.env.CLAUDE_CONFIG_DIR = 'D:/ai全栈挑战赛/agenthub/experiments/p5/.claude-cfg'
    process.env.GLM_MODEL_KEEP_TEST = 'keep-me'
    const scrubbed = scrubInheritedProviderEnv()
    for (const k of ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL_NAME', 'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'CLAUDECODE', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_EFFORT_LEVEL', 'CLAUDE_PID'])
      expect(process.env[k]).toBeUndefined()
    // CLAUDE_CONFIG_DIR 是唯一保留的 CLAUDE_*（F3 断言与 CLI 子进程隔离目录依赖它）
    expect(process.env.CLAUDE_CONFIG_DIR).toBe('D:/ai全栈挑战赛/agenthub/experiments/p5/.claude-cfg')
    expect(process.env.GLM_MODEL_KEEP_TEST).toBe('keep-me')
    expect(scrubbed).toContain('ANTHROPIC_AUTH_TOKEN')
    // 幂等：再跑一次不 throw、不再报同样的键
    expect(scrubbed).not.toContain('GLM_MODEL_KEEP_TEST')
    expect(() => scrubInheritedProviderEnv()).not.toThrow()
    delete process.env.CLAUDE_CONFIG_DIR
    delete process.env.GLM_MODEL_KEEP_TEST
  })

  it('setupExperiment 接线：先清洗后断言（顺序钉死，非恒真断言）', async () => {
    // 污染态 + 非法 CLAUDE_CONFIG_DIR → setupExperiment 应在 F3 断言处 throw；
    // 若 scrub 真在 assert 之前执行，throw 时 AUTH_TOKEN 必须已被清掉（顺序反了此断言即红）
    process.env.ANTHROPIC_AUTH_TOKEN = 'PROXY_MANAGED'
    process.env.CLAUDE_CONFIG_DIR = 'C:\\Users\\18387\\.claude' // 非隔离 → assertCliConfigDir throw
    await expect(setupExperiment()).rejects.toThrow('CLAUDE_CONFIG_DIR')
    expect(process.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined()
    delete process.env.CLAUDE_CONFIG_DIR
  })
})

describe('P10 preflight 加固（F3：provider 错误文本不得判成就绪）', () => {
  it('detectPreflightError 命中黑名单', () => {
    for (const bad of ['API Error: 401 Unauthorized', 'HTTP 429 Too Many Requests', '{"error":{"message":"overloaded"}}', '您的额度不足', '请求过于频繁', 'Service Unavailable', 'invalid api key']) {
      expect(detectPreflightError(bad)).toBeTruthy()
    }
  })
  it('不误伤正常回复/裸数字子串；含 quota 的正文宁严勿松照拦', () => {
    expect(detectPreflightError('就绪')).toBeNull()
    expect(detectPreflightError('OK! 一切正常')).toBeNull()
    expect(detectPreflightError('a 20403 number and latency=14290ms')).toBeNull() // 复核#4：数字必须词边界
    expect(detectPreflightError('a text about quota policies')).toBe('quota')
  })
  it('fix-r1：空结果被上游兜底文本替代（EMPTY_RESPONSE，orchestrator/index.ts:623-626）——哨兵必须在黑名单，否则全 error-chunk 故障判就绪', () => {
    expect(detectPreflightError('[Agent 未返回有效内容]')).toBe('未返回有效内容')
  })
  // T3-fix-r1（Step7-2）：传输层故障。PROBE A 真机实证——baseUrl 不可达时 CLI 把连接失败当正文返回，
  // 旧黑名单放行 ⇒ 哨兵"判环境"失效。首条即探针原文，其余覆盖同族各签名 + 不带数字码的纯文本错误。
  it('fix-r1：传输层签名必须命中（PROBE A 原文 + 同族）', () => {
    const transport = [
      'API Error: Unable to connect to API (ConnectionRefused)', // PROBE A 实录（127.0.0.1:9，176s 后返回正文）
      'Unable to connect to the remote server',
      'connect ECONNREFUSED 127.0.0.1:9',
      'fetch failed',
      'API Error: Connection timeout',
      'request timed out after 60s',
      'API Error: upstream timeout',
    ]
    for (const bad of transport) {
      expect(detectPreflightError(bad), bad).toBeTruthy()
    }
  })
  // 宁严勿松不等于「什么都拦」：合法就绪正文与含 latency/数字的良性文本必须继续放行，否则每次发射都会被自己挡住
  it('fix-r1：传输层签名不误伤就绪正文/裸数字（新B 反向界）', () => {
    expect(detectPreflightError('就绪')).toBeNull()
    expect(detectPreflightError('OK! 一切正常')).toBeNull()
    expect(detectPreflightError('latency=176703ms key#69cdcd6c')).toBeNull()
    expect(detectPreflightError('a 20403 number and latency=14290ms')).toBeNull()
  })
})
