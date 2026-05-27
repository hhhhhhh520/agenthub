"use client"

import Link from "next/link"
import { Plus, Bot, Clock } from "lucide-react"
import { Button } from "@/components/ui/button"

const mockProjects = [
  {
    id: "p1",
    title: "TODO 应用开发",
    description: "使用 React + Express 构建 TODO 应用",
    updatedAt: "2026-05-25",
    agents: ["前端工程师", "后端工程师", "测试工程师"],
    status: "执行中",
  },
  {
    id: "p2",
    title: "个人博客搭建",
    description: "Next.js 静态博客，支持 Markdown",
    updatedAt: "2026-05-24",
    agents: ["前端工程师"],
    status: "对齐中",
  },
  {
    id: "p3",
    title: "API 接口测试",
    description: "为现有后端 API 编写集成测试",
    updatedAt: "2026-05-23",
    agents: ["测试工程师"],
    status: "已完成",
  },
  {
    id: "p4",
    title: "数据可视化大屏",
    description: "ECharts + Vue3 数据看板",
    updatedAt: "2026-05-22",
    agents: ["前端工程师", "后端工程师"],
    status: "执行中",
  },
  {
    id: "p5",
    title: "CLI 工具开发",
    description: "Node.js 命令行工具，自动化部署",
    updatedAt: "2026-05-21",
    agents: ["后端工程师"],
    status: "对齐中",
  },
]

const statusColors: Record<string, string> = {
  "执行中": "bg-green-100 text-green-700",
  "对齐中": "bg-yellow-100 text-yellow-700",
  "已完成": "bg-blue-100 text-blue-700",
}

export default function ProjectsPage() {
  return (
    <div className="flex flex-1 flex-col gap-6 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">项目</h1>
          <p className="text-sm text-muted-foreground mt-1">管理你的多智能体协作项目</p>
        </div>
        <Button size="sm" className="gap-1">
          <Plus className="h-4 w-4" /> 创建项目
        </Button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {mockProjects.map((project) => (
          <Link
            key={project.id}
            href={`/dashboard/projects/${project.id}`}
            className="rounded-lg border bg-card p-4 hover:bg-accent transition-colors group"
          >
            <div className="flex items-start justify-between mb-2">
              <h3 className="font-medium text-sm group-hover:underline">{project.title}</h3>
              <span className={`text-xs px-2 py-0.5 rounded-full ${statusColors[project.status] || "bg-gray-100 text-gray-700"}`}>
                {project.status}
              </span>
            </div>
            <p className="text-xs text-muted-foreground mb-3 line-clamp-2">{project.description}</p>
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <div className="flex items-center gap-1">
                <Bot className="h-3 w-3" />
                {project.agents.length} 智能体
              </div>
              <div className="flex items-center gap-1">
                <Clock className="h-3 w-3" />
                {project.updatedAt}
              </div>
            </div>
          </Link>
        ))}
      </div>
    </div>
  )
}
