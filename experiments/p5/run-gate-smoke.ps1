# P10 launcher v7. Modes:
#   gate            = smoke cell (on-seqgate+verify x A x5), same as v6
#   pilot <modelId> = band probe cell (off+verify x A x5), model override ONLY (baseUrl/key single-slot from .env.local)
#   sentinel        = preflight-only control run (P5_SENTINEL=1)
#   matrix (no arg) = 45-run full matrix (P9_ARMS=1)
#   check <expectedPassed> [logName] [allowSkipped] [expectRows] = machine verdict (F3/F4/F12); expectRows default=expectedPassed
# Keys never on cmdline (F9). No Chinese literals (PS 5.1 GBK). Paths via $PSScriptRoot.
$ErrorActionPreference = 'Stop'
$p5 = $PSScriptRoot
$repo = Split-Path (Split-Path $p5 -Parent) -Parent
$results = Join-Path $p5 'results'

function Get-KeyFp8([string]$k) {
  $sha = [Security.Cryptography.SHA256]::Create()
  ((($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($k))) | ForEach-Object { $_.ToString('x2') }) -join '').Substring(0, 8)
}

if ($args.Count -gt 0 -and $args[0] -eq 'check') {
  $expected = [int]$args[1]
  $log = ''; $allowSkipped = 0; $expectRows = $expected
  if ($args.Count -gt 2 -and $args[2]) { $log = $args[2] }
  if ($args.Count -gt 3) { $allowSkipped = [int]$args[3] }
  if ($args.Count -gt 4) { $expectRows = [int]$args[4] }
  if (-not $log) {
    $newest = Get-ChildItem $results -Filter 'p10-*.log' | Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if (-not $newest) { Write-Output 'CHECK FAIL: no p10-*.log found'; exit 1 }
    $log = $newest.Name
  }
  # T3-sec-fix-1 (pre-commit audit): $log is caller-controlled; Join-Path + '..' escaped results/ (proved: check 5 ..\..\..\windows\win.ini
  # resolved to agenthub\windows\win.ini). Pin the read inside $results. GetFullPath is required — the raw joined
  # string still *starts with* results\ before normalization, so a StartsWith on it is a no-op guard.
  $rootPrefix = [IO.Path]::GetFullPath($results) + [IO.Path]::DirectorySeparatorChar
  try { $logPath = [IO.Path]::GetFullPath((Join-Path $results $log)) } catch {
    Write-Output "CHECK FAIL: log name is not a valid path: $log"; exit 1
  }
  if (-not $logPath.StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase)) {
    Write-Output "CHECK FAIL: log must be a file inside results/, not a path: $log"; exit 1
  }
  $content = Get-Content -LiteralPath $logPath -Raw
  if ($content -match 'Tests\s+(\d+) failed') { Write-Output "CHECK FAIL: $($Matches[1]) failed in $log"; exit 1 }
  if ($content -notmatch "Tests\s+$expected passed") { Write-Output "CHECK FAIL: summary '$expected passed' not found in $log (silent-skip or wrong count?)"; exit 1 }
  if ($allowSkipped -eq 0 -and $content -match '(\d+) skipped') { Write-Output "CHECK FAIL: skipped=$($Matches[1]) (expect 0) in $log"; exit 1 }
  if ($content -match '\b429\b|HTTP/1\.[01] 429|rate.?limit|overloaded|retry-after|too many') { Write-Output 'WARN THROTTLE SIGNATURES PRESENT' }
  $mj = Join-Path $results 'metrics.jsonl'
  $rows = @()
  if (Test-Path $mj) { $rows = @(Get-Content $mj | Where-Object { $_ }) }
  if ($rows.Count -lt $expectRows) { Write-Output "CHECK FAIL: metrics rows $($rows.Count) < expectRows $expectRows"; exit 1 }
  if ($expectRows -gt 0) {
    $live = @($rows | ForEach-Object { $_ | ConvertFrom-Json } | Where-Object { $_.rounds -ge 2 -and $_.totalTransitions -gt 0 })
    if ($live.Count -ge 1) { Write-Output 'ENV_VALID: >=1 run rounds>=2 && trans>0' } else { Write-Output 'ENV_SUSPECT: every run rounds<2 or trans=0 (H4 floor readings INVALID)' }
  }
  Write-Output "CHECK OK rows=$($rows.Count) log=$log"
  exit 0
}

