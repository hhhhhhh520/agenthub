import { prisma } from '@/lib/db'
import type { Prisma } from '@/generated/prisma/client'

/**
 * contract v1 §1.3（动作 7）/ redo（❌-2）共用的 cliSessionId 统一失效入口
 * （roadmap §2.4：此前 6 处散点两表同写靠人肉复制，曾两次出一致性风险 ⚠️-C2/F3/F10）。
 *
 * 语义：推翻 agent 的既有 CLI 会话——Task.cliSessionId 与该 agent 的
 * SessionMember.cliSessionId 在同一事务内清空，下次执行强制起新 CLI session，
 * 不携带失败/被推翻的角色记忆。两表同写包事务，防中间崩溃产生半残
 * （task 清了 member 没清 → 下次 fallback 拿到脏 sessionId，护栏失效）。
 *
 * 不含进程管理：三条调用路径（redo 重置 / 敏感失败 / 纠偏退回）发生时 agent
 * 进程均已退出（结果处理阶段）；杀活跃进程属 process-registry 职责，不在此处。
 */
export async function invalidateCliSession(opts: {
  taskId: string
  sessionId: string
  agentId?: string | null
  /** 与 cliSessionId: null 一并写入 Task 的附加字段（各调用方语义不同） */
  taskData?: Prisma.TaskUpdateInput
}): Promise<void> {
  const { taskId, sessionId, agentId, taskData } = opts
  await prisma.$transaction([
    prisma.task.update({
      where: { id: taskId },
      // cliSessionId: null 放在 spread 之后，即使 taskData 携带脏值也被强制覆盖
      data: { ...taskData, cliSessionId: null },
    }),
    ...(agentId ? [
      prisma.sessionMember.updateMany({
        where: { sessionId, agentId },
        data: { cliSessionId: null },
      }),
    ] : []),
  ])
}
