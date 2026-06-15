'use client'
import { useState, useEffect, useMemo, useRef } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { CreateProviderDialog } from '@/components/create-provider-dialog'
import { ChevronDown, Cpu, Loader2, Check, Search } from 'lucide-react'
import { toast } from 'sonner'

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
  const [touched, setTouched] = useState<Record<string, boolean>>({})
  const [ocModels, setOcModels] = useState<Array<{ id: string; provider: string }>>([])
  const [ocModelsLoading, setOcModelsLoading] = useState(false)
  const [modelDropdownOpen, setModelDropdownOpen] = useState(false)
  const [modelSearch, setModelSearch] = useState('')
  const modelDropdownRef = useRef<HTMLDivElement>(null)

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
        .catch((err) => { console.error(err); toast.error('加载服务商列表失败') })
    }
  }, [open])

  // Fetch OpenCode models when platform is opencode
  useEffect(() => {
    if (platform !== 'opencode' || ocModels.length > 0) return
    setOcModelsLoading(true)
    fetch('/api/opencode/models')
      .then(r => r.json())
      .then(data => { if (Array.isArray(data.models)) setOcModels(data.models) })
      .catch((err) => { console.error(err); toast.error('加载模型列表失败') })
      .finally(() => setOcModelsLoading(false))
  }, [platform, ocModels.length])

  // Close model dropdown on outside click
  useEffect(() => {
    if (!modelDropdownOpen) return
    const handler = (e: MouseEvent) => {
      if (modelDropdownRef.current && !modelDropdownRef.current.contains(e.target as Node)) {
        setModelDropdownOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [modelDropdownOpen])

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
    setOcModels([])
    setModelSearch('')
    setTouched({})
  }

  const markTouched = (field: string) => setTouched(prev => ({ ...prev, [field]: true }))

  const fieldError = (field: string, value: string) => {
    if (!touched[field]) return ''
    if (!value.trim()) return '此项为必填'
    return ''
  }

  const inputClass = (field: string, value: string) =>
    `w-full rounded border px-3 py-2 text-sm ${touched[field] && !value.trim() ? 'border-red-500 focus:ring-red-500' : ''}`

  const applyProvider = (p: Provider) => {
    setBaseUrl(p.baseUrl)
    setModel(p.model)
    setApiKey(p.apiKey)
    setPlatform(p.agentType === 'opencode' ? 'opencode' : 'claude-code')
    setShowProviders(false)
  }

  const handleSubmit = async () => {
    // 标记所有必填字段为已触碰，显示验证错误
    setTouched({ name: true, expertise: true, systemPrompt: true })
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
      toast.success(isEdit ? 'Agent 已保存' : 'Agent 已创建')
      onOpenChange(false)
      onCreated(data.id)
    } catch {
      setError('网络错误')
    } finally {
      setLoading(false)
    }
  }

  // Group OpenCode models by provider
  const groupedModels = useMemo(() => {
    const groups: Record<string, Array<{ id: string; provider: string }>> = {}
    for (const m of ocModels) {
      const key = m.provider || 'other'
      if (!groups[key]) groups[key] = []
      groups[key].push(m)
    }
    return groups
  }, [ocModels])

  const filteredModels = useMemo(() => {
    if (!modelSearch.trim()) return groupedModels
    const q = modelSearch.toLowerCase()
    const out: Record<string, Array<{ id: string; provider: string }>> = {}
    for (const [provider, list] of Object.entries(groupedModels)) {
      const matches = list.filter(m => m.id.toLowerCase().includes(q))
      if (matches.length > 0) out[provider] = matches
    }
    return out
  }, [groupedModels, modelSearch])

  return (
    <Dialog open={open} onOpenChange={v => { if (!v) reset(); onOpenChange(v) }}>
      <DialogContent className="max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{isEdit ? '编辑 Agent' : '创建 Agent'}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <label className="text-sm font-medium">名称 *</label>
            <Input
              value={name}
              onChange={e => setName(e.target.value)}
              onBlur={() => markTouched('name')}
              placeholder="如：前端工程师"
              className={inputClass('name', name)}
            />
            {fieldError('name', name) && <p className="text-xs text-red-500 mt-1">{fieldError('name', name)}</p>}
          </div>
          <div>
            <label className="text-sm font-medium">专长 *</label>
            <Input
              value={expertise}
              onChange={e => setExpertise(e.target.value)}
              onBlur={() => markTouched('expertise')}
              placeholder="如：React、TypeScript、CSS"
              className={inputClass('expertise', expertise)}
            />
            {fieldError('expertise', expertise) && <p className="text-xs text-red-500 mt-1">{fieldError('expertise', expertise)}</p>}
          </div>
          <div>
            <label className="text-sm font-medium">System Prompt *</label>
            <textarea
              className={`w-full rounded border px-3 py-2 text-sm min-h-[80px] ${inputClass('systemPrompt', systemPrompt)}`}
              value={systemPrompt}
              onChange={e => setSystemPrompt(e.target.value)}
              onBlur={() => markTouched('systemPrompt')}
              placeholder="定义 Agent 的角色和行为规范..."
            />
            {fieldError('systemPrompt', systemPrompt) && <p className="text-xs text-red-500 mt-1">{fieldError('systemPrompt', systemPrompt)}</p>}
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
            {platform === 'opencode' ? (
              <div className="relative" ref={modelDropdownRef}>
                <button
                  type="button"
                  className="w-full rounded border px-3 py-2 text-sm text-left flex items-center gap-2 hover:bg-gray-50"
                  onClick={() => { setModelDropdownOpen(!modelDropdownOpen); setModelSearch('') }}
                >
                  <Cpu className="h-4 w-4 text-gray-400 shrink-0" />
                  <span className="flex-1 truncate">{model || '选择模型（可搜索）'}</span>
                  {ocModelsLoading && <Loader2 className="h-4 w-4 animate-spin text-gray-400" />}
                  <ChevronDown className={`h-4 w-4 text-gray-400 transition-transform ${modelDropdownOpen ? 'rotate-180' : ''}`} />
                </button>
                {modelDropdownOpen && (
                  <div className="absolute z-50 mt-1 w-full rounded border bg-white dark:bg-gray-800 dark:border-gray-700 shadow-lg">
                    <div className="p-2 border-b">
                      <div className="relative">
                        <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
                        <input
                          autoFocus
                          className="w-full rounded border px-3 py-1.5 pl-8 text-sm"
                          placeholder="搜索模型..."
                          value={modelSearch}
                          onChange={e => setModelSearch(e.target.value)}
                        />
                      </div>
                    </div>
                    <div className="max-h-60 overflow-y-auto p-1">
                      {ocModelsLoading ? (
                        <div className="flex items-center gap-2 px-3 py-6 text-sm text-gray-400">
                          <Loader2 className="h-4 w-4 animate-spin" />
                          发现模型中...
                        </div>
                      ) : Object.keys(filteredModels).length === 0 && !modelSearch.trim() ? (
                        <div className="px-3 py-6 text-center text-sm text-gray-400">未发现可用模型</div>
                      ) : (
                        Object.entries(filteredModels).map(([provider, list]) => (
                          <div key={provider} className="mb-1">
                            <div className="px-2 pt-1.5 pb-0.5 text-xs font-medium uppercase tracking-wide text-gray-400">
                              {provider}
                            </div>
                            {list.map(m => (
                              <button
                                key={m.id}
                                type="button"
                                className={`w-full text-left px-3 py-2 text-sm rounded flex items-center gap-2 ${m.id === model ? 'bg-blue-50' : 'hover:bg-gray-50'}`}
                                onClick={() => { setModel(m.id); setModelDropdownOpen(false); setModelSearch('') }}
                              >
                                <span className="flex-1 truncate">{m.id}</span>
                                {m.id === model && <Check className="h-4 w-4 text-blue-500 shrink-0" />}
                              </button>
                            ))}
                          </div>
                        ))
                      )}
                      {modelSearch.trim() && !ocModels.some(m => m.id === modelSearch.trim()) && (
                        <button
                          type="button"
                          className="w-full text-left px-3 py-2 text-sm text-blue-600 hover:bg-blue-50 rounded flex items-center gap-2"
                          onClick={() => { setModel(modelSearch.trim()); setModelDropdownOpen(false); setModelSearch('') }}
                        >
                          + 使用自定义模型: {modelSearch.trim()}
                        </button>
                      )}
                    </div>
                    {model && (
                      <div className="border-t p-1">
                        <button
                          type="button"
                          className="w-full text-left px-3 py-1.5 text-xs text-gray-400 hover:bg-gray-50 rounded"
                          onClick={() => { setModel(''); setModelDropdownOpen(false) }}
                        >
                          清除选择
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            ) : (
              <Input value={model} onChange={e => setModel(e.target.value)} placeholder="如：claude-sonnet-4-20250514" />
            )}
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
            .catch(console.error)
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
