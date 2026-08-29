# P9-B gate smoke launcher v4 (explicit p5 vitest config; repo from Split-Path; no inline path literals)
$ErrorActionPreference = 'Stop'
$p5 = $PSScriptRoot
$repo = Split-Path (Split-Path $p5 -Parent) -Parent
$lines = Get-Content (Join-Path $p5 '.env.local') | Where-Object { $_ -match '=' -and $_ -notmatch '^\s*#' }
$envMap = @{}
foreach ($l in $lines) { $k,$v = $l.Split('=',2); $envMap[$k.Trim()] = $v.Trim() }
$env:GLM_API_KEY   = $envMap['GLM_API_KEY']
$env:GLM_BASE_URL  = $envMap['GLM_BASE_URL']
$env:GLM_MODEL     = $envMap['GLM_MODEL']
$env:CLAUDE_CONFIG_DIR = Join-Path $p5 '.claude-cfg'
$env:P7_GATE = '1'
$inner = 'npx vitest run --config experiments/p5/vitest.config.ts experiments/p5/run.test.ts > experiments\p5\results\p9b-gate.log 2>&1'
$p = Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', $inner -WorkingDirectory $repo -PassThru -WindowStyle Hidden
Write-Output "PID=$($p.Id) started=$([DateTime]::Now.ToString('HH:mm:ss'))"
