import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { executeSingleAgent } from '@/lib/orchestrator'
import { acquireSessionLock } from '@/lib/session-lock'

async function executeDownstreamTasks(
  sessionId: string,
  completedTaskId: string,
  workDir: string,
  permissionMode: string
) {
  const allTasks = await prisma.task.findMany({ where: { sessionId } })
  const agents = await prisma.agent.findMany()
  const history = await prisma.message.findMany({
    where: { sessionId },
    orderBy: { createdAt: 'asc' },
  })
  const context = history.map(m => {
    const role = m.role === 'user' ? 'User' : m.agentId || 'Agent'
    return `--- ${role} ---\n${m.rawContent}`
  }).join('\n\n')

  // Find tasks that became ready after this task completed
  const readyTasks = allTasks.filter(t => {
    if (t.status !== 'pending') return false
    const deps: string[] = JSON.parse(t.dependencies || '[]')
    return deps.every(depId => {
      const dep = allTasks.find(t2 => t2.id === depId)
      return dep?.status === 'completed'
    })
  })

  for (const task of readyTasks) {
    const agent = task.assignedAgentId
      ? agents.find(a => a.id === task.assignedAgentId)
      : null
    if (!agent) continue

    await prisma.task.update({ where: { id: task.id }, data: { status: 'in_progress' } })

    try {
      const { result } = await executeSingleAgent(
        {
          name: agent.name,
          systemPrompt: agent.systemPrompt,
          platform: agent.platform,
          model: agent.model || undefined,
          baseUrl: agent.baseUrl || undefined,
          apiKey: agent.apiKey || undefined,
          workDir,
          permissionMode,
          id: agent.id,
          tools: agent.tools || undefined,
        },
        task.description,
        context,
        () => {},
        sessionId,
        workDir
      )

      await prisma.task.update({ where: { id: task.id }, data: { status: 'completed' } })
      await prisma.message.create({
        data: { role: 'agent', rawContent: result, sessionId, agentId: agent.name, taskId: task.id },
      })

      // Re-query before recursing to get fresh task statuses
      await executeDownstreamTasks(sessionId, task.id, workDir, permissionMode)
    } catch {
      await prisma.task.update({ where: { id: task.id }, data: { status: 'failed' } })
      // Re-query to get accurate downstream list
      const freshTasks = await prisma.task.findMany({ where: { sessionId } })
      const downstream = freshTasks.filter(t => {
        if (t.status !== 'pending') return false
        const deps: string[] = JSON.parse(t.dependencies || '[]')
        return deps.includes(task.id)
      })
      for (const dt of downstream) {
        await prisma.task.update({ where: { id: dt.id }, data: { status: 'blocked' } })
      }
    }
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; taskId: string }> }
) {
  const { id: sessionId, taskId } = await params

  const releaseLock = await acquireSessionLock(sessionId)
  try {
    return await handleRedo(sessionId, taskId, request)
  } finally {
    releaseLock()
  }
}

async function handleRedo(sessionId: string, taskId: string, request: Request) {

  const body = await request.json().catch(() => ({}))
  const newDescription = body.description as string | undefined

  // 1. Validate task exists and is redoable
  const task = await prisma.task.findUnique({
    where: { id: taskId },
    include: { assignedAgent: true }
  })
  if (!task) {
    return NextResponse.json({ error: 'Task not found' }, { status: 404 })
  }
  if (task.sessionId !== sessionId) {
    return NextResponse.json({ error: 'Task does not belong to this session' }, { status: 403 })
  }
  if (task.status !== 'failed' && task.status !== 'blocked') {
    return NextResponse.json({ error: `Cannot redo task with status: ${task.status}` }, { status: 400 })
  }

  // 2. Update description if provided, reset status to pending
  const updateData: { description?: string; status: string } = { status: 'pending' }
  if (newDescription && newDescription.trim()) {
    updateData.description = newDescription.trim()
  }
  await prisma.task.update({ where: { id: taskId }, data: updateData })

  // 3. Unblock downstream tasks that were blocked by this task's failure
  const allTasks = await prisma.task.findMany({ where: { sessionId } })
  for (const t of allTasks) {
    if (t.status !== 'blocked') continue
    const deps: string[] = JSON.parse(t.dependencies || '[]')
    if (!deps.includes(taskId)) continue
    const otherDepsOk = deps.filter(d => d !== taskId).every(depId => {
      const dep = allTasks.find(t2 => t2.id === depId)
      return dep?.status === 'completed'
    })
    if (otherDepsOk) {
      await prisma.task.update({ where: { id: t.id }, data: { status: 'pending' } })
    }
  }

  // 4. Execute the task
  const agent = task.assignedAgent
  if (!agent) {
    return NextResponse.json({
      taskId,
      status: 'pending',
      message: 'Task reset to pending, no agent assigned'
    })
  }

  const description = updateData.description || task.description
  const session = await prisma.session.findUnique({ where: { id: sessionId } })
  const workDir = session?.projectDir && session.projectDir.trim()
    ? session.projectDir.trim()
    : process.cwd()

  const history = await prisma.message.findMany({
    where: { sessionId },
    orderBy: { createdAt: 'asc' },
  })
  const context = history.map(m => {
    const role = m.role === 'user' ? 'User' : m.agentId || 'Agent'
    return `--- ${role} ---\n${m.rawContent}`
  }).join('\n\n')

  await prisma.task.update({ where: { id: taskId }, data: { status: 'in_progress' } })

  try {
    const { result } = await executeSingleAgent(
      {
        name: agent.name,
        systemPrompt: agent.systemPrompt,
        platform: agent.platform,
        model: agent.model || undefined,
        baseUrl: agent.baseUrl || undefined,
        apiKey: agent.apiKey || undefined,
        workDir,
        permissionMode: session?.permissionMode || 'default',
        id: agent.id,
        tools: agent.tools || undefined,
      },
      description,
      context,
      () => {},
      sessionId,
      workDir
    )

    await prisma.task.update({ where: { id: taskId }, data: { status: 'completed' } })
    await prisma.message.create({
      data: { role: 'agent', rawContent: result, sessionId, agentId: agent.name, taskId },
    })

    // Cascade: execute downstream tasks that are now ready
    await executeDownstreamTasks(sessionId, taskId, workDir, session?.permissionMode || 'default')

    return NextResponse.json({
      taskId,
      status: 'completed',
      message: 'Task redo completed'
    })
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : 'Unknown error'
    await prisma.task.update({ where: { id: taskId }, data: { status: 'failed' } })
    return NextResponse.json({
      taskId,
      status: 'failed',
      error: errorMsg,
      message: 'Task redo failed'
    }, { status: 500 })
  }
}
