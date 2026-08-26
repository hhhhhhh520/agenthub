import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { CONFIG, envForConfig } from './config'
import { TASKS } from './tasks'
import { simulateUserReply } from './user-simulator'
import { collectMetrics, appendMetrics, type RunMetrics } from './metrics'
import type { AgentConfig } from '../../src/lib/adapter/types'

export interface RunInput { config: (typeof CONFIG.configs)[number]; taskId: 'A'|'B'|'C'; seed: number }

/** P9-乙 T3: 三变量（F4 必办②——seqgate 臂需 EXPERIMENT_SEQGATE 隔离） */
export interface RunEnvSnapshot { EXPERIMENT_STATE_MACHINE: string | undefined; EXPERIMENT_VERIFY: string | undefined; EXPERIMENT_SEQGATE: string | undefined }

/** P6 T9: 保存 runOne 改写的实验开关 env 原值（finally 恢复用；undefined=未设=默认 on） */
export function saveRunEnv(): RunEnvSnapshot {
  return {
    EXPERIMENT_STATE_MACHINE: process.env.EXPERIMENT_STATE_MACHINE,
    EXPERIMENT_VERIFY: process.env.EXPERIMENT_VERIFY,
    EXPERIMENT_SEQGATE: process.env.EXPERIMENT_SEQGATE,
  }
}

/** P6 T9: 恢复 runOne 改写的实验开关 env——原值 undefined → delete，否则回写（保持 未设=默认on 语义，防残留污染进程内后续 run） */
export function restoreRunEnv(prev: RunEnvSnapshot): void {
  if (prev.EXPERIMENT_STATE_MACHINE === undefined) delete process.env.EXPERIMENT_STATE_MACHINE
  else process.env.EXPERIMENT_STATE_MACHINE = prev.EXPERIMENT_STATE_MACHINE
  if (prev.EXPERIMENT_VERIFY === undefined) delete process.env.EXPERIMENT_VERIFY
  else process.env.EXPERIMENT_VERIFY = prev.EXPERIMENT_VERIFY
  if (prev.EXPERIMENT_SEQGATE === undefined) delete process.env.EXPERIMENT_SEQGATE
  else process.env.EXPERIMENT_SEQGATE = prev.EXPERIMENT_SEQGATE
}

/**
 * P9-乙 T3（审查 D 强建议采纳）：三键透传抽成纯函数，替代 runOne 内联硬编码透传。
 * 封堵第四种静默退化路径：envForConfig 正确产出但 runOne 忘写某键的透传行 → 单测全绿、真实 run 静默跑成别的臂。
 * 三键各按 set/delete 处理：undefined → delete（未设=默认 on），否则原样写入（生产开关只认严格值 'off'/'on'）。
 */
export function applyRunEnv(env: ReturnType<typeof envForConfig>): void {
  if (env.EXPERIMENT_STATE_MACHINE === undefined) delete process.env.EXPERIMENT_STATE_MACHINE
  else process.env.EXPERIMENT_STATE_MACHINE = env.EXPERIMENT_STATE_MACHINE
  if (env.EXPERIMENT_VERIFY === undefined) delete process.env.EXPERIMENT_VERIFY
  else process.env.EXPERIMENT_VERIFY = env.EXPERIMENT_VERIFY
  if (env.EXPERIMENT_SEQGATE === undefined) delete process.env.EXPERIMENT_SEQGATE
  else process.env.EXPERIMENT_SEQGATE = env.EXPERIMENT_SEQGATE
}

/**
 * 单次 run：建 session → 循环决策/回复 → done / escalate-exhausted / no-progress / maxRounds 撞顶 / 异常 → metrics 落盘。
 * review I1：主体包 try/catch，异常落 failureMode:'error' 行再返回——防止格子 N 从 5 变 4 破坏同 seed 配对 McNemar。
 */
