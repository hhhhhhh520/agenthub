"use client"

import Link from "next/link"
import { Plus, Search, Sparkles, Bot } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"

const mockSkills = [
  {
    id: "sk1",
    name: "代码读写",
    description: "读取和编写源代码文件，支持多种编程语言",
    tools: ["Read", "Write", "Edit"],
    agentCount: 2,
    agents: ["Atlas", "前端工程师"],
  },
  {
    id: "sk2",
    name: "命令执行",
    description: "运行 shell 命令，构建项目，执行测试",
    tools: ["Bash"],
    agentCount: 2,
    agents: ["Atlas", "测试工程师"],
  },
  {
    id: "sk3",
    name: "代码审查",
    description: "分析代码质量、安全漏洞和性能问题",
    tools: ["Read", "Grep", "Glob"],
    agentCount: 1,
    agents: ["代码审查"],
  },
  {
    id: "sk4",
    name: "Web 搜索",
    description: "搜索互联网获取最新信息和技术文档",
    tools: ["WebSearch", "WebFetch"],
    agentCount: 1,
    agents: ["Atlas"],
  },
]

export default function SkillsPage() {
  return (
    <div className="flex flex-1 flex-col gap-6 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Skill</h1>
          <p className="text-sm text-muted-foreground mt-1">定义智能体可使用的能力和工具</p>
        </div>
        <Button size="sm" className="gap-1">
          <Plus className="h-4 w-4" /> 创建 Skill
        </Button>
      </div>

      {/* Filter */}
      <div className="relative max-w-sm">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input placeholder="搜索 Skill..." className="pl-8 h-9" />
      </div>

      {/* Skills grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {mockSkills.map((skill) => (
          <Link
            key={skill.id}
            href={`/skills/${skill.id}`}
            className="rounded-lg border bg-card p-4 hover:bg-accent transition-colors group"
          >
            <div className="flex items-start gap-3">
              <div className="flex h-9 w-9 items-center justify-center rounded-md bg-purple-100 text-purple-700 shrink-0">
                <Sparkles className="h-4 w-4" />
              </div>
              <div className="flex-1 min-w-0">
                <h3 className="font-medium text-sm group-hover:underline">{skill.name}</h3>
                <p className="text-xs text-muted-foreground mt-1 line-clamp-2">{skill.description}</p>
              </div>
            </div>

            <div className="mt-3 flex flex-wrap gap-1">
              {skill.tools.map((tool) => (
                <Badge key={tool} variant="secondary" className="text-xs font-mono">{tool}</Badge>
              ))}
            </div>

            <div className="mt-3 flex items-center gap-1 text-xs text-muted-foreground">
              <Bot className="h-3 w-3" />
              {skill.agentCount} 个智能体使用
            </div>
          </Link>
        ))}
      </div>
    </div>
  )
}