"use client"

import { ArrowLeft, Save, Bot, Sparkles } from "lucide-react"
import Link from "next/link"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Input } from "@/components/ui/input"

const mockAgent = {
  id: "a1",
  name: "Atlas",
  description: "Writes, refactors, and ships code. Reads your repo.",
  platform: "Claude Code",
  model: "claude-sonnet-4-6",
  status: "online",
  accentColor: "#3b82f6",
  capabilities: ["React", "TypeScript", "Node.js", "CSS"],
  systemPrompt:
    "You are Atlas, a senior software engineer. You write clean, well-tested code following best practices. You read the repository structure before making changes. You prefer incremental changes over large rewrites.",
  skills: ["代码读写", "命令执行"],
  recentActivity: [
    { id: "act1", type: "task", description: "搭建 TODO 应用脚手架", project: "TODO 应用开发", time: "2026-05-25 14:35" },
    { id: "act2", type: "task", description: "实现前端页面", project: "TODO 应用开发", time: "2026-05-25 15:20" },
    { id: "act3", type: "review", description: "代码审查 - API 接口", project: "API 接口测试", time: "2026-05-24 10:00" },
  ],
}

export default function AgentDetailPage() {
  const agent = mockAgent

  return (
    <div className="flex flex-1 flex-col gap-6 p-6 max-w-4xl">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Link href="/dashboard/agents" className="text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-4 w-4" />
        </Link>
        <Avatar className="h-10 w-10">
          <AvatarFallback className="text-sm text-white" style={{ backgroundColor: agent.accentColor }}>
            {agent.name.charAt(0)}
          </AvatarFallback>
        </Avatar>
        <div className="flex-1">
          <h1 className="text-lg font-semibold">{agent.name}</h1>
          <p className="text-xs text-muted-foreground">{agent.description}</p>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="outline" className="text-xs">{agent.platform}</Badge>
          <Badge variant="outline" className="text-xs">{agent.model}</Badge>
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
            {agent.capabilities.map((cap) => (
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
            defaultValue={agent.systemPrompt}
            rows={6}
            className="text-sm font-mono"
          />
          <div className="flex justify-end mt-2">
            <Button size="sm" className="gap-1">
              <Save className="h-3 w-3" /> 保存
            </Button>
          </div>
        </section>

        {/* Skills */}
        <section>
          <h2 className="text-sm font-medium mb-3">关联 Skill</h2>
          <div className="space-y-2">
            {agent.skills.map((skill) => (
              <div key={skill} className="flex items-center gap-2 p-2 rounded border">
                <Sparkles className="h-4 w-4 text-purple-500" />
                <span className="text-sm">{skill}</span>
              </div>
            ))}
            <Link href="/dashboard/skills" className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1 mt-1">
              管理所有 Skill →
            </Link>
          </div>
        </section>

        {/* Recent activity */}
        <section>
          <h2 className="text-sm font-medium mb-3">最近活动</h2>
          <div className="space-y-2">
            {agent.recentActivity.map((activity) => (
              <div key={activity.id} className="flex items-center gap-3 p-2 rounded border text-sm">
                <Bot className="h-4 w-4 text-muted-foreground shrink-0" />
                <div className="flex-1 min-w-0">
                  <span className="font-medium">{activity.description}</span>
                  <span className="text-muted-foreground ml-2">· {activity.project}</span>
                </div>
                <span className="text-xs text-muted-foreground shrink-0">{activity.time}</span>
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  )
}