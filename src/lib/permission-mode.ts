export type PermissionMode = 'default' | 'auto'

export const OPENCODE_PLATFORM = 'opencode'

export function isPermissionMode(value: unknown): value is PermissionMode {
  return value === 'default' || value === 'auto'
}

export function isOpenCodePlatform(platform: string | null | undefined): boolean {
  return platform === OPENCODE_PLATFORM
}

/** OpenCode headless 无法逐次确认；只要有 OpenCode Agent，就必须用自动模式。 */
export function requiresAutoForOpenCode(
  platforms: Array<string | null | undefined>,
): boolean {
  return platforms.some(isOpenCodePlatform)
}

/** 会话权限：OpenCode 覆盖用户选择，避免默认模式下静默写失败。 */
export function resolveSessionPermissionMode(
  requested: PermissionMode,
  platforms: Array<string | null | undefined>,
): PermissionMode {
  return requiresAutoForOpenCode(platforms) ? 'auto' : requested
}

/** 已有会话是否需要提示「默认模式 + OpenCode」风险。 */
export function needsOpenCodePermissionWarning(
  mode: PermissionMode | string | null | undefined,
  platforms: Array<string | null | undefined>,
): boolean {
  return mode === 'default' && requiresAutoForOpenCode(platforms)
}
