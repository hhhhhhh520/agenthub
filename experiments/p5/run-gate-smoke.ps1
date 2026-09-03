# P10 launcher v7.1. Modes:
#   gate            = smoke cell (on-seqgate+verify x A x5), same as v6
#   pilot <modelId> = band probe cell (off+verify x A x5), model override ONLY (baseUrl/key single-slot from .env.local)
#   sentinel        = preflight-only control run (P5_SENTINEL=1)
#   matrix (no arg) = 45-run full matrix (P9_ARMS=1)
#   check [logName] [batch|sentinel] = machine verdict (batch default). v7's positional
#     expectedPassed/allowSkipped/expectRows form is RETIRED (v7.1, plan Step7-3): batch verdict reads the
#     harness's own runs= rows= signal and cross-checks it against the real metrics.jsonl line count,
#     so it no longer depends on vitest's passed count (that number includes ~44 always-run unit tests whose
#     count drifts as tasks are added -- the 44-off false-FAIL trap).
#   v7.2: sentinel verdict reads results/preflight-last.json (a file signal) because vitest v4 intercepts
#     console emitted inside a test body -- T6 Step0's real sentinel run produced 45 passed and zero
#     [preflight] lines in its log.
#   v7.3: batch verdict reads results/p5-batch-last.json (file signal written by the matrix describe's
#     afterAll via buildBatchRecord, overwrite semantics); the log's [P5-BATCH] console line is RETIRED
#     from the verdict -- its redirection into the log is INTERMITTENT (P10 pilot 20260902-201732: clean
#     49-passed batch, zero [P5-BATCH] lines in the log; p9b-pilot.log has the line, p9b-strong.log does
#     not). Console marker in the log = informational only. Missing/stale/unparseable file => fail-closed.
# VERDICT READING (Step7-6, contract unchanged by v7.1): ENV_SUSPECT keeps exit 0 by design -- the env assertion
#   is a three-value reading (VALID / SUSPECT / not-checked), not a pass-fail. CHECK OK + ENV_SUSPECT means
#   "batch completed but every run is a floor reading (H4 invalid)". T6/T7 MUST grep the text markers; keying
#   only off $LASTEXITCODE scores a dead-environment batch as a pass.
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
  # v7.1 tokenized verdict (plan Step7-3). v7's positional expectedPassed/allowSkipped/expectRows are RETIRED.
  $log = ''; $kind = 'batch'
  if ($args.Count -gt 1) { $log = [string]$args[1] }
  if ($args.Count -gt 2) { $kind = [string]$args[2] }
  if ($args.Count -gt 3) { Write-Output "CHECK FAIL: usage: check [logName] [batch|sentinel] (got $($args.Count - 1) args)"; exit 1 }
  if ($kind -ne 'batch' -and $kind -ne 'sentinel') { Write-Output "CHECK FAIL: usage: unknown check kind '$kind' (expect batch|sentinel)"; exit 1 }
  # A bare number here means the operator is still on v7's retired `check <expectedPassed> ...` form — say so
  # instead of reporting a confusing "log not found".
  if ($log -match '^\d+$') { Write-Output "CHECK FAIL: usage: check takes [logName] [batch|sentinel]; the positional expectedPassed form was retired in v7.1 (got '$log')"; exit 1 }
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
  if (-not (Test-Path -LiteralPath $logPath)) { Write-Output "CHECK FAIL: log not found: $log"; exit 1 }
  $content = Get-Content -LiteralPath $logPath -Raw
  if ($content -match 'Tests\s+(\d+) failed') { Write-Output "CHECK FAIL: $($Matches[1]) failed in $log"; exit 1 }
  if ($content -match '\b429\b|HTTP/1\.[01] 429|rate.?limit|overloaded|retry-after|too many') { Write-Output 'WARN THROTTLE SIGNATURES PRESENT' }

  if ($kind -eq 'sentinel') {
    # Control group: preflight-only. No [P5-BATCH] marker exists by design (the matrix describe is skipped).
    # v7.2: the signal is a FILE, not console -- vitest v4 intercepts console emitted inside a test body
    # (T6 Step0 real run: 45 passed, zero [preflight] lines in the 309B log). afterAll console is not
    # intercepted, which is why batch's marker still works. File exists => the most recent preflight SUCCEEDED
    # (setup.ts writes it only after every verdict passes).
    # Keep the batch-log rejection: a batch run ALSO writes preflight-last.json (its beforeAll preflights) and
    # has a passed summary, so without it `check <batchlog> sentinel` could pass everything below.
    if ($content -match '\[P5-BATCH\]') { Write-Output 'CHECK FAIL: batch log passed as sentinel'; exit 1 }
    $pfPath = Join-Path $results 'preflight-last.json'
    if (-not (Test-Path -LiteralPath $pfPath)) { Write-Output "CHECK FAIL: preflight-last.json missing (no successful preflight on record)"; exit 1 }
    $pf = $null
    try { $pf = Get-Content -LiteralPath $pfPath -Raw | ConvertFrom-Json } catch { Write-Output "CHECK FAIL: preflight-last.json unparseable"; exit 1 }
    # Staleness gate vs the log's CREATION time (not LastWriteTime -- the log keeps growing until the run ends,
    # so a genuine sentinel's file is always older than the log's last write). The record must postdate the log
    # file's creation, else it belongs to an earlier batch and this sentinel may have skipped preflight entirely
    # (skipped batch + stale file + unchanged key would otherwise read as PASS).
    # Honest limitation (r3 doc): the gate is mtime-based, and any rewrite of preflight-last.json refreshes it --
    # it proves "a preflight ran during this log's lifetime", NOT "this file's content came from this run".
    # Content identity is what the fingerprint check below establishes.
    if ((Get-Item -LiteralPath $pfPath).LastWriteTime -lt (Get-Item -LiteralPath $logPath).CreationTime) {
      Write-Output "CHECK FAIL: preflight-last.json predates this log (stale signal -- this sentinel never preflighted)"; exit 1
    }
    # Fingerprint binding needs the launcher's key, so sentinel check reads .env.local here (batch stays independent of it).
    # r3-guard: a missing/unreadable .env.local must come back as a marked verdict, not a bare terminating error.
    $pfEnv = @{}
    try {
      foreach ($l in (Get-Content (Join-Path $p5 '.env.local') | Where-Object { $_ -match '=' -and $_ -notmatch '^\s*#' })) { $k, $v = $l.Split('=', 2); $pfEnv[$k.Trim()] = $v.Trim() }
    } catch { Write-Output "CHECK FAIL: .env.local unreadable"; exit 1 }
    if (-not $pfEnv['GLM_API_KEY']) { Write-Output 'CHECK FAIL: .env.local missing GLM_API_KEY (cannot bind sentinel fingerprint)'; exit 1 }
    $pfKeyfp = Get-KeyFp8 $pfEnv['GLM_API_KEY']
    if ($pf.keyFingerprint8 -ne $pfKeyfp) { Write-Output "CHECK FAIL: preflight fingerprint mismatch ($($pf.keyFingerprint8) vs $pfKeyfp) -- this sentinel did not run with the launcher key"; exit 1 }
    if (-not ($pf.latencyMs -is [int] -or $pf.latencyMs -is [long] -or $pf.latencyMs -is [double]) -or [double]$pf.latencyMs -le 0) { Write-Output "CHECK FAIL: preflight latencyMs not a positive number ($($pf.latencyMs))"; exit 1 }
    Write-Output "PREFLIGHT OK model=$($pf.model) latency=$($pf.latencyMs)ms key#$pfKeyfp"
    Write-Output "CHECK OK sentinel log=$log"
    exit 0
  }

  # batch: cross-check the harness's own file signal against the on-disk ledger. What the triple
  # (signal runs == signal rows == actual metrics.jsonl lines) actually proves is *ledger consistency*: the batch
  # registered N runs, all N landed, and nothing was lost or padded. It does NOT prove N real LLM round-trips --
  # run-one.ts:152-172 appends a row per ATTEMPTED run too (its error path writes minimalErrorRow with
  # totalTransitions=0), so a batch of dead calls can still show runs==rows==45. The floor/environment reading
  # is ENV_VALID below, which is deliberately weak (>=1 live row); the per-run truth is failureMode in the
  # ledger itself, which T6/T7 read directly.
  # v7.3: the signal is a FILE (results/p5-batch-last.json, written by the matrix describe's afterAll), not the
  # log's console line -- that line's redirection into the log is intermittent (P10 pilot 20260902-201732: clean
  # 49-passed batch, zero [P5-BATCH] lines in the log). Console marker in the log = informational only.
  if ($content -match '\[P5-BATCH\]') { Write-Output 'INFO: log carries a console [P5-BATCH] line (informational only, verdict reads p5-batch-last.json)' }
  $sigPath = Join-Path $results 'p5-batch-last.json'
  if (-not (Test-Path -LiteralPath $sigPath)) { Write-Output "CHECK FAIL: p5-batch-last.json missing (batch never reached afterAll)"; exit 1 }
  # Staleness gate vs the log's CREATION time, same method as the sentinel branch (r2): the record must postdate
  # the log file's creation, else it belongs to an earlier batch. mtime-based, and any rewrite refreshes it --
  # it proves "a batch finished during this log's lifetime", NOT "this file's content came from this run";
  # content identity is what the runs/rows/metrics triple below establishes.
  if ((Get-Item -LiteralPath $sigPath).LastWriteTime -lt (Get-Item -LiteralPath $logPath).CreationTime) {
    Write-Output 'CHECK FAIL: p5-batch-last.json predates this log (stale)'; exit 1
  }
  $sig = $null
  try { $sig = Get-Content -LiteralPath $sigPath -Raw | ConvertFrom-Json } catch { Write-Output 'CHECK FAIL: p5-batch-last.json unparseable'; exit 1 }
  # r2-style type guard (mirror of the sentinel latencyMs check): a hand-edited signal with non-numeric
  # runs/rows must come back as a marked verdict, not a bare [int] cast terminating error.
  if (-not (($sig.runs -is [int] -or $sig.runs -is [long] -or $sig.runs -is [double]) -and ($sig.rows -is [int] -or $sig.rows -is [long] -or $sig.rows -is [double]))) { Write-Output 'CHECK FAIL: p5-batch-last.json runs/rows not numeric'; exit 1 }
  $runs = [int]$sig.runs; $mrows = [int]$sig.rows
  if ($runs -lt 1) { Write-Output "CHECK FAIL: p5-batch-last.json runs=$runs < 1 (zero-LLM batch: gate cell filtered everything out?)"; exit 1 }
  if ($runs -ne $mrows) { Write-Output "CHECK FAIL: p5-batch-last.json runs=$runs != rows=$mrows (registered runs did not land, OR the ledger was unreadable -- loadMetrics() returns [] on any bad line)"; exit 1 }
  $mj = Join-Path $results 'metrics.jsonl'
  $rows = @()
  if (Test-Path $mj) { $rows = @(Get-Content -LiteralPath $mj | Where-Object { $_ }) }
  if ($rows.Count -ne $mrows) { Write-Output "CHECK FAIL: metrics rows $($rows.Count) != marker rows $mrows"; exit 1 }
  $live = 0; $rowIdx = 0
  foreach ($r in $rows) {
    $rowIdx++
    # Step7-5: a corrupt ledger must come back as a marked verdict, not a bare PS exception blob.
    try { $o = $r | ConvertFrom-Json } catch { Write-Output "CHECK FAIL: metrics.jsonl unparseable at line $rowIdx"; exit 1 }
    if ($o.rounds -ge 2 -and $o.totalTransitions -gt 0) { $live++ }
  }
  if ($live -ge 1) { Write-Output 'ENV_VALID: >=1 run rounds>=2 && trans>0' } else { Write-Output 'ENV_SUSPECT: every run rounds<2 or trans=0 (H4 floor readings INVALID)' }
  Write-Output "CHECK OK rows=$($rows.Count) runs=$runs log=$log"
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
# Step7-1 (finding 1, option A): the v7 anchor sat on the hostname end, so every real endpoint was rejected —
# Claude-CLI bridging to a non-Anthropic provider NEEDS a path (/anthropic, /api). Host is still pinned:
# openrouter.ai.evil.com fails (no '/' at that position) and http:// still fails.
if ($envMap['GLM_BASE_URL'] -notmatch '^https://([A-Za-z0-9.-]+\.)?(openrouter\.ai|xf-yun\.com|volces\.com|bigmodel\.cn)(/.*)?$') {
  Write-Output "LAUNCH BLOCKED: GLM_BASE_URL fails https+host whitelist: $($envMap['GLM_BASE_URL'])"; exit 1
}
$env:GLM_API_KEY = $envMap['GLM_API_KEY']
$env:GLM_BASE_URL = $envMap['GLM_BASE_URL']
$env:GLM_MODEL = $envMap['GLM_MODEL']
$env:CLAUDE_CONFIG_DIR = Join-Path $p5 '.claude-cfg'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
# Step7-4 (finding 新B, proved: a stale P5_SENTINEL=1 in the operator's shell collapsed a matrix batch from 89
# collected tests to 45 — a 45-run batch silently became a single preflight call that "passed"). Clear every
# mode switch first, then set only the one this mode owns. Inactive semantics hold under strict equality:
# parseGateCell (config.ts:21 `!== '1'`), isP9ArmsOnly (:16 `=== '1'`), SENTINEL (run.test.ts:652 `=== '1'`).
$env:P7_GATE = ''; $env:P7_GATE_CELL = ''; $env:P9_ARMS = ''; $env:P5_SENTINEL = ''; $env:EXPERIMENT_STATE_MACHINE = ''; $env:EXPERIMENT_VERIFY = ''; $env:EXPERIMENT_SEQGATE = ''  # P10-T8: clear EXPERIMENT_* too (operator-shell stale exports would pollute report env-snapshot lines)
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
