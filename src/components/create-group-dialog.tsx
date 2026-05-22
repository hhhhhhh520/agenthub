'use client'
import { useState, useEffect } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { getAgentStyle } from '@/lib/agent-colors'

interface Agent {
  id: string
  name: string
  expertise: string
  accentColor: string
  capabilities: string
}

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated: (sessionId: string) => void
}

export function CreateGroupDialog({ open, onOpenChange, onCreated }: Props) {
  const [step, setStep] = useState<'describe' | 'select' | 'creating'>('describe')
  const [taskDesc, setTaskDesc] = useState('')
  const [allAgents, setAllAgents] = useState<Agent[]>([])
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [recommendedIds, setRecommendedIds] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!open) {
      setStep('describe')
      setTaskDesc('')
      setSelectedIds(new Set())
      setRecommendedIds(new Set())
      setError('')
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
            {error && <p className="text-sm text-red-500">{error}</p>}
            <DialogFooter>
              <Button variant="outline" onClick={() => onOpenChange(false)}>取消</Button>
              <Button onClick={handleNext} disabled={!taskDesc.trim() || loading}>
                {loading ? '分析中...' : '下一步'}
              </Button>
            </DialogFooter>
          </div>
        )}

        {step === 'select' && (
          <div className="space-y-4">
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
                      onChange={() => toggleAgent(agent.id)}
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
