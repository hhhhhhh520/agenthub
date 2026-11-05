"use client"

import { useEffect, useState, useMemo } from "react"
import Link from "next/link"
import { Plus, Search, Download } from "lucide-react"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { CreateAgentDialog } from "@/components/create-agent-dialog"
import { ProviderImportDialog } from "@/components/provider-import-dialog"
import { assertOkResponse } from "@/lib/http-error"
import type { AgentPresenceSummary } from "@/lib/agent-presence"

interface Agent extends AgentPresenceSummary {
  id: string
  name: string
  expertise: string
  platform: string
  model?: string
  accentColor: string
  capabilities: string
}

const statusLabels: Record<string, { text: string; color: string }> = {
  idle: { text: "空闲", color: "bg-gray-400" },
  working: { text: "工作中", color: "bg-emerald-500 animate-pulse" },
  done: { text: "已完成", color: "bg-blue-500" },
  error: { text: "异常", color: "bg-red-500" },
}

export default function AgentsPage() {
  const [agents, setAgents] = useState<Agent[]>([])
  const [search, setSearch] = useState("")
  const [showCreate, setShowCreate] = useState(false)
  const [showImport, setShowImport] = useState(false)

  const loadAgents = () => {
    fetch('/api/agents').then(r => r.json()).then(d => { if (Array.isArray(d)) setAgents(d) })
  }

  useEffect(() => { loadAgents() }, [])

  const filtered = useMemo(() => {
    if (!search.trim()) return agents
    const q = search.toLowerCase()
    return agents.filter(a => a.name.toLowerCase().includes(q) || a.expertise.toLowerCase().includes(q))
  }, [agents, search])

  return (
    <div className="flex flex-1 flex-col gap-6 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">智能体</h1>
          <p className="text-sm text-muted-foreground mt-1">
            选择或创建智能体，配置模型和技能，参与多智能体协作
          </p>
        </div>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" className="gap-1" onClick={() => setShowImport(true)}>
            <Download className="h-4 w-4" /> 导入服务商
          </Button>
          <Button size="sm" className="gap-1" onClick={() => setShowCreate(true)}>
            <Plus className="h-4 w-4" /> 创建智能体
          </Button>
        </div>
      </div>

      {/* Filter row */}
      <div className="flex items-center gap-3">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input placeholder="搜索智能体..." className="pl-8 h-9" value={search} onChange={e => setSearch(e.target.value)} />
        </div>
      </div>

      {/* Agent table */}
      <div className="rounded-lg border overflow-hidden">
        <table className="w-full">
          <thead>
            <tr className="border-b bg-muted/50">
              <th className="px-4 py-2 text-xs font-medium text-muted-foreground text-left">智能体</th>
              <th className="px-4 py-2 text-xs font-medium text-muted-foreground text-left">描述</th>
              <th className="px-4 py-2 text-xs font-medium text-muted-foreground text-left">当前会话</th>
              <th className="px-4 py-2 text-xs font-medium text-muted-foreground text-left">运行时</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((agent) => {
              const caps: string[] = (() => { try { return JSON.parse(agent.capabilities) } catch { return [] } })()
              const current = agent.currentSession
              const status = current ? (statusLabels[current.status] || { text: current.status, color: "bg-gray-400" }) : null
              const workingCount = agent.workingSessionCount || 0
              return (
                <tr key={agent.id} className="border-b last:border-0 hover:bg-accent/50 transition-colors">
                  <td className="px-4 py-3">
                    <Link href={`/agents/${agent.id}`} className="flex items-center gap-2 hover:underline">
                      <Avatar className="h-7 w-7">
                        <AvatarFallback className="text-xs text-white" style={{ backgroundColor: agent.accentColor }}>
                          {agent.name.charAt(0)}
                        </AvatarFallback>
                      </Avatar>
                      <span className="font-medium text-sm">{agent.name}</span>
                    </Link>
                  </td>
                  <td className="px-4 py-3">
                    <p className="text-xs text-muted-foreground line-clamp-2 max-w-xs">{agent.expertise}</p>
                    {caps.length > 0 && (
                      <div className="flex flex-wrap gap-1 mt-1">
                        {caps.slice(0, 3).map(cap => (
                          <Badge key={cap} variant="secondary" className="text-xs">{cap}</Badge>
                        ))}
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    {workingCount > 0 ? (
                      <div className="flex items-center gap-1.5">
                        <span className="h-2 w-2 rounded-full bg-emerald-500 animate-pulse" />
                        <span className="text-xs font-medium text-emerald-700">工作中</span>
                        {workingCount > 1 && (
                          <span className="text-xs text-muted-foreground">· {workingCount} 个会话</span>
                        )}
                      </div>
                    ) : status ? (
                      <div className="flex items-center gap-1.5">
                        <span className={`h-2 w-2 rounded-full ${status.color}`} />
                        <span className="text-xs">{status.text}</span>
                      </div>
                    ) : (
                      <span className="text-xs text-muted-foreground">未加入会话</span>
                    )}
                    {current && (
                      <Link
                        href={`/chat?session=${current.id}`}
                        className="mt-1 block max-w-[180px] truncate text-xs text-muted-foreground hover:text-foreground"
                        title={current.title}
                      >
                        {current.title}
                      </Link>
                    )}
                    {agent.sessionCount > 1 && (
                      <span className="mt-0.5 block text-xs text-muted-foreground">共 {agent.sessionCount} 个会话</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <span className="text-xs text-muted-foreground">{agent.platform === 'opencode' ? 'OpenCode' : 'Claude Code'}</span>
                  </td>
                </tr>
              )
            })}
            {filtered.length === 0 && (
              <tr><td colSpan={4} className="px-4 py-8 text-center text-sm text-muted-foreground">暂无智能体</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <CreateAgentDialog open={showCreate} onOpenChange={setShowCreate} onCreated={loadAgents} />
      <ProviderImportDialog
        open={showImport}
        onOpenChange={setShowImport}
        onImport={async (config) => {
          const res = await fetch('/api/providers/import', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(config),
          })
          await assertOkResponse(res, '导入服务商失败')
          loadAgents()
        }}
      />
    </div>
  )
}
