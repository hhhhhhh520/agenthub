'use client'
import { useState, useEffect } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'

interface Provider {
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
  onImport: (config: { provider: string; agentType: string; baseUrl: string; model: string; apiKey: string; agentId?: string }) => void
  agentId?: string
}

export function ProviderImportDialog({ open, onOpenChange, onImport, agentId }: Props) {
  const [providers, setProviders] = useState<Provider[]>([])
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

  const handleSelect = (provider: Provider) => {
    onImport({
      provider: provider.name,
      agentType: provider.agentType,
      baseUrl: provider.baseUrl,
      model: provider.model,
      apiKey: provider.apiKey,
      agentId,
    })
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>导入服务商配置</DialogTitle>
        </DialogHeader>

        {loading ? (
          <div className="text-center py-8 text-gray-400">加载中...</div>
        ) : providers.length === 0 ? (
          <div className="text-center py-8 text-gray-400">
            未找到已配置的服务商。请先在 CC-Switch 中配置。
          </div>
        ) : (
          <div className="space-y-2">
            <p className="text-sm text-gray-500 mb-3">从已配置的服务商中选择（来源：CC-Switch）：</p>
            {providers.map(p => (
              <div
                key={p.name}
                className="p-3 border rounded-lg cursor-pointer hover:bg-gray-50"
                onClick={() => handleSelect(p)}
              >
                <div className="flex items-center justify-between">
                  <span className="font-medium">{p.displayName}</span>
                  <Badge variant="outline" className="text-xs">{p.source}</Badge>
                </div>
                <div className="text-xs text-gray-500 mt-1 space-y-0.5">
                  <div>Base URL: {p.baseUrl}</div>
                  <div>Model: {p.model}</div>
                  <div>API Key: {p.apiKey.slice(0, 6)}...{p.apiKey.slice(-4)}</div>
                </div>
              </div>
            ))}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>取消</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
