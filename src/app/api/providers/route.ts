import { NextResponse } from 'next/server'
import { readFileSync } from 'fs'
import { join } from 'path'

export async function GET() {
  try {
    const presetsPath = join(process.cwd(), '..', 'cc-connect', 'provider-presets.json')
    const raw = readFileSync(presetsPath, 'utf-8')
    const data = JSON.parse(raw)
    return NextResponse.json(data.providers || [])
  } catch {
    // Fallback: try relative to project root
    try {
      const altPath = join(process.cwd(), 'provider-presets.json')
      const raw = readFileSync(altPath, 'utf-8')
      const data = JSON.parse(raw)
      return NextResponse.json(data.providers || [])
    } catch {
      return NextResponse.json({ error: 'Provider presets not found' }, { status: 404 })
    }
  }
}
