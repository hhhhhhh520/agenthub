# P9-B launcher v5: arg 'gate' = smoke cell (on-seqgate+verify x A x5, P7_GATE=1); no arg = full matrix (45 runs x arms)
# Key never on cmdline; read from .env.local. Repo root via Split-Path (no Chinese literals -> PS 5.1 GBK issue).
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
if ($args.Count -gt 0 -and $args[0] -eq 'gate') { $env:P7_GATE = '1'; $log = 'p9b-gate.log' } else { $log = 'p9b-strong.log' }
$inner = "npx vitest run --config experiments/p5/vitest.config.ts experiments/p5/run.test.ts > experiments\p5\results\$log 2>&1"
$p = Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', $inner -WorkingDirectory $repo -PassThru -WindowStyle Hidden
Write-Output "PID=$($p.Id) mode=$($log) started=$([DateTime]::Now.ToString('HH:mm:ss'))"
