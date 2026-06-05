"use client"

import { ArrowLeft, Save } from "lucide-react"
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

  useEffect(() => {
    if (!params.id) return
    fetch(`/api/agents/${params.id}`)
      .then(r => r.json())
      .then(data => { setAgent(data); setLoading(false) })
      .catch(() => setLoading(false))
  }, [params.id])

  if (loading) {
    return <div className="flex-1 flex items-center justify-center text-gray-400">加载中...</div>
  }
  if (!agent) {
    return <div className="flex-1 flex items-center justify-center text-gray-400">智能体不存在</div>
  }

  const capabilities: string[] = (() => { try { return JSON.parse(agent.capabilities) } catch { return [] } })()

  return (
    <div className="flex flex-1 flex-col gap-6 p-6 max-w-4xl">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Link href="/agents" className="text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-4 w-4" />
        </Link>
        <Avatar className="h-10 w-10">
          <AvatarFallback className="text-sm text-white" style={{ backgroundColor: agent.accentColor }}>
            {agent.name.charAt(0)}
          </AvatarFallback>
        </Avatar>
        <div className="flex-1">
          <h1 className="text-lg font-semibold">{agent.name}</h1>
          <p className="text-xs text-muted-foreground">{agent.expertise}</p>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="outline" className="text-xs">{agent.platform === 'opencode' ? 'OpenCode' : 'Claude Code'}</Badge>
          {agent.model && <Badge variant="outline" className="text-xs">{agent.model}</Badge>}
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
              <Input defaultValue={agent.name} className="h-8 text-sm" />
            </div>
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">模型</label>
              <Input defaultValue={agent.model} className="h-8 text-sm" />
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
            defaultValue={agent.systemPrompt || ""}
            rows={6}
            className="text-sm font-mono"
          />
          <div className="flex justify-end mt-2">
            <Button size="sm" className="gap-1">
              <Save className="h-3 w-3" /> 保存
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
              <div className="text-sm">{agent.model || "未配置"}</div>
            </div>
          </div>
        </section>
      </div>
    </div>
  )
}