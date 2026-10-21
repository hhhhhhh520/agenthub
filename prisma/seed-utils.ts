/** seed 失败必须让进程以非 0 退出；disconnect 仍由调用方 finally 执行。 */
export function markSeedFailure(error: unknown): void {
  console.error(error)
  process.exitCode = 1
}