export async function runOne({ config, taskId, seed }: RunInput): Promise<RunMetrics> {
  const task = TASKS.find(t => t.id === taskId)!
  const runId = `${config}-${taskId}-s${seed}-${randomUUID().slice(0, 8)}`
  const { prisma } = await import('@/lib/db')
  const { handleOrchestratorDecision } = await import('@/lib/services/chat-router')

  // P6 T9: 保存三开关原值，finally 恢复——harness 并入根 vitest 配置/进程内跑时不再残留最后 run 的 'off'
  // （当前靠 vitest per-file fork + fileParallelism:false 隔离，取消即静默禁用生产开关）
  const prevRunEnv = saveRunEnv()

  // 开关按 run 隔离（fileParallelism:false 串行，无并发串扰）
  // P9-乙 T3: 透传统一走 applyRunEnv 纯函数（三键 set/delete，审查 D：防忘写某键的静默退化）
  applyRunEnv(CONFIG.envForConfig(config))

  const start = Date.now()
  let sessionId: string | undefined
  let rounds = 0
  let escalateCount = 0

  try {
    const projectDir = mkdtempSync(join(CONFIG.workDir, runId))
    const session = await prisma.session.create({
      data: { title: `p5-${config}-${taskId}-s${seed}`, type: 'group', projectDir },
    })
    sessionId = session.id
    const members = await prisma.agent.findMany({ where: { isPreset: false } })
    await prisma.sessionMember.createMany({
      data: members.map(a => ({ sessionId: session.id, agentId: a.id, role: a.isOrchestrator ? 'orchestrator' : 'member' })),
    })
    // AgentConfig 全字段（chat-router 消费：id/name/systemPrompt/platform/expertise/model/baseUrl/apiKey/tools）
    const agents: AgentConfig[] = members.map(a => ({
      id: a.id, name: a.name, systemPrompt: a.systemPrompt, platform: a.platform,
      expertise: a.expertise, model: a.model, baseUrl: a.baseUrl, apiKey: a.apiKey, tools: a.tools,
    }))

    const sendEvents: any[] = []
    const sendEvent = (ev: any) => sendEvents.push(ev)

    let lastPhase = ''
    let lastPhaseStep = ''
    let noProgress = 0
    let message = task.userMessage

    while (rounds < CONFIG.maxRounds) {
      rounds++
      sendEvents.length = 0
      const snap = await prisma.session.findUnique({ where: { id: session.id }, select: { phase: true, phaseStep: true, decisionTrace: true } })
      if (!snap) break
      await handleOrchestratorDecision(message, session.id, agents, sendEvent,
        { phase: snap.phase, phaseStep: snap.phaseStep, decisionTrace: snap.decisionTrace },
        undefined, projectDir, 'auto', Date.now() + CONFIG.timeoutMs)

      const after = await prisma.session.findUnique({ where: { id: session.id }, select: { phase: true, phaseStep: true } })
      const phase = after?.phase ?? ''
      const phaseStep = after?.phaseStep ?? ''
      if (phase === 'done') break

      const awaiting = sendEvents.find(e => e.type === 'awaiting_user_input')
      if (awaiting) {
        const type = String(awaiting.content ?? '')
        if (type === 'escalate') {
          escalateCount++
          if (escalateCount > CONFIG.escalateLimit) break // escalate-exhausted
        }
        // 罐头消息落库（Spec §6：不落库 LLM 历史看不到）
        const reply = simulateUserReply(type)
        await prisma.message.create({ data: { role: 'user', rawContent: reply, sessionId: session.id } })
        message = reply
        // review I2：no-progress 按 (phase, phaseStep) 二元组计数——phase 或 phaseStep 任一变化即重置。
        // 旧实现只按 phase：pm_confirm→architect_plan→agent_qa→execute 全在 phase='alignment'，合法慢进度被误杀
        if (phase === lastPhase && phaseStep === lastPhaseStep) {
          noProgress++
          if (noProgress >= CONFIG.noProgressRounds) break // no-progress break（失效模式由 resolveFailureMode 判：rounds<maxRounds→no-pass，恰撞 maxRounds→stuck）
        } else noProgress = 0
        lastPhase = phase
        lastPhaseStep = phaseStep
        continue
      }
      // 无 awaiting 且未 done：no-progress 兜底（self/verify 聊天可能空转）
      if (phase === lastPhase && phaseStep === lastPhaseStep) {
        noProgress++
        if (noProgress >= CONFIG.noProgressRounds) break // no-progress break（同上）
      } else noProgress = 0
      lastPhase = phase
      lastPhaseStep = phaseStep
      // 下一轮消息 = orchestrator 最后一条 text，或保持原消息
      const lastText = sendEvents.filter(e => e.type === 'text').map(e => e.content).pop()
      message = typeof lastText === 'string' && lastText ? lastText : message
    }

    const latencyMs = Date.now() - start
    const m = await collectMetrics(runId, session.id, config, taskId, seed, rounds, escalateCount, latencyMs)
    appendMetrics(m)
    return m
  } catch (err) {
    // review I1：真实 LLM/CLI 偶发异常不击穿——落 failureMode:'error' 行再返回，N 保持 5；不 rethrow，30-run 全跑完
    console.warn(`[run-one] run ${runId} error: ${err instanceof Error ? err.message : String(err)}`)
    const latencyMs = Date.now() - start
    // 双故障兜底：若原异常本身是 DB 故障，collectMetrics 再查 DB 会二次抛错——包一层 try/catch，
    // 回退最小 error 行（不碰 DB 只写 JSONL），保证 runOne 永不 throw、该格仍有 error 行，N 不塌
    const minimalErrorRow = (): RunMetrics => ({
      runId, config, taskId, seed, pass: false, failureMode: 'error', failKind: 'defect' as const, rounds, escalateCount,
      correctionCount: 0, illegalProposalCount: 0, totalTransitions: 0, latencyMs,
      tracePath: `${CONFIG.resultsDir}/trace-${runId}.json`,
    })
    let m: RunMetrics
    try {
      m = sessionId
        ? await collectMetrics(runId, sessionId, config, taskId, seed, rounds, escalateCount, latencyMs, true)
        : minimalErrorRow()
    } catch (err2) {
      console.warn(`[run-one] run ${runId} error-row fallback: ${err2 instanceof Error ? err2.message : String(err2)}`)
      m = minimalErrorRow()
    }
    try { appendMetrics(m) } catch (err3) { console.warn(`[run-one] run ${runId} appendMetrics failed: ${err3 instanceof Error ? err3.message : String(err3)}`) }
    return m
  } finally {
    // P6 T9: 恢复三开关原值——runOne 永不泄漏实验 env 到进程（成功/失败路径都走这里）
    restoreRunEnv(prevRunEnv)
  }
}
