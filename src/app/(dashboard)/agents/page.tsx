"use client"

import { useEffect, useState, useMemo } from "react"
import Link from "next/link"
import { Plus, Search } from "lucide-react"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { CreateAgentDialog } from "@/components/create-agent-dialog"

interface Agent {
  id: string
  name: string
  expertise: string
  platform: string
  model?: string
  status: string
  accentColor: string
  capabilities: string
}

const statusLabels: Record<string, { text: string; color: string }> = {
  idle: { text: "空闲", color: "bg-gray-400" },
  working: { text: "工作中", color: "bg-yellow-500" },
  done: { text: "已完成", color: "bg-green-500" },
  error: { text: "异常", color: "bg-red-500" },
}

export default function AgentsPage() {
  const [agents, setAgents] = useState<Agent[]>([])
  const [search, setSearch] = useState("")
  const [showCreate, setShowCreate] = useState(false)

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
            能领取 issue、留下评论、推进状态的 AI 队友
          </p>
        </div>
        <Button size="sm" className="gap-1" onClick={() => setShowCreate(true)}>
          <Plus className="h-4 w-4" /> 创建智能体
        </Button>
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
              <th className="px-4 py-2 text-xs font-medium text-muted-foreground text-left">状态</th>
              <th className="px-4 py-2 text-xs font-medium text-muted-foreground text-left">运行时</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((agent) => {
              const caps: string[] = (() => { try { return JSON.parse(agent.capabilities) } catch { return [] } })()
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
                    <div className="flex items-center gap-1.5">
                      <span className={`h-2 w-2 rounded-full ${statusLabels[agent.status]?.color || "bg-gray-400"}`} />
                      <span className="text-xs">{statusLabels[agent.status]?.text || agent.status}</span>
                    </div>
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
    </div>
  )
}
