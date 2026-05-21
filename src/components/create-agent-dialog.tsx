'use client'
import { useState } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'

const PRESET_COLORS = [
  '#6366f1', '#10b981', '#f59e0b', '#ef4444',
  '#8b5cf6', '#ec4899', '#06b6d4', '#84cc16',
  '#f97316', '#64748b',
]

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated: () => void
}

export function CreateAgentDialog({ open, onOpenChange, onCreated }: Props) {
  const [name, setName] = useState('')
  const [expertise, setExpertise] = useState('')
  const [systemPrompt, setSystemPrompt] = useState('')
  const [platform, setPlatform] = useState('llm')
  const [accentColor, setAccentColor] = useState('#6366f1')
  const [capInput, setCapInput] = useState('')
  const [capabilities, setCapabilities] = useState<string[]>([])
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const addCap = () => {
    const v = capInput.trim()
    if (v && !capabilities.includes(v)) {
      setCapabilities([...capabilities, v])
      setCapInput('')
    }
  }

  const removeCap = (cap: string) => {
    setCapabilities(capabilities.filter(c => c !== cap))
  }

  const reset = () => {
    setName('')
    setExpertise('')
    setSystemPrompt('')
    setPlatform('llm')
    setAccentColor('#6366f1')
    setCapabilities([])
    setCapInput('')
    setError('')
  }

  const handleSubmit = async () => {
    if (!name.trim() || !expertise.trim() || !systemPrompt.trim()) {
      setError('名称、专长、System Prompt 为必填项')
      return
    }
    setLoading(true)
    setError('')
    try {
      const res = await fetch('/api/agents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          expertise: expertise.trim(),
          systemPrompt: systemPrompt.trim(),
          platform,
          accentColor,
          capabilities,
        }),
      })
      if (res.status === 409) {
        setError('Agent 名称已存在')
        return
      }
      if (!res.ok) {
        setError('创建失败')
        return
      }
      reset()
      onOpenChange(false)
      onCreated()
    } catch {
      setError('网络错误')
    } finally {
      setLoading(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={v => { if (!v) reset(); onOpenChange(v) }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>创建 Agent</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <label className="text-sm font-medium">名称 *</label>
            <Input value={name} onChange={e => setName(e.target.value)} placeholder="如：前端工程师" />
          </div>
          <div>
            <label className="text-sm font-medium">专长 *</label>
            <Input value={expertise} onChange={e => setExpertise(e.target.value)} placeholder="如：React、TypeScript、CSS" />
          </div>
          <div>
            <label className="text-sm font-medium">System Prompt *</label>
            <textarea
              className="w-full rounded border px-3 py-2 text-sm min-h-[80px]"
              value={systemPrompt}
              onChange={e => setSystemPrompt(e.target.value)}
              placeholder="定义 Agent 的角色和行为规范..."
            />
          </div>
          <div>
            <label className="text-sm font-medium">执行平台</label>
            <select className="w-full rounded border px-3 py-2 text-sm" value={platform} onChange={e => setPlatform(e.target.value)}>
              <option value="llm">LLM API</option>
              <option value="claude-code">Claude Code CLI</option>
            </select>
          </div>
          <div>
            <label className="text-sm font-medium">主题色</label>
            <div className="flex items-center gap-2 mt-1 flex-wrap">
              {PRESET_COLORS.map(c => (
                <button
                  key={c}
                  className={`w-6 h-6 rounded-full border-2 ${accentColor === c ? 'border-black' : 'border-transparent'}`}
                  style={{ backgroundColor: c }}
                  onClick={() => setAccentColor(c)}
                />
              ))}
              <div className="w-6 h-6 rounded-full border" style={{ backgroundColor: accentColor }} title="预览" />
            </div>
            <div className="flex items-center gap-2 mt-2">
              <Input
                value={accentColor}
                onChange={e => {
                  const v = e.target.value
                  if (/^#[0-9a-fA-F]{0,6}$/.test(v)) setAccentColor(v)
                }}
                placeholder="#6366f1"
                className="w-28"
              />
              <span className="text-xs text-gray-400">自定义 hex</span>
            </div>
          </div>
          <div>
            <label className="text-sm font-medium">能力标签</label>
            <div className="flex gap-2 mt-1">
              <Input
                value={capInput}
                onChange={e => setCapInput(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && (e.preventDefault(), addCap())}
                placeholder="输入后按 Enter 添加"
                className="flex-1"
              />
              <Button variant="outline" size="sm" onClick={addCap}>添加</Button>
            </div>
            {capabilities.length > 0 && (
              <div className="flex flex-wrap gap-1 mt-2">
                {capabilities.map(cap => (
                  <Badge key={cap} variant="secondary" className="cursor-pointer" onClick={() => removeCap(cap)}>
                    {cap} ✕
                  </Badge>
                ))}
              </div>
            )}
          </div>
          {error && <p className="text-sm text-red-500">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => { reset(); onOpenChange(false) }}>取消</Button>
          <Button onClick={handleSubmit} disabled={loading}>{loading ? '创建中...' : '创建'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
