import { NextResponse } from 'next/server'

export async function POST(request: Request) {
  const { files } = await request.json()

  const deployId = Math.random().toString(36).slice(2, 8)
  const url = `https://agenthub-${deployId}.vercel.app`

  return NextResponse.json({
    success: true,
    url,
    message: 'Deploy simulated. Connect Vercel API for real deployment.',
  })
}
