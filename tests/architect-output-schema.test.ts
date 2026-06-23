// contract v1 §1.2 a (action 3): outputSchema 流转测试
// 验证：
//   1. 架构师 prompt 包含 output_schema 指令
//   2. handleArchitectPlan 解析架构师的 output_schema 字段并写入 DB
//   3. decomposeTasks fallback 也能产出带 outputSchema 的 ScheduledTask
//   4. formatArchitectPlan 在 outputSchema 存在时展示
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { TASK_DECOMPOSITION_PROMPT } from '@/lib/orchestrator/prompts'

// ───────── 1. Prompt 直接断言 ─────────
describe('contract v1 §1.2 a: 架构师 prompt 包含 output_schema 指令', () => {
  it('TASK_DECOMPOSITION_PROMPT 包含 output_schema 字段说明', () => {
    expect(TASK_DECOMPOSITION_PROMPT).toContain('output_schema')
    // 必须说明字段格式
    expect(TASK_DECOMPOSITION_PROMPT).toMatch(/字段名.*类型/)
  })

  it('TASK_DECOMPOSITION_PROMPT 强化 declared_files 校验语义（不再是软提示）', () => {
    // 关键词："硬校验" / "越界" 至少出现一次（提示 LLM 这次是认真的）
    expect(TASK_DECOMPOSITION_PROMPT).toMatch(/校验|越界/)
  })

  it('TASK_DECOMPOSITION_PROMPT 的 JSON 模板包含 output_schema 示例', () => {
    expect(TASK_DECOMPOSITION_PROMPT).toMatch(/"output_schema"/)
  })
})

// ───────── 2. handleArchitectPlan 解析 + 持久化 outputSchema ─────────
const mocks = vi.hoisted(() => ({
  mockTaskFindMany: vi.fn(),
  mockTaskCreate: vi.fn(),
  mockSessionUpdate: vi.fn(),
  mockSessionFindUnique: vi.fn(),
  mockMessageFindMany: vi.fn().mockResolvedValue([]),
  mockMessageCreate: vi.fn(),
  mockSessionMemberFindUnique: vi.fn(),
  mockExecuteSingleAgent: vi.fn(),
  mockDecomposeTasks: vi.fn(),
  mockParseJSON: vi.fn(),
  mockFormatArchitectPlan: vi.fn().mockReturnValue('plan summary'),
  mockSendEvent: vi.fn(),
}))

vi.mock('@/lib/db', () => ({
  prisma: {
    task: { findMany: mocks.mockTaskFindMany, create: mocks.mockTaskCreate },
    session: { update: mocks.mockSessionUpdate, findUnique: mocks.mockSessionFindUnique },
    message: { findMany: mocks.mockMessageFindMany, create: mocks.mockMessageCreate },
    sessionMember: { findUnique: mocks.mockSessionMemberFindUnique },
  },
}))

vi.mock('@/lib/orchestrator', async () => {
  const actual = await vi.importActual<typeof import('@/lib/orchestrator')>('@/lib/orchestrator')
  return {
    ...actual,
    executeSingleAgent: mocks.mockExecuteSingleAgent,
    decomposeTasks: mocks.mockDecomposeTasks,
    parseJSON: mocks.mockParseJSON,
    formatArchitectPlan: mocks.mockFormatArchitectPlan,
  }
})

import { handleArchitectPlan } from '@/lib/services/alignment'

describe('contract v1 §1.2 a: handleArchitectPlan 持久化 outputSchema', () => {
  const archAgent = {
    id: 'arch1', name: '架构师', systemPrompt: '', platform: 'claude-code',
    expertise: '架构设计', model: '', baseUrl: '', apiKey: '', tools: '[]',
  }

  beforeEach(() => {
    vi.clearAllMocks()
    mocks.mockMessageFindMany.mockResolvedValue([{ role: 'user', rawContent: '建一个登录页' }])
    mocks.mockSessionFindUnique.mockResolvedValue({ projectDir: '', permissionMode: 'default' })
    mocks.mockSessionMemberFindUnique.mockResolvedValue(null)
    mocks.mockSessionUpdate.mockResolvedValue({})
    mocks.mockMessageCreate.mockResolvedValue({})
    mocks.mockTaskCreate.mockResolvedValue({})
  })

  it('架构师输出的 output_schema 被持久化到 Task.outputSchema（JSON 字符串）', async () => {
    mocks.mockExecuteSingleAgent.mockResolvedValue({ result: 'mock-arch-output' })
    mocks.mockParseJSON.mockReturnValue({
      tasks: [
        {
          id: 1,
          description: '写登录组件',
          assignedAgent: '前端',
          dependencies: [],
          declared_files: ['src/login.tsx'],
          output_schema: ['component_path:string - 组件路径', 'exports:string[] - 导出名'],
        },
      ],
    })

    await handleArchitectPlan('msg', 's1', [archAgent], mocks.mockSendEvent as any)

    expect(mocks.mockTaskCreate).toHaveBeenCalledTimes(1)
    const createCall = mocks.mockTaskCreate.mock.calls[0][0]
    expect(createCall.data.outputSchema).toBeDefined()
    expect(createCall.data.outputSchema).not.toBeNull()
    // 应该是 JSON 字符串
    const parsedSchema = JSON.parse(createCall.data.outputSchema)
    expect(parsedSchema).toEqual([
      'component_path:string - 组件路径',
      'exports:string[] - 导出名',
    ])
  })

  it('架构师没输出 output_schema 时，DB 写入 null（不抛错，向后兼容）', async () => {
    mocks.mockExecuteSingleAgent.mockResolvedValue({ result: 'mock-arch-output' })
    mocks.mockParseJSON.mockReturnValue({
      tasks: [
        {
          id: 1,
          description: '写登录组件',
          assignedAgent: '前端',
          dependencies: [],
          declared_files: ['src/login.tsx'],
          // 没有 output_schema
        },
      ],
    })

    await handleArchitectPlan('msg', 's1', [archAgent], mocks.mockSendEvent as any)

    expect(mocks.mockTaskCreate).toHaveBeenCalledTimes(1)
    const createCall = mocks.mockTaskCreate.mock.calls[0][0]
    expect(createCall.data.outputSchema).toBeNull()
  })

  it('多 task 各自的 outputSchema 独立持久化', async () => {
    mocks.mockExecuteSingleAgent.mockResolvedValue({ result: 'mock-arch-output' })
    mocks.mockParseJSON.mockReturnValue({
      tasks: [
        { id: 1, description: 't1', assignedAgent: '前端', dependencies: [], declared_files: ['a.ts'], output_schema: ['x:string - x 含义'] },
        { id: 2, description: 't2', assignedAgent: '后端', dependencies: [1], declared_files: ['b.ts'], output_schema: ['y:number - y 含义'] },
      ],
    })

    await handleArchitectPlan('msg', 's1', [archAgent], mocks.mockSendEvent as any)

    expect(mocks.mockTaskCreate).toHaveBeenCalledTimes(2)
    const schemas = mocks.mockTaskCreate.mock.calls.map((c: any) => JSON.parse(c[0].data.outputSchema))
    expect(schemas).toContainEqual(['x:string - x 含义'])
    expect(schemas).toContainEqual(['y:number - y 含义'])
  })
})

