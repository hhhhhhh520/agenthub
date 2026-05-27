"use client"

import { ArrowLeft, Bot, Plus } from "lucide-react"
import Link from "next/link"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"

const mockProject = {
  id: "p1",
  title: "TODO 应用开发",
  description: "使用 React + Express 构建 TODO 应用，支持增删改查、分类、搜索",
  status: "执行中",
  agents: [
    { id: "a1", name: "前端工程师", status: "working", accentColor: "#3b82f6" },
    { id: "a2", name: "后端工程师", status: "idle", accentColor: "#10b981" },
    { id: "a3", name: "测试工程师", status: "idle", accentColor: "#f59e0b" },
  ],
}

const mockMessages = [
  { id: "m1", sender: "Orchestrator", content: "对齐完成，开始执行任务。前端工程师先搭建项目脚手架。", time: "14:30" },
  { id: "m2", sender: "前端工程师", content: "收到，正在创建 React + Vite 项目，安装 Tailwind CSS 和 React Router。", time: "14:31" },
  { id: "m3", sender: "前端工程师", content: "脚手架搭建完成。\n\n```diff\n+ src/App.tsx\n+ src/main.tsx\n+ src/routes/Home.tsx\n+ src/components/TodoList.tsx\n```", time: "14:35" },
  { id: "m4", sender: "Orchestrator", content: "@后端工程师 请开始设计数据模型和 API 接口。", time: "14:36" },
  { id: "m5", sender: "后端工程师", content: "正在设计数据模型，使用 SQLite + Express。\n\n```json\n{\n  \"Todo\": {\n    \"id\": \"INTEGER PRIMARY KEY\",\n    \"title\": \"TEXT NOT NULL\",\n    \"completed\": \"BOOLEAN DEFAULT 0\",\n    \"category\": \"TEXT\",\n    \"priority\": \"INTEGER DEFAULT 0\",\n    \"created_at\": \"DATETIME\"\n  }\n}\n```", time: "14:38" },
]

const mockTasks = [
  { id: "t1", description: "搭建项目脚手架", agent: "前端工程师", status: "completed" },
  { id: "t2", description: "设计数据模型", agent: "后端工程师", status: "in_progress" },
  { id: "t3", description: "实现 API 接口", agent: "后端工程师", status: "pending" },
  { id: "t4", description: "实现前端页面", agent: "前端工程师", status: "pending" },
  { id: "t5", description: "编写测试用例", agent: "测试工程师", status: "pending" },
]

const taskStatusIcons: Record<string, string> = {
  completed: "✅",
  in_progress: "🔄",
  pending: "⬜",
  failed: "❌",
}

const agentStatusDot: Record<string, string> = {
  working: "bg-green-500",
  idle: "bg-gray-400",
  done: "bg-blue-500",
  error: "bg-red-500",
}

export default function ProjectDetailPage() {
  const project = mockProject

  return (
    <div className="flex flex-1 flex-col h-svh">
      {/* Header */}
      <div className="flex items-center gap-3 border-b px-4 py-3 shrink-0">
        <Link href="/dashboard/projects" className="text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-4 w-4" />
        </Link>
        <h1 className="font-semibold text-sm flex-1">{project.title}</h1>
        <Badge variant="outline" className="text-xs">{project.status}</Badge>
      </div>

      {/* Three-column layout */}
      <div className="flex flex-1 min-h-0">
        {/* Messages list */}
        <div className="w-72 border-r flex flex-col">
          <div className="p-3 border-b text-xs font-medium text-muted-foreground">消息</div>
          <ScrollArea className="flex-1">
            <div className="p-2 space-y-1">
              {mockMessages.map((msg) => (
                <div key={msg.id} className="p-2 rounded text-sm hover:bg-accent cursor-pointer">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="font-medium text-xs">{msg.sender}</span>
                    <span className="text-xs text-muted-foreground ml-auto">{msg.time}</span>
                  </div>
                  <p className="text-xs text-muted-foreground line-clamp-2">{msg.content.replace(/```[\s\S]*?```/g, "[代码块]")}</p>
                </div>
              ))}
            </div>
          </ScrollArea>
        </div>

        {/* Chat area */}
        <div className="flex-1 flex flex-col">
          <ScrollArea className="flex-1 p-4">
            <div className="space-y-4 max-w-3xl mx-auto">
              {mockMessages.map((msg) => (
                <div key={msg.id} className="flex gap-3">
                  <Avatar className="h-8 w-8 shrink-0">
                    <AvatarFallback className="text-xs">{msg.sender.charAt(0)}</AvatarFallback>
                  </Avatar>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="font-medium text-sm">{msg.sender}</span>
                      <span className="text-xs text-muted-foreground">{msg.time}</span>
                    </div>
                    <div className="text-sm whitespace-pre-wrap break-words bg-accent/50 rounded-lg p-3">
                      {msg.content}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </ScrollArea>

          {/* Input */}
          <div className="border-t p-3 shrink-0">
            <div className="flex gap-2">
              <input
                type="text"
                placeholder="输入消息... (@ 提及智能体)"
                className="flex-1 h-9 rounded-md border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
              />
              <Button size="sm">发送</Button>
            </div>
          </div>
        </div>

        {/* Agent panel */}
        <div className="w-64 border-l flex flex-col">
          <div className="p-3 border-b flex items-center justify-between">
            <span className="text-xs font-medium text-muted-foreground">智能体</span>
            <Button variant="ghost" size="sm" className="h-6 gap-1 text-xs">
              <Plus className="h-3 w-3" /> 添加
            </Button>
          </div>

          {/* Agents */}
          <div className="p-2 space-y-1 border-b">
            {project.agents.map((agent) => (
              <div key={agent.id} className="flex items-center gap-2 p-2 rounded hover:bg-accent">
                <Avatar className="h-6 w-6">
                  <AvatarFallback
                    className="text-xs text-white"
                    style={{ backgroundColor: agent.accentColor }}
                  >
                    {agent.name.charAt(0)}
                  </AvatarFallback>
                </Avatar>
                <span className="text-xs font-medium flex-1">{agent.name}</span>
                <span className={`h-2 w-2 rounded-full ${agentStatusDot[agent.status]}`} />
              </div>
            ))}
          </div>

          {/* Tasks */}
          <div className="p-3 border-b text-xs font-medium text-muted-foreground">任务</div>
          <ScrollArea className="flex-1">
            <div className="p-2 space-y-1">
              {mockTasks.map((task) => (
                <div key={task.id} className="p-2 rounded text-xs hover:bg-accent">
                  <div className="flex items-center gap-2">
                    <span>{taskStatusIcons[task.status]}</span>
                    <span className="flex-1">{task.description}</span>
                  </div>
                  <div className="flex items-center gap-1 mt-1 text-muted-foreground">
                    <Bot className="h-3 w-3" />
                    {task.agent}
                  </div>
                </div>
              ))}
            </div>
          </ScrollArea>
        </div>
      </div>
    </div>
  )
}