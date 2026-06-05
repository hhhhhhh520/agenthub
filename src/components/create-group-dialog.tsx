'use client'
import { useState, useEffect, useCallback } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { getAgentStyle } from '@/lib/agent-colors'
import { FolderOpen, Shield, ShieldCheck } from 'lucide-react'

interface Agent {
  id: string
  name: string
  expertise: string
  accentColor: string
  capabilities: string
}

interface RecentDir {
  id: string
  path: string
  lastUsed: string
  useCount: number
}

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated: (sessionId: string) => void
}

export function CreateGroupDialog({ open, onOpenChange, onCreated }: Props) {
  const [step, setStep] = useState<'describe' | 'select' | 'creating'>('describe')
  const [taskDesc, setTaskDesc] = useState('')
  const [projectDir, setProjectDir] = useState('')
  const [permissionMode, setPermissionMode] = useState<'default' | 'auto'>('default')
  const [recentDirs, setRecentDirs] = useState<RecentDir[]>([])
  const [allAgents, setAllAgents] = useState<Agent[]>([])
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [recommendedIds, setRecommendedIds] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [llmUnavailable, setLlmUnavailable] = useState(false)

  const fetchRecentDirs = useCallback(async () => {
    try {
      const res = await fetch('/api/recent-dirs')
      const data = await res.json()
      if (res.ok) setRecentDirs(data)
    } catch { /* ignore */ }
  }, [])

  useEffect(() => {
    if (open) fetchRecentDirs()
  }, [open, fetchRecentDirs])

  useEffect(() => {
    if (!open) {
      setStep('describe')
      setTaskDesc('')
      setProjectDir('')
      setPermissionMode('default')
      setSelectedIds(new Set())
      setRecommendedIds(new Set())
      setError('')
      setLlmUnavailable(false)
    }
  }, [open])

  const handleNext = async () => {
    if (!taskDesc.trim()) return
    setLoading(true)
    setError('')
    try {
      const res = await fetch('/api/sessions/recommend-agents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskDescription: taskDesc }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || '推荐失败')
      setAllAgents(data.allAgents || [])
      setLlmUnavailable(data.llmUnavailable || false)
      const recIds = new Set<string>(data.recommendedIds || [])
      setRecommendedIds(recIds)
      setSelectedIds(new Set(recIds))
      setStep('select')
    } catch (e) {
      setError(e instanceof Error ? e.message : '推荐 Agent 失败')
    } finally {
      setLoading(false)
    }
  }

  const toggleAgent = (id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const toggleAll = () => {
    if (selectedIds.size === allAgents.length) {
      setSelectedIds(new Set())
    } else {
      setSelectedIds(new Set(allAgents.map(a => a.id)))
    }
  }

  const handleCreate = async () => {
    if (selectedIds.size === 0) return
    setStep('creating')
    setLoading(true)
    setError('')
    try {
      const title = taskDesc.length > 20 ? taskDesc.slice(0, 20) + '...' : taskDesc
      const res = await fetch('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title,
          type: 'group',
          agentIds: Array.from(selectedIds),
          projectDir: projectDir.trim(),
          permissionMode,
        }),
      })
      const session = await res.json()
      if (!res.ok) throw new Error(session.error || '创建失败')
      onCreated(session.id)
      onOpenChange(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : '创建失败')
      setStep('select')
    } finally {
      setLoading(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {step === 'describe' ? '创建群聊' : step === 'select' ? '选择 Agent' : '创建中...'}
          </DialogTitle>
        </DialogHeader>

        {step === 'describe' && (
          <div className="space-y-4">
            <p className="text-sm text-gray-500">描述你的需求，系统会推荐合适的 Agent 组合。</p>
            <textarea
              className="w-full h-28 p-3 border rounded-lg resize-none text-sm"
              placeholder="例如：做一个 TODO 应用，支持增删改查和分类..."
              value={taskDesc}
              onChange={e => setTaskDesc(e.target.value)}
              autoFocus
            />

            <div className="space-y-2">
              <label className="text-sm font-medium flex items-center gap-2">
                <FolderOpen className="w-4 h-4" />
                项目目录
              </label>
              <input
                type="text"
                className="w-full p-2 border rounded-lg text-sm"
                placeholder="例如：E:\projects\todo-app"
                value={projectDir}
                onChange={e => setProjectDir(e.target.value)}
              />
              {recentDirs.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {recentDirs.slice(0, 5).map(dir => (
                    <button
                      key={dir.id}
                      className="text-xs px-2 py-1 bg-gray-100 hover:bg-gray-200 rounded truncate max-w-[200px]"
                      onClick={() => setProjectDir(dir.path)}
                      title={dir.path}
                    >
                      {dir.path}
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium flex items-center gap-2">
                <Shield className="w-4 h-4" />
                权限模式
              </label>
              <div className="flex gap-2">
                <button
                  className={`flex-1 p-2 text-sm rounded-lg border transition-colors ${
                    permissionMode === 'default'
                      ? 'bg-blue-50 border-blue-300 text-blue-700'
                      : 'bg-white hover:bg-gray-50'
                  }`}
                  onClick={() => setPermissionMode('default')}
                >
                  <div className="flex items-center justify-center gap-1">
                    <Shield className="w-4 h-4" />
                    默认模式
                  </div>
                  <div className="text-xs text-gray-500 mt-1">需要确认每次操作</div>
                </button>
                <button
                  className={`flex-1 p-2 text-sm rounded-lg border transition-colors ${
                    permissionMode === 'auto'
                      ? 'bg-blue-50 border-blue-300 text-blue-700'
                      : 'bg-white hover:bg-gray-50'
                  }`}
                  onClick={() => setPermissionMode('auto')}
                >
                  <div className="flex items-center justify-center gap-1">
                    <ShieldCheck className="w-4 h-4" />
                    自动模式
                  </div>
                  <div className="text-xs text-gray-500 mt-1">自动处理，减少打扰</div>
                </button>
              </div>
            </div>

            {error && <p className="text-sm text-red-500">{error}</p>}
            <div className="flex items-center justify-between pt-2">
              <button
                className="text-xs text-gray-400 hover:text-gray-600"
                onClick={async () => {
                  setLoading(true)
                  const res = await fetch('/api/agents')
                  const agents = await res.json()
                  setAllAgents(agents)
                  setSelectedIds(new Set())
                  setRecommendedIds(new Set())
                  setStep('select')
                  setLoading(false)
                }}
              >
                手动选择 Agent →
              </button>
              <div className="flex gap-2">
                <Button variant="outline" onClick={() => onOpenChange(false)}>取消</Button>
                <Button onClick={handleNext} disabled={!taskDesc.trim() || loading}>
                  {loading ? '分析中...' : '下一步'}
                </Button>
              </div>
            </div>
          </div>
        )}

        {step === 'select' && (
          <div className="space-y-4">
            {llmUnavailable && (
              <p className="text-xs text-amber-600 bg-amber-50 p-2 rounded">
                LLM API 未配置，无法智能推荐，已默认选中全部 Agent。配置 ANTHROPIC_API_KEY 后可启用智能推荐。
              </p>
            )}
            <div className="flex items-center justify-between">
              <p className="text-sm text-gray-500">
                已选 {selectedIds.size}/{allAgents.length} 个 Agent
              </p>
              <Button variant="ghost" size="sm" onClick={toggleAll}>
                {selectedIds.size === allAgents.length ? '取消全选' : '全选'}
              </Button>
            </div>

            <div className="space-y-2 max-h-64 overflow-y-auto">
              {allAgents.map(agent => {
                const style = getAgentStyle(agent.name, agent.accentColor)
                const isSelected = selectedIds.has(agent.id)
                const isRecommended = recommendedIds.has(agent.id)
                return (
                  <div
                    key={agent.id}
                    className={`flex items-center gap-3 p-2 rounded-lg border cursor-pointer transition-colors ${
                      isSelected ? 'bg-blue-50 border-blue-300' : 'bg-white hover:bg-gray-50'
                    }`}
                    onClick={() => toggleAgent(agent.id)}
                  >
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onChange={(e) => { e.stopPropagation(); toggleAgent(agent.id) }}
                      onClick={(e) => e.stopPropagation()}
                      className="accent-blue-500"
                    />
                    <Avatar size="sm">
                      <AvatarFallback className={style.avatarBg}>{style.initial}</AvatarFallback>
                    </Avatar>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-sm">{agent.name}</span>
                        {isRecommended && (
                          <Badge variant="secondary" className="text-xs bg-blue-100 text-blue-700">推荐</Badge>
                        )}
                      </div>
                      <div className="text-xs text-gray-500 truncate">{agent.expertise}</div>
                    </div>
                  </div>
                )
              })}
            </div>

            {error && <p className="text-sm text-red-500">{error}</p>}
            <DialogFooter>
              <Button variant="outline" onClick={() => setStep('describe')}>上一步</Button>
              <Button onClick={handleCreate} disabled={selectedIds.size === 0 || loading}>
                {loading ? '创建中...' : `创建群聊 (${selectedIds.size} 人)`}
              </Button>
            </DialogFooter>
          </div>
        )}

        {step === 'creating' && (
          <div className="text-center py-8 text-gray-400">正在创建群聊...</div>
        )}
      </DialogContent>
    </Dialog>
  )
}
