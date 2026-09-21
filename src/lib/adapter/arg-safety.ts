/**
 * shell:true 下 cmd.exe 会解释元字符，且 Node 不做参数转义（DEP0190：仅拼接）——
 * 含这些字符的参数可导致命令注入（实测 `x & echo PWNED` 会执行 echo），
 * 空格则会让参数被静默截断。fail-closed：拒绝启动，不尝试转义
 * （cmd.exe 引号语义复杂，转义易漏；本应用参数中不存在需要这些字符的合法值）。
 * 注：反斜杠是 Windows 路径分隔符，不在拒绝集内。
 */
const UNSAFE_SPAWN_RE = /[&|<>^%!"\s]/

export function assertSpawnSafe(command: string, args: string[]): void {
  if (UNSAFE_SPAWN_RE.test(command)) {
    throw new Error(`[arg-safety] 拒绝启动：command 含 shell 不安全字符 ${JSON.stringify(command)}`)
  }
  for (const arg of args) {
    if (UNSAFE_SPAWN_RE.test(arg)) {
      throw new Error(`[arg-safety] 拒绝启动：参数含 shell 不安全字符（防注入/截断）${JSON.stringify(arg)}`)
    }
  }
}
