"use client"

import { useState, useEffect } from "react"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { PROVIDER_CATEGORIES, type ProviderCategory } from "@/lib/provider-categories"

interface ProviderData {
  id: string
  name: string
  baseUrl: string
  apiKey: string
  model: string
  category: string
}

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated: (provider: ProviderData) => void
  editProvider?: ProviderData | null
}

export function CreateProviderDialog({ open, onOpenChange, onCreated, editProvider }: Props) {
  const isEdit = !!editProvider

  const [name, setName] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [model, setModel] = useState('')
  const [category, setCategory] = useState<ProviderCategory>('custom')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const reset = () => {
    setName('')
    setBaseUrl('')
    setApiKey('')
    setModel('')
    setCategory('custom')
    setError('')
    setLoading(false)
  }

  useEffect(() => {
    if (open && editProvider) {
      setName(editProvider.name)
      setBaseUrl(editProvider.baseUrl)
      setApiKey(editProvider.apiKey)
      setModel(editProvider.model)
      setCategory(editProvider.category as ProviderCategory)
    } else if (open) {
      reset()
    }
  }, [open, editProvider])

  const handleSubmit = async () => {
    if (!name.trim()) { setError('名称不能为空'); return }
    setLoading(true)
    setError('')

    try {
      const body = { name: name.trim(), baseUrl, apiKey: apiKey || undefined, model, category }
      const url = isEdit ? `/api/providers/db/${editProvider!.id}` : '/api/providers/db'
      const method = isEdit ? 'PUT' : 'POST'

      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })

      if (res.status === 409) { setError('服务商名称已存在'); return }
      if (!res.ok) { setError(isEdit ? '更新失败' : '创建失败'); return }

      const data = await res.json()
      reset()
      onOpenChange(false)
      onCreated(data)
    } catch {
      setError('网络错误')
    } finally {
      setLoading(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) reset(); onOpenChange(v) }}>
      <DialogContent className="max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{isEdit ? '编辑服务商' : '新增服务商'}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          {error && <p className="text-sm text-red-500">{error}</p>}

          <div>
            <label className="text-sm font-medium">名称 *</label>
            <Input value={name} onChange={e => setName(e.target.value)} placeholder="如：Anthropic 官方" />
          </div>

          <div>
            <label className="text-sm font-medium">分类</label>
            <div className="flex flex-wrap gap-2 mt-1">
              {Object.entries(PROVIDER_CATEGORIES).map(([key, val]) => (
                <button
                  key={key}
                  type="button"
                  className={`px-2 py-1 rounded text-xs ${val.color} ${category === key ? 'ring-2 ring-black' : ''}`}
                  onClick={() => setCategory(key as ProviderCategory)}
                >
                  {val.label}
                </button>
              ))}
            </div>
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
            <label className="text-sm font-medium">默认模型</label>
            <Input value={model} onChange={e => setModel(e.target.value)} placeholder="如：claude-sonnet-4-20250514" />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => { reset(); onOpenChange(false) }}>取消</Button>
          <Button onClick={handleSubmit} disabled={loading}>
            {loading ? (isEdit ? '保存中...' : '创建中...') : (isEdit ? '保存' : '创建')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
