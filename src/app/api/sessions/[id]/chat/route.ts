import { prisma } from '@/lib/db'
import { analyzeScene, decomposeTasks, executeTaskBatch, runDiscussion, executeSingleAgent, callLLMForAnalysis } from '@/lib/orchestrator'
import { groupByBatch } from '@/lib/orchestrator/scheduler'

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: sessionId } = await params
  const { message, mentionAll, targetAgent, replyToId } = await request.json()

  await prisma.message.create({
    data: { role: 'user', rawContent: message, sessionId, replyToId },
  })

  const encoder = new TextEncoder()
  const stream = new ReadableStream({
    async start(controller) {
      function sendEvent(data: { agentId: string; type: string; content: string }) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`))
      }

      try {
        const existingMembers = await prisma.sessionMember.findMany({
          where: { sessionId },
          include: { agent: true },
        })
        const existingAgents = existingMembers.map(m => m.agent)

        if (mentionAll && existingAgents.length > 0) {
          sendEvent({ agentId: 'orchestrator', type: 'status', content: '开始多轮讨论...' })

          const opinions = await runDiscussion(
            message,
            existingAgents.map(a => ({ name: a.name, systemPrompt: a.systemPrompt })),
            3,
            (agentName, chunk) => sendEvent({ agentId: agentName, type: chunk.type, content: chunk.content })
          )

          const summary = opinions.join('\n\n')
          await prisma.message.create({
            data: { role: 'orchestrator', rawContent: summary, sessionId },
          })
          sendEvent({ agentId: 'orchestrator', type: 'done', content: summary })
        } else if (targetAgent) {
          const agent = existingAgents.find(a => a.name === targetAgent)
          if (!agent) {
            sendEvent({ agentId: 'orchestrator', type: 'error', content: `未找到名为 ${targetAgent} 的 Agent` })
          } else {
            sendEvent({ agentId: agent.name, type: 'status', content: '执行中...' })
            const result = await executeSingleAgent(
              { name: agent.name, systemPrompt: agent.systemPrompt, platform: agent.platform },
              message,
              '',
              (agentId, chunk) => sendEvent({ agentId, type: chunk.type, content: chunk.content })
            )
            await prisma.message.create({
              data: { role: 'agent', rawContent: result, sessionId, agentId: agent.name },
            })
            sendEvent({ agentId: agent.name, type: 'done', content: result })
          }
        } else {
          // Check for agent creation intent
          const isCreateIntent = /创建|新建|添加|帮我建|create\s*agent/i.test(message)

          if (isCreateIntent) {
            sendEvent({ agentId: 'orchestrator', type: 'status', content: '正在生成 Agent 配置...' })

            const configPrompt = `从用户消息中提取 Agent 配置，返回 JSON（不要其他话）：
{"name":"角色名","expertise":"专长描述","systemPrompt":"系统提示词","platform":"llm或claude-code","capabilities":["标签1","标签2"],"accentColor":"#hex色"}

用户消息：${message}`

            const configText = await callLLMForAnalysis(configPrompt)
            const cleaned = configText.replace(/```json?\s*([\s\S]*?)```/, '$1').trim()
            let config: { name: string; expertise: string; systemPrompt: string; platform?: string; capabilities?: string[]; accentColor?: string }
            try {
              config = JSON.parse(cleaned)
            } catch {
              sendEvent({ agentId: 'orchestrator', type: 'error', content: 'Agent 配置解析失败，请重试' })
              controller.close()
              return
            }

            const agent = await prisma.agent.create({
              data: {
                name: config.name,
                expertise: config.expertise,
                systemPrompt: config.systemPrompt,
                platform: config.platform || 'llm',
                capabilities: JSON.stringify(config.capabilities || []),
                accentColor: config.accentColor || '#6366f1',
                isPreset: false,
              },
            })

            await prisma.sessionMember.create({
              data: { sessionId, agentId: agent.id },
            })

            const result = `已创建 Agent「${agent.name}」\n专长：${agent.expertise}\n平台：${agent.platform}`
            await prisma.message.create({
              data: { role: 'orchestrator', rawContent: result, sessionId },
            })
            sendEvent({ agentId: 'orchestrator', type: 'text', content: result })
            sendEvent({ agentId: 'orchestrator', type: 'done', content: result })
          } else {
            // Default: use existing session agents for task decomposition
            sendEvent({ agentId: 'orchestrator', type: 'status', content: '分析任务中...' })
            const scene = await analyzeScene(message)
            sendEvent({ agentId: 'orchestrator', type: 'text', content: `任务类型：${scene.type}，复杂度：${scene.complexity}` })

            if (existingAgents.length === 0) {
              const tip = '当前会话没有 Agent，请先通过对话创建或从 Agent 面板添加。'
              await prisma.message.create({ data: { role: 'orchestrator', rawContent: tip, sessionId } })
              sendEvent({ agentId: 'orchestrator', type: 'done', content: tip })
            } else {
              sendEvent({ agentId: 'orchestrator', type: 'status', content: '拆解任务中...' })
              const tasks = await decomposeTasks(
                scene.description,
                existingAgents.map(a => ({ name: a.name, expertise: a.expertise }))
              )
              sendEvent({ agentId: 'orchestrator', type: 'text', content: `已拆解为 ${tasks.length} 个子任务` })

              for (const task of tasks) {
                await prisma.task.create({
                  data: {
                    id: task.id,
                    description: task.description,
                    sessionId,
                    assignedAgentId: existingAgents.find(a => a.name === task.assignedAgent)?.id,
                    dependencies: JSON.stringify(task.dependencies),
                  },
                })
              }

              const batches = groupByBatch(tasks)
              const allResults = new Map<string, string>()

              for (let i = 0; i < batches.length; i++) {
                sendEvent({ agentId: 'orchestrator', type: 'status', content: `执行第 ${i + 1}/${batches.length} 批任务...` })
                const batchResults = await executeTaskBatch(
                  batches[i],
                  existingAgents.map(a => ({ name: a.name, systemPrompt: a.systemPrompt, platform: a.platform })),
                  message,
                  (taskId, chunk) => sendEvent({ agentId: taskId, type: chunk.type, content: chunk.content })
                )
                for (const [taskId, result] of batchResults) allResults.set(taskId, result)
              }

              const summary = Array.from(allResults.entries())
                .map(([taskId, result]) => `任务 ${taskId} 完成：${result.slice(0, 100)}...`)
                .join('\n')
              await prisma.message.create({
                data: { role: 'orchestrator', rawContent: summary, sessionId },
              })
              sendEvent({ agentId: 'orchestrator', type: 'done', content: summary })
            }
          }
        }
      } catch (error) {
        sendEvent({ agentId: 'orchestrator', type: 'error', content: String(error) })
      } finally {
        controller.close()
      }
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  })
}
