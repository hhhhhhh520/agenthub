import { describe, it, expect } from 'vitest'
import {
  buildOpenCodeGrants,
  buildOpenCodePermissionYaml,
  buildOpenCodeToolsYaml,
  OPENCODE_ALL_TOOLS,
} from '@/lib/adapter/opencode-permissions'

describe('OpenCode 双维度权限（可用工具 vs 审批）', () => {
  it('auto + 受限工具：可用工具 allow，未列出工具 deny', () => {
    const { permission, restricted } = buildOpenCodeGrants(['Read', 'Edit'], 'auto')
    expect(restricted).toBe(true)
    expect(permission.read).toBe('allow')
    expect(permission.edit).toBe('allow')
    expect(permission.bash).toBe('deny')
    expect(permission.webfetch).toBe('deny')
    expect(permission.execute).toBe('deny')
  })

  it('default + 受限工具：只读工具 allow，写/执行 ask，未列出 deny', () => {
    const { permission } = buildOpenCodeGrants(['Read', 'Edit', 'Bash'], 'default')
    expect(permission.read).toBe('allow')
    expect(permission.glob).toBe('deny') // 未在 allowedTools
    expect(permission.grep).toBe('deny') // 未在 allowedTools
    expect(permission.edit).toBe('ask')
    expect(permission.bash).toBe('ask')
    expect(permission.execute).toBe('ask') // Bash 同时授予 execute
    expect(permission.webfetch).toBe('deny') // 未在 allowedTools
  })

  it('空 tools + default：不限制可用性，但写/执行仍需审批（headless 下只读）', () => {
    const { permission, restricted } = buildOpenCodeGrants([], 'default')
    expect(restricted).toBe(false)
    expect(permission.read).toBe('allow')
    for (const tool of OPENCODE_ALL_TOOLS) {
      expect(permission[tool]).toBeDefined()
    }
    expect(permission.edit).toBe('ask')
    expect(permission.bash).toBe('ask')
  })

  it('空 tools + auto：全部 allow', () => {
    const { permission } = buildOpenCodeGrants(undefined, 'auto')
    for (const tool of OPENCODE_ALL_TOOLS) {
      expect(permission[tool]).toBe('allow')
    }
  })

  it('Write 映射 edit、Agent 映射 task、Execute 映射 execute', () => {
    const { permission } = buildOpenCodeGrants(['Write', 'Agent', 'Execute'], 'auto')
    expect(permission.edit).toBe('allow')
    expect(permission.task).toBe('allow')
    expect(permission.execute).toBe('allow')
    expect(permission.read).toBe('deny')
  })

  it('tools YAML 只在受限时写，空列表不写', () => {
    expect(buildOpenCodeToolsYaml([])).toBe('')
    const yaml = buildOpenCodeToolsYaml(['Read', 'Bash'])
    expect(yaml).toContain('tools:')
    expect(yaml).toContain('  read: true')
    expect(yaml).toContain('  bash: true')
    expect(yaml).toContain('  execute: true')
    expect(yaml).toContain('  edit: false')
  })

  it('permission YAML 始终写全，default 与 auto 效果可区分', () => {
    const def = buildOpenCodePermissionYaml(['Read', 'Edit'], 'default')
    const auto = buildOpenCodePermissionYaml(['Read', 'Edit'], 'auto')
    expect(def).toContain('permission:')
    expect(def).toContain('  read:')
    expect(def).toContain('    "*": allow')
    expect(def).toContain('    "*.env": ask')
    expect(def).toContain('  edit: ask')
    expect(auto).toContain('  edit: allow')
    expect(auto).toContain('  bash: deny')
  })
})
