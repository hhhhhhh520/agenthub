export function OpencodeReadOnlyHint({ platform }: { platform?: string }) {
  if (platform !== 'opencode') return null
  return (
    <div className="border-t bg-amber-50 px-3 py-2 text-xs text-amber-800">
      OpenCode 默认模式为只读：写文件/执行命令会被拒绝。需要写入请发送{' '}
      <code className="rounded bg-amber-100 px-1">/permission auto</code> 切换到自动模式。
    </div>
  )
}
