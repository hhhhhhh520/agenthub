'use client'
import { useState, useEffect } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  onComplete: () => void
}

export function SetupWizard({ open, onOpenChange, onComplete }: Props) {
  const [step, setStep] = useState<'welcome' | 'config' | 'agents' | 'done'>('welcome')
  const [apiKey, setApiKey] = useState('')
  const [model, setModel] = useState('claude-sonnet-4-20250514')
  const [baseUrl, setBaseUrl] = useState('')
  const [providers, setProviders] = useState<{ name: string; displayName: string; baseUrl: string; model: string }[]>([])
  const [showProviders, setShowProviders] = useState(false)
  const [testResult, setTestResult] = useState<{ success: boolean; response?: string; error?: string; message?: string; platform?: string } | null>(null)
  const [testing, setTesting] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [applyToPresets, setApplyToPresets] = useState(false)

  const [imported, setImported] = useState(false)
  const [importedInfo, setImportedInfo] = useState<{ model: string; baseUrlMasked: string } | null>(null)

  const [detectedPlatform, setDetectedPlatform] = useState<string | null>(null)
  const [detecting, setDetecting] = useState(false)

  useEffect(() => {
    if (!open) {
      setStep('welcome')
      setApiKey('')
      setModel('claude-sonnet-4-20250514')
      setBaseUrl('')
      setShowProviders(false)
      setTestResult(null)
      setTesting(false)
      setSaving(false)
      setError('')
      setApplyToPresets(false)
      setImported(false)
      setImportedInfo(null)
      setDetectedPlatform(null)
      setDetecting(false)
    }
  }, [open])

  // 进入 config 步骤时自动检测 CLI
  const detectPlatform = async () => {
    setDetecting(true)
    try {
      const res = await fetch('/api/config/detect-platform', { method: 'POST' })
      const data = await res.json()
      setDetectedPlatform(data.cliAvailable ? data.platform : null)
    } catch {
      setDetectedPlatform(null)
    } finally {
      setDetecting(false)
    }
  }

  const fetchProviders = async () => {
    try {
      const res = await fetch('/api/providers')
      const data = await res.json()
      setProviders(data)
      setShowProviders(true)
    } catch { setError('读取服务商配置失败') }
  }

  const importProvider = async (providerName: string) => {
    try {
      const res = await fetch('/api/config/import-provider', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ providerName }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || '导入失败')
      const orchRes = await fetch('/api/config/orchestrator')
      const orchData = await orchRes.json()
      setImported(true)
      setImportedInfo({ model: orchData.model || data.model, baseUrlMasked: orchData.baseUrl || '' })
      setShowProviders(false)
      setTestResult(null)
    } catch (e) { setError(e instanceof Error ? e.message : '导入失败') }
  }

  const testConnection = async () => {
    if (!imported && !apiKey && !detectedPlatform) {
      setError('请先填写 API Key 或确认 CLI 可用')
      return
    }
    setTesting(true)
    setTestResult(null)
    setError('')
    try {
      if (!imported && !detectedPlatform) {
        await fetch('/api/config/orchestrator', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ apiKey, model, baseUrl, platform: 'claude-code' }),
        })
      }
      const res = await fetch('/api/config/test-connection', { method: 'POST' })
      const data = await res.json()
      setTestResult(data)
    } catch (e) {
      setTestResult({ success: false, error: e instanceof Error ? e.message : '测试失败' })
    } finally {
      setTesting(false)
    }
  }

  const handleComplete = async () => {
    setSaving(true)
    setError('')
    try {
      // 保存配置到 Orchestrator Agent 和 AppConfig
      const platform = detectedPlatform || 'claude-code'
      if (!imported) {
        await fetch('/api/config/orchestrator', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            apiKey: detectedPlatform ? '' : apiKey,
            model,
            baseUrl: detectedPlatform ? '' : baseUrl,
            platform,
          }),
        })
      }

      if (applyToPresets) {
        const orchRes = await fetch('/api/config/orchestrator')
        const orchData = await orchRes.json()
        const agentsRes = await fetch('/api/agents?preset=true')
        const agents = await agentsRes.json()
        for (const agent of agents) {
          await fetch(`/api/agents/${agent.id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              platform: detectedPlatform || 'claude-code',
              model: orchData.model || model,
            }),
          })
        }
      }

      await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ setupCompleted: 'true' }),
      })

      setStep('done')
      setTimeout(() => { onComplete(); onOpenChange(false) }, 1500)
    } catch (e) {
      setError(e instanceof Error ? e.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  const handleSkip = async () => {
    await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ setupCompleted: 'true' }),
    })
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        {step === 'welcome' && (
          <>
            <DialogHeader>
              <DialogTitle>欢迎使用 AgentHub</DialogTitle>
              <DialogDescription>
                AgentHub 是一个多 Agent 协作平台，通过 CLI 工具（Claude Code / OpenCode）驱动 Agent 执行任务。
              </DialogDescription>
            </DialogHeader>
            <div className="text-sm text-gray-600 space-y-2 mt-2">
              <p>配置后你将获得：</p>
              <ul className="list-disc ml-4 space-y-1">
                <li>智能推荐：根据任务描述自动选择合适的 Agent</li>
                <li>任务协调：Orchestrator 分析需求并分配给专业 Agent</li>
                <li>多 Agent 讨论：Agent 之间协作解决复杂问题</li>
              </ul>
            </div>
            {error && <p className="text-sm text-red-500">{error}</p>}
            <DialogFooter>
              <Button variant="outline" onClick={handleSkip}>跳过，稍后配置</Button>
              <Button onClick={() => { setStep('config'); detectPlatform() }}>开始配置</Button>
            </DialogFooter>
          </>
        )}

        {step === 'config' && (
          <>
            <DialogHeader>
              <DialogTitle>检测平台配置</DialogTitle>
              <DialogDescription>
                自动检测本机可用的 CLI 平台，或手动配置 LLM API。
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-3">
              {/* CLI 检测结果 */}
              {detecting && (
                <div className="bg-gray-50 p-3 rounded text-sm text-gray-600">
                  正在检测 CLI 工具...
                </div>
              )}
              {!detecting && detectedPlatform && (
                <div className="bg-green-50 text-green-700 p-3 rounded text-sm space-y-1">
                  <p className="font-medium">
                    检测到 {detectedPlatform === 'claude-code' ? 'Claude CLI' : 'OpenCode CLI'}
                  </p>
                  <p>Orchestrator 将使用 CLI 平台执行任务，无需配置 API Key。</p>
                </div>
              )}
              {!detecting && !detectedPlatform && !imported && (
                <div className="bg-yellow-50 text-yellow-700 p-3 rounded text-sm space-y-1">
                  <p className="font-medium">未检测到 CLI 工具</p>
                  <p>将使用 LLM API 模式。请填写 API Key，或安装 Claude CLI / OpenCode CLI。</p>
                </div>
              )}

              {/* 导入成功提示 */}
              {imported && importedInfo ? (
                <div className="bg-green-50 text-green-700 p-3 rounded text-sm space-y-1">
                  <p className="font-medium">已从 CC-Switch 导入配置</p>
                  <p>模型：{importedInfo.model}</p>
                  {importedInfo.baseUrlMasked && <p>Base URL：{importedInfo.baseUrlMasked}</p>}
                  <p>API Key：已安全保存到服务器（浏览器不存储真实密钥）</p>
                  <Button variant="outline" size="sm" className="mt-2" onClick={() => { setImported(false); setImportedInfo(null) }}>重新手动配置</Button>
                </div>
              ) : null}

              {/* 手动输入（CLI 不可用且未导入时显示） */}
              {!detectedPlatform && !imported && (
                <>
                  <div>
                    <label className="text-sm font-medium">API Key</label>
                    <Input
                      type="password"
                      value={apiKey}
                      onChange={e => { setApiKey(e.target.value); setTestResult(null) }}
                      placeholder="sk-ant-..."
                      className="mt-1"
                    />
                  </div>
                  <div>
                    <label className="text-sm font-medium">模型</label>
                    <Input
                      value={model}
                      onChange={e => { setModel(e.target.value); setTestResult(null) }}
                      placeholder="claude-sonnet-4-20250514"
                      className="mt-1"
                    />
                  </div>
                  <div>
                    <label className="text-sm font-medium">Base URL（可选，用于第三方 API）</label>
                    <Input
                      value={baseUrl}
                      onChange={e => { setBaseUrl(e.target.value); setTestResult(null) }}
                      placeholder="https://api.example.com"
                      className="mt-1"
                    />
                  </div>
                </>
              )}

              <div className="flex gap-2">
                {!imported && !detectedPlatform && (
                  <Button variant="outline" size="sm" onClick={fetchProviders}>
                    从 CC-Switch 导入
                  </Button>
                )}
                <Button variant="outline" size="sm" onClick={testConnection} disabled={testing}>
                  {testing ? '测试中...' : '测试连接'}
                </Button>
              </div>
              {testResult && (
                <div className={`text-sm p-2 rounded ${testResult.success ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'}`}>
                  {testResult.success ? `连接成功：${testResult.response || testResult.message || ''}` : `连接失败：${testResult.error || testResult.message || ''}`}
                </div>
              )}
              {showProviders && providers.length > 0 && (
                <div className="space-y-1 border rounded p-2 max-h-32 overflow-y-auto">
                  <p className="text-xs text-gray-500">选择服务商导入配置：</p>
                  {providers.map(p => (
                    <button
                      key={p.name}
                      className="text-xs w-full text-left p-1 hover:bg-gray-100 rounded"
                      onClick={() => importProvider(p.name)}
                    >
                      {p.displayName}
                    </button>
                  ))}
                </div>
              )}
              {error && <p className="text-sm text-red-500">{error}</p>}
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setStep('welcome')}>上一步</Button>
              <Button variant="outline" onClick={handleSkip}>跳过，稍后配置</Button>
              <Button onClick={() => setStep('agents')}>下一步</Button>
            </DialogFooter>
          </>
        )}

        {step === 'agents' && (
          <>
            <DialogHeader>
              <DialogTitle>预设 Agent 平台设置</DialogTitle>
              <DialogDescription>
                {detectedPlatform
                  ? `检测到 ${detectedPlatform === 'claude-code' ? 'Claude CLI' : 'OpenCode CLI'}，预设 Agent 将使用 CLI 平台。`
                  : '未检测到 CLI，预设 Agent 将使用 LLM API 平台。'}
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-3">
              {!detectedPlatform && (
                <label className="flex items-center gap-2 text-sm cursor-pointer">
                  <input
                    type="checkbox"
                    checked={applyToPresets}
                    onChange={e => setApplyToPresets(e.target.checked)}
                    className="accent-blue-500"
                  />
                  将预设 Agent 改为 LLM API 平台（CLI 不可用时的备选方案）
                </label>
              )}
              <p className="text-xs text-gray-500">
                架构师、前端工程师、后端工程师、测试工程师、产品经理、UI 设计师
              </p>
              {error && <p className="text-sm text-red-500">{error}</p>}
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setStep('config')}>上一步</Button>
              <Button variant="outline" onClick={handleSkip}>跳过，稍后配置</Button>
              <Button onClick={handleComplete} disabled={saving}>
                {saving ? '保存中...' : '完成配置'}
              </Button>
            </DialogFooter>
          </>
        )}

        {step === 'done' && (
          <>
            <DialogHeader>
              <DialogTitle>配置完成</DialogTitle>
            </DialogHeader>
            <p className="text-sm text-gray-600">配置已保存，即将进入 AgentHub 主界面。</p>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
