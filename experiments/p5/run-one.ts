import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { CONFIG } from './config'
import { TASKS } from './tasks'
import { simulateUserReply } from './user-simulator'
import { collectMetrics, appendMetrics, type RunMetrics } from './metrics'
import type { AgentConfig } from '../../src/lib/adapter/types'

export interface RunInput { config: 'on'|'off'; taskId: 'A'|'B'|'C'; seed: number }

/** 单次 run：建 session → 循环决策/回复 → done/超时/卡死 → metrics 落盘 */
export async function runOne({ config, taskId, seed }: RunInput): Promise<RunMetrics> {
  const task = TASKS.find(t => t.id === taskId)!
  const runId = `${config}-${taskId}-s${seed}-${randomUUID().slice(0, 8)}`
  const { prisma } = await import('@/lib/db')
  const { handleOrchestratorDecision } = await import('@/lib/services/chat-router')

  // OFF 开关按 run 隔离（fileParallelism:false 串行，无并发串扰）
  if (config === 'off') process.env.EXPERIMENT_STATE_MACHINE = 'off'
  else delete process.env.EXPERIMENT_STATE_MACHINE

  const projectDir = mkdtempSync(join(CONFIG.workDir, runId))
  const session = await prisma.session.create({
    data: { title: `p5-${config}-${taskId}-s${seed}`, type: 'group', projectDir },
  })
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

  const start = Date.now()
  let rounds = 0
  let escalateCount = 0
  let lastPhase = ''
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

    const after = await prisma.session.findUnique({ where: { id: session.id }, select: { phase: true } })
    const phase = after?.phase ?? ''
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
      if (phase === lastPhase) { noProgress++; if (noProgress >= CONFIG.noProgressRounds) break } // stuck
      else noProgress = 0
      lastPhase = phase
      continue
    }
    // 无 awaiting 且未 done：no-progress 兜底（self/verify 聊天可能空转）
    if (phase === lastPhase) { noProgress++; if (noProgress >= CONFIG.noProgressRounds) break }
    else noProgress = 0
    lastPhase = phase
    // 下一轮消息 = orchestrator 最后一条 text，或保持原消息
    const lastText = sendEvents.filter(e => e.type === 'text').map(e => e.content).pop()
    message = typeof lastText === 'string' && lastText ? lastText : message
  }

  const latencyMs = Date.now() - start
  const m = await collectMetrics(runId, session.id, config, taskId, seed, rounds, escalateCount, latencyMs)
  appendMetrics(m)
  return m
}
