import { prisma } from '@/lib/db'
import { analyzeScene, generateRoles, decomposeTasks, executeTaskBatch, runDiscussion } from '@/lib/orchestrator'
import { groupByBatch } from '@/lib/orchestrator/scheduler'

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: sessionId } = await params
  const { message, mentionAll } = await request.json()

  await prisma.message.create({
    data: { role: 'user', content: message, sessionId },
  })

  const encoder = new TextEncoder()
  const stream = new ReadableStream({
    async start(controller) {
      function sendEvent(data: { agentId: string; type: string; content: string }) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`))
      }

      try {
        const existingAgents = await prisma.agent.findMany({ where: { sessionId } })

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
            data: { role: 'orchestrator', content: summary, sessionId },
          })
          sendEvent({ agentId: 'orchestrator', type: 'done', content: summary })
        } else {
          // Step 1: Scene analysis
          sendEvent({ agentId: 'orchestrator', type: 'status', content: '分析任务中...' })
          const scene = await analyzeScene(message)
          sendEvent({ agentId: 'orchestrator', type: 'text', content: `任务类型：${scene.type}，复杂度：${scene.complexity}` })

          // Step 2: Generate roles
          sendEvent({ agentId: 'orchestrator', type: 'status', content: '组建团队中...' })
          const roles = await generateRoles(scene.type, scene.description)
          sendEvent({ agentId: 'orchestrator', type: 'text', content: `已生成 ${roles.length} 个角色：${roles.map(r => r.name).join('、')}` })

          for (const role of roles) {
            await prisma.agent.create({
              data: { ...role, sessionId, status: 'idle' },
            })
          }

          // Step 3: Decompose tasks
          sendEvent({ agentId: 'orchestrator', type: 'status', content: '拆解任务中...' })
          const tasks = await decomposeTasks(scene.description, roles)
          sendEvent({ agentId: 'orchestrator', type: 'text', content: `已拆解为 ${tasks.length} 个子任务` })

          for (const task of tasks) {
            await prisma.task.create({
              data: {
                id: task.id,
                description: task.description,
                sessionId,
                dependencies: JSON.stringify(task.dependencies),
              },
            })
          }

          // Step 4: Execute tasks batch by batch
          const batches = groupByBatch(tasks)
          const allResults = new Map<string, string>()

          for (let i = 0; i < batches.length; i++) {
            sendEvent({ agentId: 'orchestrator', type: 'status', content: `执行第 ${i + 1}/${batches.length} 批任务...` })
            const batchResults = await executeTaskBatch(
              batches[i],
              roles.map(r => ({ name: r.name, systemPrompt: r.systemPrompt, platform: r.platform })),
              message,
              (taskId, chunk) => sendEvent({ agentId: taskId, type: chunk.type, content: chunk.content })
            )
            for (const [taskId, result] of batchResults) allResults.set(taskId, result)
          }

          const summary = Array.from(allResults.entries())
            .map(([taskId, result]) => `任务 ${taskId} 完成：${result.slice(0, 100)}...`)
            .join('\n')
          await prisma.message.create({
            data: { role: 'orchestrator', content: summary, sessionId },
          })
          sendEvent({ agentId: 'orchestrator', type: 'done', content: summary })
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
