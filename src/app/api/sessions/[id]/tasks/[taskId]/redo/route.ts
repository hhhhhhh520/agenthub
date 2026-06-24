import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { handleExecution } from '@/lib/services/execution'
import { acquireSessionLock } from '@/lib/session-lock'

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

  // 2. ❌-2 修复:重置 task 状态 + 清 cliSessionId(让 agent 起新 session,
  //    不带本次失败的角色感污染),同时复用 description 修改
  const updateData: { description?: string; status: string; cliSessionId: string | null; correctionCount: number } = {
    status: 'pending',
    cliSessionId: null,  // contract v1 §1.3:重做 = 推翻重来,清 cliSessionId
    correctionCount: 0,  // 重新计算纠偏次数
  }
  if (newDescription && newDescription.trim()) {
    updateData.description = newDescription.trim()
  }
  await prisma.task.update({ where: { id: taskId }, data: updateData })

  // 3. ❌-2 修复:同步清 SessionMember.cliSessionId(同 task)
  //    用事务保证两表一致(配合 ⚠️-C2 修复的一致性原则)
  if (task.assignedAgentId) {
    await prisma.sessionMember.updateMany({
      where: { sessionId, agentId: task.assignedAgentId },
      data: { cliSessionId: null },
    })
  }

  // 4. Unblock downstream tasks that were blocked by this task's failure
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

  // 5. ❌-2 修复:不再自己跑 executeSingleAgent,改调 handleExecution
  //    让 redo 走与主链路完全相同的执行路径,自动享受 contract v1 全部保护:
  //    - 动作 1: shadow git 追踪变更
  //    - 动作 2: task.result 持久化
  //    - 动作 4: <dependency> 注入上游结果
  //    - 动作 5: outputSchema 软校验
  //    - 动作 6: declaredFiles 敏感越界硬失败 / 普通越界软警告
  //    - 动作 7: 失败/纠偏时 cliSessionId invalidate
  //    - 动作 8: <authoritative_input> 包装权威输入
  if (!task.assignedAgentId) {
    return NextResponse.json({
      taskId,
      status: 'pending',
      message: 'Task reset to pending, no agent assigned'
    })
  }

  // 加载所有 agent 信息(handleExecution 需要这个列表)
  const agents = await prisma.agent.findMany()
  const agentsForHandle = agents.map(a => ({
    id: a.id,
    name: a.name,
    systemPrompt: a.systemPrompt,
    platform: a.platform,
    expertise: a.expertise || '',
    model: a.model || '',
    baseUrl: a.baseUrl || '',
    apiKey: a.apiKey || '',
    tools: a.tools || '',
  }))

  // ❌-2: noop sendEvent,HTTP fire-and-forget 模式,前端轮询拿状态
  const noopSendEvent = () => {}

  try {
    await handleExecution('[redo]', sessionId, agentsForHandle, noopSendEvent)
    // handleExecution 内部已经把 task.status 改成 completed/failed,这里只查最终状态返回
    const finalTask = await prisma.task.findUnique({ where: { id: taskId } })
    return NextResponse.json({
      taskId,
      status: finalTask?.status ?? 'unknown',
      message: `Task redo ${finalTask?.status}`,
    })
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : 'Unknown error'
    return NextResponse.json({
      taskId,
      status: 'failed',
      error: errorMsg,
      message: 'Task redo failed'
    }, { status: 500 })
  }
}
