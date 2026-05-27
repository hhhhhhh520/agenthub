"use client"

import { ArrowLeft, Save, Plus, X } from "lucide-react"
import Link from "next/link"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"

const mockSkill = {
  id: "sk1",
  name: "代码读写",
  description: "读取和编写源代码文件，支持多种编程语言。包括创建新文件、编辑现有文件、搜索代码等能力。",
  tools: ["Read", "Write", "Edit"],
  prompt:
    "You have access to file system tools. When reading code, analyze the structure first. When writing code, follow existing patterns in the codebase. When editing, make minimal changes that solve the problem. Always verify your changes compile/run before reporting completion.",
  agents: [
    { id: "a1", name: "Atlas", accentColor: "#3b82f6" },
    { id: "a4", name: "前端工程师", accentColor: "#06b6d4" },
  ],
}

export default function SkillDetailPage() {
  const skill = mockSkill

  return (
    <div className="flex flex-1 flex-col gap-6 p-6 max-w-4xl">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Link href="/dashboard/skills" className="text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-4 w-4" />
        </Link>
        <div className="flex-1">
          <h1 className="text-lg font-semibold">{skill.name}</h1>
          <p className="text-xs text-muted-foreground">{skill.description}</p>
        </div>
      </div>

      <div className="space-y-6">
        {/* Basic info */}
        <section>
          <h2 className="text-sm font-medium mb-3">基本信息</h2>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">名称</label>
              <Input defaultValue={skill.name} className="h-8 text-sm" />
            </div>
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">描述</label>
              <Input defaultValue={skill.description} className="h-8 text-sm" />
            </div>
          </div>
        </section>

        {/* Tools */}
        <section>
          <h2 className="text-sm font-medium mb-3">工具集</h2>
          <div className="flex flex-wrap gap-2">
            {skill.tools.map((tool) => (
              <div key={tool} className="flex items-center gap-1 rounded-md border px-2 py-1">
                <span className="text-xs font-mono">{tool}</span>
                <button className="text-muted-foreground hover:text-foreground">
                  <X className="h-3 w-3" />
                </button>
              </div>
            ))}
            <Button variant="outline" size="sm" className="h-7 text-xs gap-1">
              <Plus className="h-3 w-3" /> 添加工具
            </Button>
          </div>
        </section>

        {/* Prompt */}
        <section>
          <h2 className="text-sm font-medium mb-3">Skill Prompt</h2>
          <Textarea
            defaultValue={skill.prompt}
            rows={6}
            className="text-sm font-mono"
          />
          <div className="flex justify-end mt-2">
            <Button size="sm" className="gap-1">
              <Save className="h-3 w-3" /> 保存
            </Button>
          </div>
        </section>

        {/* Associated agents */}
        <section>
          <h2 className="text-sm font-medium mb-3">关联智能体</h2>
          <div className="space-y-2">
            {skill.agents.map((agent) => (
              <Link
                key={agent.id}
                href={`/dashboard/agents/${agent.id}`}
                className="flex items-center gap-2 p-2 rounded border hover:bg-accent transition-colors"
              >
                <Avatar className="h-6 w-6">
                  <AvatarFallback className="text-xs text-white" style={{ backgroundColor: agent.accentColor }}>
                    {agent.name.charAt(0)}
                  </AvatarFallback>
                </Avatar>
                <span className="text-sm font-medium">{agent.name}</span>
                <Badge variant="outline" className="text-xs ml-auto">查看 →</Badge>
              </Link>
            ))}
          </div>
        </section>
      </div>
    </div>
  )
}