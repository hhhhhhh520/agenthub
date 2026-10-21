export type PermissionMode = 'default' | 'auto'

export function isPermissionMode(value: unknown): value is PermissionMode {
  return value === 'default' || value === 'auto'
}
