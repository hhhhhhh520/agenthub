'use client'
import { useState, useEffect } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'

interface Provider {
  name: string
  display_name: string
  description_zh: string
  features: string[]
  tier: number
  website: string
  agents: Record<string, {
    base_url: string
    model: string
    models: string[]
  }>
}

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  onImport: (config: { provider: string; agentType: string; baseUrl: string; model: string; apiKey: string }) => void
}

export function ProviderImportDialog({ open, onOpenChange, onImport }: Props) {
  const [providers, setProviders] = useState<Provider[]>([])
  const [selected, setSelected] = useState<Provider | null>(null)
  const [agentType, setAgentType] = useState('claudecode')
  const [apiKey, setApiKey] = useState('')
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!open) return
    setLoading(true)
    fetch('/api/providers')
      .then(r => r.json())
      .then(data => {
        if (Array.isArray(data)) setProviders(data)
      })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [open])

  const handleImport = () => {
    if (!selected || !apiKey.trim()) return
    const agentConfig = selected.agents[agentType]
    if (!agentConfig) return

    onImport({
      provider: selected.name,
      agentType,
      baseUrl: agentConfig.base_url,
      model: agentConfig.model,
      apiKey: apiKey.trim(),
    })
    onOpenChange(false)
    setSelected(null)
    setApiKey('')
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>导入服务商配置</DialogTitle>
        </DialogHeader>

        {loading ? (
          <div className="text-center py-8 text-gray-400">加载中...</div>
        ) : !selected ? (
          <div className="space-y-2">
            <p className="text-sm text-gray-500 mb-3">从 CC-Switch 预设中选择服务商：</p>
            {providers.map(p => (
              <div
                key={p.name}
                className="p-3 border rounded-lg cursor-pointer hover:bg-gray-50"
                onClick={() => setSelected(p)}
              >
                <div className="flex items-center justify-between">
                  <span className="font-medium">{p.display_name}</span>
                  <div className="flex gap-1">
                    {p.features.slice(0, 3).map(f => (
                      <Badge key={f} variant="secondary" className="text-xs">{f}</Badge>
                    ))}
                  </div>
                </div>
                <p className="text-xs text-gray-500 mt-1">{p.description_zh}</p>
                <div className="flex gap-2 mt-2">
                  {Object.keys(p.agents).map(type => (
                    <Badge key={type} variant="outline" className="text-xs">{type}</Badge>
                  ))}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="space-y-4">
            <div className="flex items-center gap-2">
              <button onClick={() => setSelected(null)} className="text-sm text-blue-500 hover:underline">← 返回</button>
              <span className="font-medium">{selected.display_name}</span>
            </div>

            <div>
              <label className="text-sm font-medium">Agent 类型</label>
              <div className="flex gap-2 mt-1">
                {Object.keys(selected.agents).map(type => (
                  <Button
                    key={type}
                    variant={agentType === type ? 'default' : 'outline'}
                    size="sm"
                    onClick={() => setAgentType(type)}
                  >
                    {type}
                  </Button>
                ))}
              </div>
            </div>

            {selected.agents[agentType] && (
              <div className="bg-gray-50 p-3 rounded text-sm">
                <div><strong>Base URL:</strong> {selected.agents[agentType].base_url}</div>
                <div><strong>默认模型:</strong> {selected.agents[agentType].model}</div>
                <div><strong>可用模型:</strong> {selected.agents[agentType].models.join(', ')}</div>
              </div>
            )}

            <div>
              <label className="text-sm font-medium">API Key *</label>
              <Input
                type="password"
                value={apiKey}
                onChange={e => setApiKey(e.target.value)}
                placeholder="输入你的 API Key"
                className="mt-1"
              />
              <p className="text-xs text-gray-400 mt-1">Key 只保存在本地 .env 文件中，不会上传</p>
            </div>
          </div>
        )}

        {selected && (
          <DialogFooter>
            <Button variant="outline" onClick={() => { setSelected(null); onOpenChange(false) }}>取消</Button>
            <Button onClick={handleImport} disabled={!apiKey.trim()}>导入</Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  )
}
