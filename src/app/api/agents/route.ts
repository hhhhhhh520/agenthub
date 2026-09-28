import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { sweepWithCurrentConfigs } from '@/lib/services/claude-cfg-maintenance'

// 导出供测试验证：如果有人修改这些值，测试会同步感知
export const XSS_TAG_RE = /<[a-zA-Z][^>]*>/
export const SELECTED_FIELDS = ['id', 'name', 'expertise', 'platform', 'model', 'baseUrl', 'tools', 'isPreset', 'accentColor', 'capabilities', 'status'] as const

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const preset = searchParams.get('preset')

  const where = preset === 'true' ? { isPreset: true } : {}
  const agents = await prisma.agent.findMany({
    where,
    orderBy: { name: 'asc' },
    select: { id:true, name:true, expertise:true, platform:true, model:true, baseUrl:true, tools:true, isPreset:true, accentColor:true, capabilities:true, status:true },
  })

  // ISSUE-027 生命周期（评审 #1 + 双审查 🟡）：全量视图加载时兜底出清受管配置目录
  //（key/端点轮换产生新目录，旧目录内含明文 key）。仅全量列表时执行——preset 过滤视图
  // 的子集不是合法 active 集合。sweepWithCurrentConfigs 内部任一数据源失败即抛 →
  // 跳过本轮（集合不完整时删 = 宁漏勿错）；sweep 自身有 12-hex + 哨兵双护栏。
  // 串行而非 Promise.all：保持 findMany 调用序确定（视图查询恒为第一次调用，测试断言依赖）。
  if (!preset) {
    try {
      await sweepWithCurrentConfigs()
    } catch {
      /* active 集合构造失败 → 跳过本轮 sweep */
    }
  }

  return NextResponse.json(agents)
}

export async function POST(request: Request) {
  const body = await request.json()
  const { name, expertise, systemPrompt, platform, model, baseUrl, apiKey, tools, capabilities, accentColor, providerRef } = body

  if (!name || !expertise || !systemPrompt || typeof name !== 'string' || typeof expertise !== 'string' || typeof systemPrompt !== 'string') {
    return NextResponse.json(
      { error: 'name, expertise, systemPrompt are required strings' },
      { status: 400 }
    )
  }

  if (XSS_TAG_RE.test(name)) {
    return NextResponse.json({ error: 'Agent name must not contain HTML tags' }, { status: 400 })
  }

  if (platform !== undefined && typeof platform !== 'string') {
    return NextResponse.json({ error: 'platform must be a string' }, { status: 400 })
  }
  if (accentColor !== undefined && typeof accentColor !== 'string') {
    return NextResponse.json({ error: 'accentColor must be a string' }, { status: 400 })
  }

  // #34 修复 ④:providerRef 路径——服务端解析真 apiKey,前端永远不传明文
  // providerRef 接受:① string(DB Provider id);② { name: string }(用 resolveProvider 跨 4 源查)
  // 防止前端拿到掩码字符串(***xxxx)后误当真 key 提交污染 DB
  let resolvedApiKey: string | undefined
  let resolvedBaseUrl: string | undefined
  if (providerRef) {
    if (typeof providerRef === 'string') {
      const provider = await prisma.provider.findUnique({
        where: { id: providerRef },
        select: { apiKey: true, baseUrl: true },
      })
      if (!provider) {
        return NextResponse.json({ error: 'providerRef not found' }, { status: 400 })
      }
      resolvedApiKey = provider.apiKey
      resolvedBaseUrl = provider.baseUrl
    } else if (typeof providerRef === 'object' && typeof providerRef.name === 'string') {
      const { resolveProvider } = await import('@/lib/provider-resolve')
      const resolved = await resolveProvider(providerRef.name)
      if (!resolved) {
        return NextResponse.json({ error: 'providerRef not found' }, { status: 400 })
      }
      resolvedApiKey = resolved.apiKey
      resolvedBaseUrl = resolved.baseUrl
    } else {
      return NextResponse.json({ error: 'providerRef must be string id or { name }' }, { status: 400 })
    }
  }

  try {
    const agent = await prisma.agent.create({
      data: {
        name,
        expertise,
        systemPrompt,
        platform: platform || 'claude-code',
        model: model || '',
        baseUrl: resolvedBaseUrl ?? baseUrl ?? '',
        apiKey: resolvedApiKey ?? apiKey ?? '',
        tools: JSON.stringify(tools || []),
        capabilities: JSON.stringify(capabilities || []),
        accentColor: accentColor || '#6366f1',
        isPreset: false,
      },
      select: { id:true, name:true, expertise:true, systemPrompt:true, platform:true, model:true, baseUrl:true, tools:true, isPreset:true, accentColor:true, capabilities:true, status:true },
    })
    return NextResponse.json(agent, { status: 201 })
  } catch (e: unknown) {
    if (e instanceof Error && 'code' in e && (e as { code: string }).code === 'P2002') {
      return NextResponse.json({ error: 'Agent name already exists' }, { status: 409 })
    }
    throw e
  }
}
