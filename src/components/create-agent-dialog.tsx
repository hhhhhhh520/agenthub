'use client'
import { useState, useEffect } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { CreateProviderDialog } from '@/components/create-provider-dialog'

const PRESET_COLORS = [
  '#6366f1', '#10b981', '#f59e0b', '#ef4444',
  '#8b5cf6', '#ec4899', '#06b6d4', '#84cc16',
  '#f97316', '#64748b',
]

interface AgentData {
  id: string
  name: string
  expertise: string
  systemPrompt?: string
  platform: string
  model?: string
  baseUrl?: string
  apiKey?: string
  accentColor: string
  capabilities: string
  tools?: string
}

const AVAILABLE_TOOLS = [
  { name: 'Read', label: '读取文件', group: '文件' },
  { name: 'Write', label: '写入文件', group: '文件' },
  { name: 'Edit', label: '编辑文件', group: '文件' },
  { name: 'Glob', label: '文件搜索', group: '文件' },
  { name: 'Grep', label: '内容搜索', group: '文件' },
  { name: 'Bash', label: '执行命令', group: '执行' },
  { name: 'Agent', label: '子代理', group: '执行' },
  { name: 'WebFetch', label: '网页抓取', group: '网络' },
  { name: 'WebSearch', label: '网络搜索', group: '网络' },
]

interface Provider {
  id?: string
  name: string
  displayName: string
  baseUrl: string
  model: string
  apiKey: string
  agentType: string
  source: string
}

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated: (agentId?: string) => void
  editAgent?: AgentData | null
}