# —— launch modes ——
$mode = if ($args.Count -gt 0) { $args[0] } else { 'matrix' }
$orphans = @(Get-CimInstance Win32_Process -Filter "Name='node.exe' OR Name='claude.exe' OR Name='opencode.exe'" | Where-Object { $_.CommandLine -match '--model' })
# Review #3: the bare --model filter also catches unrelated interactive CLI sessions (fail-safe: refuses, never kills).
# It prints the list for triage; kill real experiment orphans, or set P5_FORCE_LAUNCH=1 (strict '1') when the list is all unrelated.
if ($orphans.Count -gt 0 -and $env:P5_FORCE_LAUNCH -ne '1') {
  $orphans | Select-Object -First 5 | ForEach-Object {
    $cl = [string]$_.CommandLine; if ($cl.Length -gt 140) { $cl = $cl.Substring(0, 140) }
    Write-Output "  orphan pid=$($_.ProcessId) name=$($_.Name) cmd=$cl"
  }
  Write-Output "LAUNCH BLOCKED: $($orphans.Count) --model process(es) (F7 gate). Triage list above; P5_FORCE_LAUNCH=1 to proceed if all unrelated."; exit 1
}
$lines = Get-Content (Join-Path $p5 '.env.local') | Where-Object { $_ -match '=' -and $_ -notmatch '^\s*#' }
$envMap = @{}
foreach ($l in $lines) { $k, $v = $l.Split('=', 2); $envMap[$k.Trim()] = $v.Trim() }
foreach ($k in 'GLM_API_KEY', 'GLM_BASE_URL', 'GLM_MODEL') {
  if (-not $envMap[$k]) { Write-Output "LAUNCH BLOCKED: .env.local missing $k (all-or-none rule)"; exit 1 }
}
if ($envMap['GLM_BASE_URL'] -notmatch '^https://([A-Za-z0-9.-]+\.)?(openrouter\.ai|xf-yun\.com|volces\.com|bigmodel\.cn)$') {
  Write-Output "LAUNCH BLOCKED: GLM_BASE_URL fails https+host whitelist: $($envMap['GLM_BASE_URL'])"; exit 1
}
$env:GLM_API_KEY = $envMap['GLM_API_KEY']
$env:GLM_BASE_URL = $envMap['GLM_BASE_URL']
$env:GLM_MODEL = $envMap['GLM_MODEL']
$env:CLAUDE_CONFIG_DIR = Join-Path $p5 '.claude-cfg'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
switch ($mode) {
  'gate'     { $env:P7_GATE = '1'; $model = $envMap['GLM_MODEL']; $log = "p10-gate-$stamp.log" }
  'pilot'    {
    if ($args.Count -lt 2) { Write-Output 'pilot needs <modelId>'; exit 1 }
    if ($args[1] -notmatch '^[A-Za-z0-9._\/:-]+$') { Write-Output 'pilot modelId fails whitelist'; exit 1 }
    $env:P7_GATE = '1'; $env:P7_GATE_CELL = 'off+verify|A'; $env:GLM_MODEL = $args[1]; $model = $args[1]
    $log = 'p10-pilot-' + ($model -replace '[^A-Za-z0-9._-]', '_') + '-' + $stamp + '.log'
  }
  'sentinel' { $env:P5_SENTINEL = '1'; $model = $envMap['GLM_MODEL']; $log = "p10-sentinel-$stamp.log" }
  'matrix'   { $env:P9_ARMS = '1'; $model = $envMap['GLM_MODEL']; $log = "p10-matrix-$stamp.log" }
  default    { Write-Output "unknown mode: $mode"; exit 1 }
}
# T3-sec-fix-2 (pre-commit audit): archive AFTER mode validation. It used to sit before the switch, so a typo'd
# mode or `pilot` without modelId renamed the live metrics.jsonl away — with $mode (an unvalidated string, could
# carry '..') in the destination name. F4 semantics unchanged for all four valid modes: still archived before
# the batch's beforeAll rmSync can destroy it.
$mj = Join-Path $results 'metrics.jsonl'
if (Test-Path $mj) { Move-Item $mj (Join-Path $results "metrics.auto-$mode-$stamp.jsonl") }
$inner = "npx vitest run --config experiments/p5/vitest.config.ts experiments/p5/run.test.ts > experiments\p5\results\$log 2>&1"
$p = Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', $inner -WorkingDirectory $repo -PassThru -WindowStyle Hidden
Write-Output "PID=$($p.Id) mode=$mode model=$model keyfp=$(Get-KeyFp8 $envMap['GLM_API_KEY']) log=$log started=$(Get-Date -Format HH:mm:ss)"
