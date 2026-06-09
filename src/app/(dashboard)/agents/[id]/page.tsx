"use client"

import { ArrowLeft, Save, Check } from "lucide-react"
import Link from "next/link"
import { useParams } from "next/navigation"
import { useState, useEffect } from "react"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Input } from "@/components/ui/input"

interface Agent {
  id: string
  name: string
  expertise: string
  systemPrompt?: string
  platform: string
  model?: string
  baseUrl?: string
  apiKey?: string
  status: string
  accentColor: string
  capabilities: string
  isPreset: boolean
}

export default function AgentDetailPage() {
  const params = useParams()
  const [agent, setAgent] = useState<Agent | null>(null)
  const [loading, setLoading] = useState(true)
  const [defaultModel, setDefaultModel] = useState('')

  // 受控字段
  const [name, setName] = useState('')
  const [model, setModel] = useState('')
  const [systemPrompt, setSystemPrompt] = useState('')

  // 保存状态
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    if (!params.id) return
    fetch(`/api/agents/${params.id}`)
      .then(r => r.json())
      .then(data => {
        setAgent(data)
        setName(data.name || '')
        setModel(data.model || '')
        setSystemPrompt(data.systemPrompt || '')
        setLoading(false)
      })
      .catch(() => setLoading(false))
    // 检测 CLI 默认模型
    fetch('/api/config/detect-platform', { method: 'POST' })
      .then(r => r.json())
      .then(data => { if (data.defaultModel) setDefaultModel(data.defaultModel) })
      .catch(() => {})
  }, [params.id])

  const handleSave = async () => {
    if (!agent) return
    setSaving(true)
    setSaved(false)
    try {
      const res = await fetch(`/api/agents/${agent.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, model, systemPrompt }),
      })
      if (res.ok) {
        const updated = await res.json()
        setAgent(updated)
        setName(updated.name)
        setModel(updated.model || '')
        setSystemPrompt(updated.systemPrompt || '')
        setSaved(true)
        setTimeout(() => setSaved(false), 2000)
      }
    } catch (e) {
      console.error('Save failed:', e)
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return <div className="flex-1 flex items-center justify-center text-gray-400">加载中...</div>
  }
  if (!agent) {
    return <div className="flex-1 flex items-center justify-center text-gray-400">智能体不存在</div>
  }

  const capabilities: string[] = (() => { try { return JSON.parse(agent.capabilities) } catch { return [] } })()
  const displayModel = agent.model || defaultModel || 'CLI 默认模型'

  return (
    <div className="flex flex-1 flex-col gap-6 p-6 max-w-4xl">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Link href="/agents" className="text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-4 w-4" />
        </Link>
        <Avatar className="h-10 w-10">
          <AvatarFallback className="text-sm text-white" style={{ backgroundColor: agent.accentColor }}>
            {name.charAt(0)}
          </AvatarFallback>
        </Avatar>
        <div className="flex-1">
          <h1 className="text-lg font-semibold">{name}</h1>
          <p className="text-xs text-muted-foreground">{agent.expertise}</p>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="outline" className="text-xs">{agent.platform === 'opencode' ? 'OpenCode' : 'Claude Code'}</Badge>
          <Badge variant="outline" className="text-xs">{displayModel}</Badge>
        </div>
      </div>

      {/* Sections */}
      <div className="space-y-6">
        {/* Basic info */}
        <section>
          <h2 className="text-sm font-medium mb-3">基本信息</h2>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">名称</label>
              <Input value={name} onChange={e => setName(e.target.value)} className="h-8 text-sm" />
            </div>
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">模型</label>
              <Input value={model} onChange={e => setModel(e.target.value)} placeholder={defaultModel || 'CLI 默认模型'} className="h-8 text-sm" />
            </div>
          </div>
        </section>

        {/* Capabilities */}
        <section>
          <h2 className="text-sm font-medium mb-3">能力标签</h2>
          <div className="flex flex-wrap gap-2">
            {capabilities.map((cap) => (
              <Badge key={cap} variant="secondary" className="text-xs">{cap}</Badge>
            ))}
            <Button variant="outline" size="sm" className="h-6 text-xs gap-1">
              + 添加
            </Button>
          </div>
        </section>

        {/* System Prompt */}
        <section>
          <h2 className="text-sm font-medium mb-3">System Prompt</h2>
          <Textarea
            value={systemPrompt}
            onChange={e => setSystemPrompt(e.target.value)}
            rows={6}
            className="text-sm font-mono"
          />
          <div className="flex justify-end mt-2">
            <Button size="sm" className="gap-1" onClick={handleSave} disabled={saving}>
              {saved ? <><Check className="h-3 w-3" /> 已保存</> : saving ? '保存中...' : <><Save className="h-3 w-3" /> 保存</>}
            </Button>
          </div>
        </section>

        {/* Platform & Model */}
        <section>
          <h2 className="text-sm font-medium mb-3">运行信息</h2>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">平台</label>
              <div className="text-sm">{agent.platform === 'opencode' ? 'OpenCode CLI' : 'Claude Code CLI'}</div>
            </div>
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">模型</label>
              <div className="text-sm">{displayModel}</div>
            </div>
          </div>
        </section>
      </div>
    </div>
  )
}