export function CreateAgentDialog({ open, onOpenChange, onCreated, editAgent }: Props) {
  const [name, setName] = useState('')
  const [expertise, setExpertise] = useState('')
  const [systemPrompt, setSystemPrompt] = useState('')
  const [platform, setPlatform] = useState('claude-code')
  const [model, setModel] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [accentColor, setAccentColor] = useState('#6366f1')
  const [capInput, setCapInput] = useState('')
  const [capabilities, setCapabilities] = useState<string[]>([])
  const [tools, setTools] = useState<string[]>(AVAILABLE_TOOLS.map(t => t.name))
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [providers, setProviders] = useState<Provider[]>([])
  const [showProviders, setShowProviders] = useState(false)
  const [selectedProviderId, setSelectedProviderId] = useState('')
  const [showCreateProvider, setShowCreateProvider] = useState(false)

  const isEdit = !!editAgent

  useEffect(() => {
    if (open && editAgent) {
      setName(editAgent.name)
      setExpertise(editAgent.expertise)
      setSystemPrompt(editAgent.systemPrompt || '')
      setPlatform(editAgent.platform || 'claude-code')
      setModel(editAgent.model || '')
      setBaseUrl(editAgent.baseUrl || '')
      setApiKey(editAgent.apiKey || '')
      setAccentColor(editAgent.accentColor || '#6366f1')
      try { setCapabilities(JSON.parse(editAgent.capabilities)) } catch { setCapabilities([]) }
      try {
        const parsed = JSON.parse(editAgent.tools || '[]')
        setTools(Array.isArray(parsed) && parsed.length > 0 ? parsed : AVAILABLE_TOOLS.map(t => t.name))
      } catch { setTools(AVAILABLE_TOOLS.map(t => t.name)) }
    }
  }, [open, editAgent])

  useEffect(() => {
    if (open) {
      fetch('/api/providers')
        .then(r => r.json())
        .then(data => { if (Array.isArray(data)) setProviders(data) })
        .catch(() => {})
    }
  }, [open])

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
    setPlatform('claude-code')
    setModel('')
    setBaseUrl('')
    setApiKey('')
    setAccentColor('#6366f1')
    setCapabilities([])
    setTools(AVAILABLE_TOOLS.map(t => t.name))
    setCapInput('')
    setError('')
    setShowProviders(false)
    setSelectedProviderId('')
  }

  const applyProvider = (p: Provider) => {
    setBaseUrl(p.baseUrl)
    setModel(p.model)
    setApiKey(p.apiKey)
    setPlatform(p.agentType === 'opencode' ? 'opencode' : 'claude-code')
    setShowProviders(false)
  }

  const handleSubmit = async () => {
    if (!name.trim() || !expertise.trim() || !systemPrompt.trim()) {
      setError('名称、专长、System Prompt 为必填项')
      return
    }
    setLoading(true)
    setError('')
    try {
      const body = {
        name: name.trim(),
        expertise: expertise.trim(),
        systemPrompt: systemPrompt.trim(),
        platform,
        model: model || undefined,
        baseUrl: baseUrl || undefined,
        apiKey: apiKey || undefined,
        accentColor,
        capabilities,
        tools,
      }

      const url = isEdit ? `/api/agents/${editAgent!.id}` : '/api/agents'
      const method = isEdit ? 'PUT' : 'POST'

      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (res.status === 409) {
        setError('Agent 名称已存在')
        return
      }
      if (!res.ok) {
        setError(isEdit ? '更新失败' : '创建失败')
        return
      }
      const data = await res.json()
      reset()
      onOpenChange(false)
      onCreated(data.id)
    } catch {
      setError('网络错误')
    } finally {
      setLoading(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={v => { if (!v) reset(); onOpenChange(v) }}>
      <DialogContent className="max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{isEdit ? '编辑 Agent' : '创建 Agent'}</DialogTitle>
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
              <option value="claude-code">Claude Code CLI</option>
              <option value="opencode">OpenCode CLI</option>
            </select>
          </div>

          {/* Provider selector */}
          <div className="border-t pt-3">
            <div className="flex items-center justify-between mb-2">
              <label className="text-sm font-medium">服务商</label>
              <Button variant="ghost" size="sm" onClick={() => setShowCreateProvider(true)}>
                + 新增服务商
              </Button>
            </div>
            <select
              className="w-full rounded border px-3 py-2 text-sm"
              value={selectedProviderId}
              onChange={e => {
                const key = e.target.value
                setSelectedProviderId(key)
                if (key) {
                  const p = providers.find(pr => (pr.id || pr.name) === key)
                  if (p) applyProvider(p)
                }
              }}
            >
              <option value="">手动配置</option>
              {providers.map(p => (
                <option key={p.id || p.name} value={p.id || p.name}>
                  {p.displayName} [{p.source}]
                </option>
              ))}
            </select>
            {selectedProviderId && (() => {
              const sel = providers.find(p => (p.id || p.name) === selectedProviderId)
              return (
                <div className="text-xs text-gray-500 mt-1">
                  <span>已选: {sel?.displayName || selectedProviderId} </span>
                  {model && <span>| 模型: {model} </span>}
                  {baseUrl && <span>| 端点: {baseUrl}</span>}
                </div>
              )
            })()}
          </div>

          <div>
            <label className="text-sm font-medium">模型</label>
            <Input value={model} onChange={e => setModel(e.target.value)} placeholder="如：claude-sonnet-4-20250514" />
          </div>
          <div>
            <label className="text-sm font-medium">Base URL</label>
            <Input value={baseUrl} onChange={e => setBaseUrl(e.target.value)} placeholder="https://api.anthropic.com" />
          </div>
          <div>
            <label className="text-sm font-medium">API Key</label>
            <Input type="password" value={apiKey} onChange={e => setApiKey(e.target.value)} placeholder="sk-..." />
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
                  aria-label={`选择颜色 ${c}`}
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
                  <Badge key={cap} variant="secondary" className="cursor-pointer" onClick={() => removeCap(cap)} aria-label={`删除标签 ${cap}`}>
                    {cap} ✕
                  </Badge>
                ))}
              </div>
            )}
          </div>
          <div>
            <label className="text-sm font-medium">可用工具</label>
            <p className="text-xs text-gray-400 mb-2">未勾选的工具将被 CLI 硬限制禁止调用</p>
            {['文件', '执行', '网络'].map(group => (
              <div key={group} className="mb-2">
                <span className="text-xs text-gray-500">{group}</span>
                <div className="flex flex-wrap gap-x-4 gap-y-1 mt-1">
                  {AVAILABLE_TOOLS.filter(t => t.group === group).map(tool => (
                    <label key={tool.name} className="flex items-center gap-1.5 text-sm cursor-pointer">
                      <input
                        type="checkbox"
                        checked={tools.includes(tool.name)}
                        onChange={e => {
                          if (e.target.checked) {
                            setTools(prev => [...prev, tool.name])
                          } else {
                            setTools(prev => prev.filter(t => t !== tool.name))
                          }
                        }}
                        className="accent-blue-500"
                      />
                      {tool.label}
                      <span className="text-xs text-gray-400">({tool.name})</span>
                    </label>
                  ))}
                </div>
              </div>
            ))}
          </div>
          {error && <p className="text-sm text-red-500">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => { reset(); onOpenChange(false) }}>取消</Button>
          <Button onClick={handleSubmit} disabled={loading}>
            {loading ? (isEdit ? '保存中...' : '创建中...') : (isEdit ? '保存' : '创建')}
          </Button>
        </DialogFooter>
      </DialogContent>

      <CreateProviderDialog
        open={showCreateProvider}
        onOpenChange={setShowCreateProvider}
        onCreated={(newProvider) => {
          // Refresh providers list
          fetch('/api/providers')
            .then(r => r.json())
            .then(data => { if (Array.isArray(data)) setProviders(data) })
            .catch(() => {})
          // Auto-select the new provider
          const providerKey = newProvider.id
          applyProvider({
            id: newProvider.id,
            name: newProvider.name,
            displayName: newProvider.name,
            baseUrl: newProvider.baseUrl,
            model: newProvider.model,
            apiKey: newProvider.apiKey,
            agentType: 'claudecode',
            source: 'database',
          })
          setSelectedProviderId(providerKey)
        }}
      />
    </Dialog>
  )
}