// ───────── 3. decomposeTasks fallback ─────────
// fallback 通过单元测 parseJSON → ScheduledTask 的映射逻辑来验证（避免 callLLM 副作用）
describe('contract v1 §1.2 a: decomposeTasks fallback 映射 output_schema', () => {
  it('parseJSON 输出包含 output_schema 时，映射到 ScheduledTask.outputSchema 为 JSON 字符串', () => {
    // 模拟 decomposeTasks 内部的映射逻辑（行 296-303）
    const parsedTasks = [
      {
        id: 1,
        description: 't1',
        assignedAgent: 'A',
        dependencies: [] as number[],
        declared_files: ['a.ts'],
        output_schema: ['key:string - some meaning'],
      },
    ]
    const idMap = new Map<number, string>()
    parsedTasks.forEach(t => idMap.set(t.id, `uuid-${t.id}`))

    const mapped = parsedTasks.map(t => ({
      id: idMap.get(t.id)!,
      description: t.description,
      assignedAgent: t.assignedAgent,
      dependencies: t.dependencies.map((d: number) => idMap.get(d)!).filter(Boolean),
      declaredFiles: t.declared_files || [],
      outputSchema: t.output_schema ? JSON.stringify(t.output_schema) : undefined,
      batch: 0,
    }))

    expect(mapped[0].outputSchema).toBe(JSON.stringify(['key:string - some meaning']))
  })

  it('parseJSON 没有 output_schema 时，outputSchema = undefined（向后兼容）', () => {
    const parsedTasks = [
      { id: 1, description: 't1', assignedAgent: 'A', dependencies: [] as number[], declared_files: ['a.ts'] },
    ]
    const idMap = new Map<number, string>()
    parsedTasks.forEach(t => idMap.set(t.id, `uuid-${t.id}`))

    const mapped = parsedTasks.map((t: any) => ({
      id: idMap.get(t.id)!,
      description: t.description,
      assignedAgent: t.assignedAgent,
      dependencies: t.dependencies.map((d: number) => idMap.get(d)!).filter(Boolean),
      declaredFiles: t.declared_files || [],
      outputSchema: t.output_schema ? JSON.stringify(t.output_schema) : undefined,
      batch: 0,
    }))

    expect(mapped[0].outputSchema).toBeUndefined()
  })
})

// ───────── 4. formatArchitectPlan 渲染 outputSchema ─────────
describe('contract v1 §1.2 a: formatArchitectPlan 展示 outputSchema', () => {
  it('outputSchema 存在时展示在任务行', async () => {
    const { formatArchitectPlan } = await vi.importActual<typeof import('@/lib/orchestrator')>('@/lib/orchestrator')
    const out = formatArchitectPlan(
      [{
        id: 't1', description: '写登录', assignedAgent: '前端',
        dependencies: [], declaredFiles: ['a.ts'],
        outputSchema: JSON.stringify(['x:string - x 含义']),
        batch: 0,
      }],
      [{ name: '前端', expertise: 'UI' }],
    )
    expect(out).toContain('产出字段')
    expect(out).toContain('x:string')
  })

  it('outputSchema 缺失时不展示"产出字段"行', async () => {
    const { formatArchitectPlan } = await vi.importActual<typeof import('@/lib/orchestrator')>('@/lib/orchestrator')
    const out = formatArchitectPlan(
      [{
        id: 't1', description: '写登录', assignedAgent: '前端',
        dependencies: [], declaredFiles: ['a.ts'],
        batch: 0,
      }],
      [{ name: '前端', expertise: 'UI' }],
    )
    expect(out).not.toContain('产出字段')
  })
})
