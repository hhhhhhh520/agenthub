import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// ── ISSUE-027 接线守卫（源码断言式）──
//
// 教训（2026-09-20 安全批次）：变异函数体测不出接线断裂——mock 掉 registry 的单测里，
// 删掉 adapter 的接线行不会红。本守卫直接断言源码中接线语句存在；
// 变异（删除接线行/改字段名）必然红。

const ADAPTER_SRC = readFileSync(resolve(__dirname, '../src/lib/adapter/claude-code-adapter.ts'), 'utf-8')
const REGISTRY_SRC = readFileSync(resolve(__dirname, '../src/lib/adapter/process-registry.ts'), 'utf-8')
const AGENTS_ROUTE_SRC = readFileSync(resolve(__dirname, '../src/app/api/agents/route.ts'), 'utf-8')

describe('ISSUE-027 接线守卫：claude-code adapter → 受管 CLAUDE_CONFIG_DIR 通道', () => {
  it('adapter.send() 调用 ensureClaudeConfigDir 并注入 CLAUDE_CONFIG_DIR + envScrub', () => {
    expect(ADAPTER_SRC).toContain('ensureClaudeConfigDir(')
    expect(ADAPTER_SRC).toContain('CLAUDE_CONFIG_DIR')
    expect(ADAPTER_SRC).toContain('claudeEnvScrub()')
    // 缺配置 agent 的降级分支必须保留（null → 旧行为）
    expect(ADAPTER_SRC).toMatch(/if \(cfgDir\)/)
  })
  it('registry.spawnProcess 用 composeSpawnEnv 组合 env（envScrub 过滤生效点）', () => {
    expect(REGISTRY_SRC).toContain('composeSpawnEnv(process.env, config, providerEnv)')
    expect(REGISTRY_SRC).toContain('envScrub?: { prefixes: string[]; exact: string[] }')
  })
  it('agents 列表路由挂 sweep（生命周期出清，评审 #1），且仅全量视图执行', () => {
    expect(AGENTS_ROUTE_SRC).toContain('sweepWithCurrentConfigs(')
    expect(AGENTS_ROUTE_SRC).toMatch(/if \(!preset\) \{[^]*?sweepWithCurrentConfigs/)
  })
  it('route sweep 的 active 集合并入 orchestrator fallback，且构造失败整体跳过（双审查 🟡）', () => {
    expect(AGENTS_ROUTE_SRC).toMatch(/try \{[^]*?sweepWithCurrentConfigs\(\)[^]*?\} catch/)
    const helper = readFileSync(resolve(__dirname, '../src/lib/services/claude-cfg-maintenance.ts'), 'utf-8')
    expect(helper).toContain('getOrchestratorAgent()')
  })
  it('registry.send retry 循环挂 resume 降级（--resume 落空 → 丢 sessionId fresh）', () => {
    expect(REGISTRY_SRC).toContain('isSessionNotFoundError(lastError)')
    expect(REGISTRY_SRC).toContain('dropResume')
    expect(REGISTRY_SRC).toContain('latestSessionId = null')
  })
  it('sweep helper 并入 orchestrator fallback 双数据源（双审查 🟡）', () => {
    const helper = readFileSync(resolve(__dirname, '../src/lib/services/claude-cfg-maintenance.ts'), 'utf-8')
    expect(helper).toContain('getOrchestratorAgent()')
    expect(helper).toContain('sweepAgentClaudeConfigDirs(')
  })
  it('启动兜底 sweep 接线（instrumentation.register，生命周期审查 🟡1.1）', () => {
    const instr = readFileSync(resolve(__dirname, '../src/instrumentation.ts'), 'utf-8')
    expect(instr).toContain('sweepWithCurrentConfigs')
  })
})
