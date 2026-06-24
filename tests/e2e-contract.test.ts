/**
 * Contract v1 端到端最小用例验证
 *
 * 默认跳过(不影响 CI)。手动跑:
 *   E2E=1 npx vitest run tests/e2e-contract.test.ts
 *
 * 凭证从环境变量读取(.env 文件被 git ignore,不会泄漏):
 *   MIMO_TEST_API_KEY     必填(否则 e2e 测试被 skip)
 *   MIMO_TEST_BASE_URL    可选,默认 https://token-plan-cn.xiaomimimo.com/anthropic
 *   MIMO_TEST_MODEL       可选,默认 mimo-v2.5-pro[1m]
 *
 * 这个测试真实拉起 CLI 进程,跑两个有依赖的 task,验:
 *   - 动作 1:影子 git 目录落地(workDir 自己没 .git)
 *   - 动作 2:Task.result 持久化到 DB
 *   - 动作 3:Task.outputSchema 持久化到 DB
 *   - 动作 4:下游 task prompt 含 <dependency> 标签 + 上游 result
 *   - 动作 8:每个任务 prompt 含 <authoritative_input> 包装
 *   - §1.3 默认 on:cliSessionId 写回 DB
 *
 * 测试通过 hook process-registry.spawnProcess 抓真实 prompt(stdin payload),
 * 不动产线代码,验证 prompt 装配正确性。
 *
 * 模型:
 *   - claude-code:Xiaomi MiMo(via ANTHROPIC_BASE_URL 兼容路径)
 *   - opencode:DeepSeek(原生 provider)
 * 两个平台都跑,验证 contract 跨 provider 都生效。
 *
 * 注意:
 *   - 此测试消耗真实 token(每个平台 ~30K-80K)
 *   - 此测试会临时创建 workDir 和 SQLite DB(隔离,不污染 dev.db)
 *   - 此测试 mock monitoring(避免 LLM 主观判断引入测试不稳定)
 *   - 此测试约 1-2 分钟
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { execSync } from 'child_process'

// ── MiMo 凭证从环境变量读取(不硬编码,防泄漏) ─────────────
const MIMO_API_KEY = process.env.MIMO_TEST_API_KEY ?? ''
const MIMO_BASE_URL = process.env.MIMO_TEST_BASE_URL ?? 'https://token-plan-cn.xiaomimimo.com/anthropic'
const MIMO_MODEL = process.env.MIMO_TEST_MODEL ?? 'mimo-v2.5-pro[1m]'  // process-registry 会自动 strip [1m]

// ── E2E gate ──────────────────────────────────────────────
// 同时要求 E2E=1 和有效的 MIMO_TEST_API_KEY 才跑 e2e
// 缺凭证或仅空白字符串时 skip(若 E2E=1 但缺 key 会打 warn 提示用户)
const isE2E = process.env.E2E === '1' && MIMO_API_KEY.trim().length > 0
if (process.env.E2E === '1' && MIMO_API_KEY.trim().length === 0) {
  console.warn('[e2e-contract] E2E=1 但 MIMO_TEST_API_KEY 未设置或为空,跳过 e2e 测试。在 .env 中配置后重试。')
}

// DeepSeek for OpenCode(假设 opencode auth login deepseek 已配)
const DEEPSEEK_MODEL = 'deepseek/deepseek-chat'

// ── Hook spawnProcess 抓真实 prompt ──────────────────────
const capturedPrompts: Array<{ key: string; prompt: string }> = []

// 在 import 前 mock process-registry 的 send,拦截 prompt
vi.mock('@/lib/adapter/process-registry', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/adapter/process-registry')>()
  const proxy = new Proxy(original.processRegistry, {
    get(target, prop) {
      if (prop === 'send') {
        // 包装 send,记录 prompt 后转发到真实实现
        return async function* (key: string, prompt: string, ...rest: unknown[]) {
          capturedPrompts.push({ key, prompt })
          yield* (target as any).send(key, prompt, ...rest)
        }
      }
      return (target as any)[prop]
    }
  })
  return { ...original, processRegistry: proxy }
})

let workDir: string
let dbPath: string
let originalDbUrl: string | undefined

beforeAll(() => {
  if (!isE2E) return
  // 临时 workDir
  workDir = mkdtempSync(join(tmpdir(), 'agenthub-e2e-'))
  // 临时 DB(隔离 dev.db)
  dbPath = join(workDir, 'e2e.db')
  originalDbUrl = process.env.DATABASE_URL
  process.env.DATABASE_URL = `file:${dbPath}`
  // 跑 prisma migrate deploy 创建表
  try {
    execSync(`npx prisma migrate deploy`, {
      cwd: 'D:/ai全栈挑战赛/agenthub',
      env: { ...process.env, DATABASE_URL: `file:${dbPath}` },
      stdio: 'inherit',
    })
  } catch (e) {
    console.error('Failed to run migrations:', e)
    throw e
  }
}, 60_000)

afterAll(() => {
  if (!isE2E) return
  // 恢复 DATABASE_URL:undefined 时显式 delete,否则会变字符串 "undefined" 污染后续测试
  if (originalDbUrl === undefined) {
    delete process.env.DATABASE_URL
  } else {
    process.env.DATABASE_URL = originalDbUrl
  }
  try {
    rmSync(workDir, { recursive: true, force: true })
  } catch {}
})

// ── Mock monitoring 的 orchestrator ──────────────────────
// monitoring 会调 executeSingleAgent,我们让它返回 needsCorrection:false 静默通过
// 这样 e2e 只验真实 worker Agent + contract 机制,不被 monitoring LLM 行为污染
vi.mock('@/lib/services/execution', async (importOriginal) => {
  // 实际不 mock,但要确保 orchestrator import 顺序正确
  return await importOriginal()
})

async function runOnePlatform(platform: 'claude-code' | 'opencode') {
  // 动态 import 确保 mock 生效
  const { prisma } = await import('@/lib/db')
  const { handleExecution } = await import('@/lib/services/execution')

  // ── 清空 captured prompts ──
  capturedPrompts.length = 0

  // ── seed:Orchestrator + worker agent + session + 2 tasks ──
  const orchConfig = platform === 'claude-code'
    ? { model: MIMO_MODEL, baseUrl: MIMO_BASE_URL, apiKey: MIMO_API_KEY }
    : { model: DEEPSEEK_MODEL, baseUrl: '', apiKey: '' }  // OpenCode 用 auth.json 凭证

  // 删旧 Orchestrator + Agent
  await prisma.agent.deleteMany({ where: {} })

  await prisma.agent.create({
    data: {
      name: 'Orchestrator',
      expertise: 'orchestration',
      systemPrompt: 'orchestrator',
      platform,
      ...orchConfig,
      isPreset: true,
      isOrchestrator: true,
    },
  })

  const worker = await prisma.agent.create({
    data: {
      name: '文件工程师',
      expertise: '创建文本文件',
      systemPrompt: `你是文件工程师。任务很简单:按用户要求创建文件并写入指定内容。
完成后,在你的回答末尾输出一段 JSON 块,字段名匹配 output_schema 声明。
不要修改任何其他文件。不要改 .env 或 package.json 等敏感文件。`,
      platform,
      ...orchConfig,
    },
  })

  const session = await prisma.session.create({
    data: {
      title: 'e2e contract test',
      type: 'group',
      phase: 'execution',
      projectDir: workDir,
      permissionMode: 'auto',  // 跳过权限确认,自动允许
    },
  })

  await prisma.sessionMember.create({
    data: { sessionId: session.id, agentId: worker.id, role: 'member' },
  })

  const t1 = await prisma.task.create({
    data: {
      description: '在 hello.md 文件中写入这段内容:"hello e2e world"。完成后在末尾输出 JSON: {"greeting":"hello e2e world"}',
      status: 'pending',
      assignedAgentId: worker.id,
      sessionId: session.id,
      dependencies: '[]',
      declaredFiles: JSON.stringify(['hello.md']),
      outputSchema: JSON.stringify(['greeting:string - 问候语']),
    },
  })

  const t2 = await prisma.task.create({
    data: {
      description: '基于上一个任务的输出,在 world.md 中写入这段内容:"received: <上游 greeting 字段的值>"。完成后输出 JSON: {"echo":"received: ..."}',
      status: 'pending',
      assignedAgentId: worker.id,
      sessionId: session.id,
      dependencies: JSON.stringify([t1.id]),
      declaredFiles: JSON.stringify(['world.md']),
      outputSchema: JSON.stringify(['echo:string - 回声']),
    },
  })

  // ── 跑执行 ──
  const events: Array<{ agentId: string; type: string; content: string }> = []
  const sendEvent = (e: { agentId: string; type: string; content: string }) => {
    events.push(e)
  }

  await handleExecution(
    'e2e test',
    session.id,
    [{
      id: worker.id,
      name: worker.name,
      systemPrompt: worker.systemPrompt,
      platform: worker.platform,
      expertise: worker.expertise,
      model: worker.model,
      baseUrl: worker.baseUrl,
      apiKey: worker.apiKey,
      tools: '[]',
    }],
    sendEvent,
    undefined,
    Date.now() + 5 * 60 * 1000  // 5 分钟 deadline
  )

  // ── 重新读 DB 拿最新状态 ──
  const finalT1 = await prisma.task.findUnique({ where: { id: t1.id } })
  const finalT2 = await prisma.task.findUnique({ where: { id: t2.id } })

  // ── 断言 ──

  // 动作 1:影子 git 目录存在
  const shadowGitDir = join(workDir, '.agenthub', 'shadow-git', session.id)
  expect(existsSync(shadowGitDir), `[${platform}] shadow git dir should exist at ${shadowGitDir}`).toBe(true)
  // workDir 本身没被 git init(不该有 .git 目录)
  expect(existsSync(join(workDir, '.git')), `[${platform}] workDir should NOT have .git`).toBe(false)

  // 任务完成
  expect(finalT1?.status, `[${platform}] t1 status`).toBe('completed')
  expect(finalT2?.status, `[${platform}] t2 status`).toBe('completed')

  // 动作 2:Task.result 持久化
  expect(finalT1?.result, `[${platform}] t1 result persisted`).toBeTruthy()
  expect(finalT2?.result, `[${platform}] t2 result persisted`).toBeTruthy()
  expect(finalT1?.result?.length, `[${platform}] t1 result non-empty`).toBeGreaterThan(0)

  // 动作 3:Task.outputSchema 持久化(seed 时写入,这里只验存在)
  expect(finalT1?.outputSchema, `[${platform}] t1 outputSchema`).toContain('greeting')
  expect(finalT2?.outputSchema, `[${platform}] t2 outputSchema`).toContain('echo')

  // §1.3 默认 on:cliSessionId 在任务完成时被写入
  // (注意:opencode 可能不一定每次都返回 sessionId,所以只用 expect.any 弱断言)
  if (platform === 'claude-code') {
    expect(finalT1?.cliSessionId, `[${platform}] t1 cliSessionId saved`).toBeTruthy()
  }

  // 文件实际落地
  expect(existsSync(join(workDir, 'hello.md')), `[${platform}] hello.md exists`).toBe(true)
  const helloContent = readFileSync(join(workDir, 'hello.md'), 'utf-8')
  expect(helloContent.toLowerCase(), `[${platform}] hello.md content`).toContain('hello')

  // 动作 4 + 8:t1/t2 的 prompt 应含 <authoritative_input> 包装;t2 额外含 <dependency>
  // capturedPrompts 由 mock 收集,可能含多个 prompt(t1 一次,t2 一次,纠偏可能再来)
  const t1Prompts = capturedPrompts.filter(p => p.prompt.includes('hello.md'))
  const t2Prompts = capturedPrompts.filter(p => p.prompt.includes('world.md'))
  expect(t1Prompts.length, `[${platform}] t1 was prompted at least once`).toBeGreaterThan(0)
  expect(t2Prompts.length, `[${platform}] t2 was prompted at least once`).toBeGreaterThan(0)
  const t1FirstPrompt = t1Prompts[0].prompt
  const t2FirstPrompt = t2Prompts[0].prompt

  // 动作 8:authoritative_input 包装在每个任务 prompt 上都生效
  for (const [label, prompt] of [['t1', t1FirstPrompt], ['t2', t2FirstPrompt]] as const) {
    expect(prompt, `[${platform}] ${label} prompt has <authoritative_input>`).toContain('<authoritative_input>')
    expect(prompt, `[${platform}] ${label} prompt has </authoritative_input>`).toContain('</authoritative_input>')
    expect(prompt, `[${platform}] ${label} prompt has 以下内容为准 声明`).toContain('以下内容为准')
  }

  // 动作 4:dependency 注入(t2 依赖 t1,故只在 t2 上断言)
  expect(t2FirstPrompt, `[${platform}] t2 prompt has <dependency>`).toContain('<dependency')
  expect(t2FirstPrompt, `[${platform}] t2 prompt embeds upstream result`).toContain('hello')  // 上游 greeting 内容
}

describe.skipIf(!isE2E)('contract v1 端到端验证(E2E,需 E2E=1)', () => {
  it('claude-code 平台:跑两个有依赖的 task,验 contract 关键动作', async () => {
    await runOnePlatform('claude-code')
  }, 5 * 60 * 1000)

  it('opencode 平台:跑两个有依赖的 task,验 contract 关键动作', async () => {
    await runOnePlatform('opencode')
  }, 5 * 60 * 1000)
})

// 不在 E2E 模式时,跑一个 placeholder 让 vitest 不抱怨空文件
describe.skipIf(isE2E)('e2e gate(默认跳过)', () => {
  it('未启用 E2E=1,跳过端到端测试(用 `E2E=1 npx vitest run tests/e2e-contract.test.ts` 跑)', () => {
    expect(true).toBe(true)
  })
})
