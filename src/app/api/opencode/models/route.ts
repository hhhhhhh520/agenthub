import { NextResponse } from 'next/server'
import { exec } from 'child_process'
import { promisify } from 'util'

const execAsync = promisify(exec)

export async function GET() {
  try {
    const { stdout } = await execAsync('opencode models', {
      timeout: 5000,
      windowsHide: true,
    })

    const models: Array<{ id: string; provider: string }> = []
    const seen = new Set<string>()

    for (const line of stdout.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed || !trimmed.includes('/')) continue
      // Skip header rows (uppercase)
      if (trimmed === trimmed.toUpperCase()) continue

      const id = trimmed.split(/\s+/)[0]
      if (seen.has(id)) continue
      seen.add(id)

      const provider = id.split('/')[0] || ''
      models.push({ id, provider })
    }

    return NextResponse.json({ models })
  } catch {
    return NextResponse.json({ models: [] })
  }
}
