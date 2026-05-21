import { NextResponse } from 'next/server'
import { appendFileSync } from 'fs'
import { join } from 'path'

export async function POST(request: Request) {
  const { provider, agentType, baseUrl, model, apiKey } = await request.json()

  if (!provider || !apiKey || !baseUrl) {
    return NextResponse.json({ error: 'Missing required fields' }, { status: 400 })
  }

  try {
    const envPath = join(process.cwd(), '.env')
    const envLine = `\n# Imported from CC-Switch: ${provider} (${agentType})\nPROVIDER_BASE_URL=${baseUrl}\nPROVIDER_MODEL=${model}\nPROVIDER_API_KEY=${apiKey}\n`
    appendFileSync(envPath, envLine, 'utf-8')

    return NextResponse.json({ success: true, provider, baseUrl, model })
  } catch {
    return NextResponse.json({ error: 'Failed to save config' }, { status: 500 })
  }
}
