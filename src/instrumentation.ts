/**
 * Next.js instrumentation hook：server 启动时执行（roadmap §2.3 shadow-git 孤儿清扫 +
 * §3.3 执行中断恢复 reconcile）。
 * best-effort：DB 未就绪（首次启动未 migrate）/ 单 projectDir 失败均静默跳过，
 * 不阻塞启动。成本为一次全表 id+projectDir 查询 + 每 projectDir 一次目录扫描
 * + 一次 in_progress 任务条件写（§3.3）。
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return
  try {
    const { prisma } = await import('@/lib/db')
    // §3.3: 中断恢复先于孤儿清扫（状态收敛是廉价 DB 写，先让会话回到可续跑状态）
    try {
      const { reconcileInterruptedSessions } = await import('@/lib/services/reconcile')
      await reconcileInterruptedSessions()
    } catch {
      // reconcile best-effort：DB 未就绪等情况直接跳过（下次启动重试）
    }
    const { cleanupOrphanShadowGits } = await import('@/lib/services/shadow-git')
    const sessions = await prisma.session.findMany({ select: { id: true, projectDir: true } })
    const validIds = new Set(sessions.map(s => s.id))
    const projectDirs = [...new Set(sessions.map(s => s.projectDir).filter(Boolean))]
    for (const dir of projectDirs) {
      try {
        const removed = cleanupOrphanShadowGits(dir, validIds)
        if (removed.length > 0) {
          console.log(`[startup] 已清理孤儿影子 git 目录 ${removed.length} 个: ${dir}`)
        }
      } catch {
        // 单 projectDir 失败（权限/占用）继续其余
      }
    }
  } catch {
    // 孤儿清扫是 best-effort：DB 未就绪等情况直接跳过
  }
}
