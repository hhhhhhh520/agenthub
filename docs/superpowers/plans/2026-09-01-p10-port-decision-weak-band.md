# P10 实施计划：移植回顾决策 × 弱模型探带

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> **状态：发射前安全复核完成（PROCEED_WITH_FIXES）——复核 #1-#7 已全部并入本文件（内联超时 35min、throttle 词边界、孤儿闸门列单+P5_FORCE_LAUNCH 通道、preflight 数字边界+void 化、T4/T5 注记），待执行开工**

**Goal:** 落地 P10 spec v2（`docs/superpowers/specs/2026-09-01-p10-port-decision-weak-band-design.md`，git `55f81f9`）：线一 seqgate 移植回顾决策（离线快照分析）+ 线二 OpenRouter 中间带探带与条件 45-run 弱模型批，含双视角审查并入的统计精确化与发射加固。

**Architecture:** 全部代码改动在 `experiments/p5/`（harness）内：stats 加精确检验、report 补环境快照、setup preflight fail-closed 加固、启动器 v7（候选隔离归档/env 断言/check 机判）、超时错位、sentinel 控制组、新离线脚本 analyze-port-replay（快照副本 + query_only + write-self-test + fail-closed）。T5-T8 为执行/裁决/落档任务。

**Tech Stack:** TypeScript + vitest（p5 独立 config）+ @libsql/client（既有）+ PowerShell 5.1 + prisma sqlite（dev.db 快照）+ OpenRouter（Anthropic 兼容端点）。

## Global Constraints（每个任务隐含遵守）

1. **`src/lib/**` 与 `src/app/**` 零改动**——生产默认行为逐字节不变（A 方向红线，spec §6）。
2. 不新增运行时依赖；dev 工具走 `npx -y --registry=https://registry.npmmirror.com <tool>`，不写进 package.json。
3. 实验开关一律**严格相等**（`=== 'on'` / `=== '1'`），禁真值判断（F4 传统）。
4. **密钥纪律**：key 只存在于 `experiments/p5/.env.local`（单槽位三元组），永不进 argv；任何输出只允许 key 的 sha256 前 8 位指纹。
5. 可提交产物**只允许聚合数字**（F8）：sessionId 明细、用户消息摘录只进 gitignored 的 `results/`。
6. p5 测试从仓库根跑必须 `npx vitest run --config experiments/p5/vitest.config.ts <文件>`；新测试文件必须进该 config include（CLAUDE.md 规则）。
7. 暂存 tracked 文件 `git add --renormalize <file>`；新文件 `git add <file>`；每任务提交前全测试绿 + pre-commit 三视角审查（SDD 门禁）。
8. `.ps1` 内**不得有中文字面量**（PS 5.1 GBK 误读）；路径一律 `$PSScriptRoot` 推导。
9. 发射后**验证日志文件出现**再返回；vitest Temp/ssr ENOENT flake（>60s 批、复跑即绿）单例失败先复跑一次再报。
10. 时间戳比较一律 `Date.parse()` 数值比（raw libsql 是 TEXT `+00:00`，trace ts 是 `Z`）；仅 updatedAt 展示/快照边界可字典序。

## 文件结构

| 文件 | 动作 | 任务 |
|---|---|---|
| `experiments/p5/stats.ts` | 改：`mcnemarExact` 新增；`pairedMcNemar` 返回值加 `pExact`；:35 注释修正 | T1 |
| `experiments/p5/report.ts` | 改：环境快照段；四处配对行双口径 | T1 |
| `experiments/p5/run.test.ts` | 改：stats/report 测试并入；sentinel describe + 主 describe skipIf | T1/T3 |
| `experiments/p5/setup.ts` + `setup.test.ts` | 改：preflight 黑名单+耗时/指纹回显 | T2 |
| `experiments/p5/run-gate-smoke.ps1` | 重写 v7：五模式+全套断言+check 机判 | T3 |
| `experiments/p5/vitest.config.ts` | 改：35min 超时；include 扩两行 | T3/T4 |
| `experiments/p5/analyze-port-replay.ts` + `.test.ts` | 新增：线一全部逻辑 | T4 |
| `issues/ISSUE-020/021`、`CLAUDE.md` 两行、PROGRESS/规划/memory 落档 | 执行/文档 | T5-T8 |

---

### Task 1: stats 精确 McNemar + report 环境快照/双口径（spec §0 更正、§2.3；F5）

**Files:**
- Modify: `experiments/p5/stats.ts`（:33-49）
- Modify: `experiments/p5/report.ts`（头部 :15 后、配对行 :48/:57/:66/:84）
- Test: `experiments/p5/run.test.ts`（stats describe :295-300 附近追加）

**Interfaces:**
- Produces: `mcnemarExact(b: number, c: number): number`；`pairedMcNemar` 返回 `{ b, c, pValue, pExact }`（pValue 语义不变=渐近，向后兼容）。report 输出新增 `## 环境快照` 段与 `p_exact=` 标记（T6/T7 读分依赖）。

- [ ] **Step 1: 写失败测试（run.test.ts）**

Grep `from './stats'` 定位 run.test.ts 的 stats import 行，花括号并入 `mcnemarExact`；确认 `generateReport`、`RunMetrics` 已 import（缺则补 `import { generateReport } from './report'`、`import type { RunMetrics } from './metrics'`）。在 :300 pairedMcNemar 测试同 describe 追加：

```ts
it('mcnemarExact: b=0,c=4 → 0.125（P9-乙 C 格校准锚点）；b+c=0 → 1；n=1 → 1；b=0,c=8 → 0.0078125', () => {
  expect(mcnemarExact(0, 4)).toBeCloseTo(0.125, 6)
  expect(mcnemarExact(0, 0)).toBe(1)
  expect(mcnemarExact(1, 0)).toBe(1)
  expect(mcnemarExact(0, 8)).toBeCloseTo(0.0078125, 8)
})
it('pairedMcNemar 增 pExact：off全败on全过 → b=0 c=4，渐近≈0.0455 与精确 0.125 并列', () => {
  const r = pairedMcNemar([false, false, false, false], [true, true, true, true])
  expect(r.b).toBe(0); expect(r.c).toBe(4)
  expect(r.pValue).toBeCloseTo(0.0455, 3)
  expect(r.pExact).toBeCloseTo(0.125, 5)
})
it('generateReport 含环境快照段与 p_exact 行（P10 读分标记）', () => {
  const mk = (config: string, seed: number, pass: boolean): RunMetrics => ({
    runId: `${config}-${seed}`, config: config as RunMetrics['config'], taskId: 'A', seed, pass,
    failureMode: pass ? 'pass' : 'no-pass', rounds: 5, escalateCount: 0, correctionCount: 0,
    illegalProposalCount: 0, totalTransitions: 3, latencyMs: 1000, tracePath: 'x',
  })
  const rows: RunMetrics[] = []
  for (let s = 0; s < 5; s++) rows.push(mk('off+verify', s, false))
  for (let s = 0; s < 5; s++) rows.push(mk('on+verify', s, s < 4))
  const rep = generateReport(rows)
  expect(rep).toContain('## 环境快照')
  expect(rep).toContain('p_exact=')
  expect(rep).toContain('key 指纹')
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run --config experiments/p5/vitest.config.ts run.test.ts -t "mcnemarExact"` → FAIL（not defined）

- [ ] **Step 3: stats.ts 实现**

:35 注释 `Spec §4.4：15 对` 改为 `每 task 同 seed 5 对（无 15 对合并检验——P10 声明核查修正）`。`chi2Survival1` 之后新增：

```ts
/** 精确 McNemar（二项双侧）：n=b+c，P = 2·P(X ≤ min(b,c))，X~B(n,0.5)，上限截 1。
 *  b+c<25 教科书要求精确式（P10 §0 口径更正：渐近式在小样本上放大显著性）。 */
export function mcnemarExact(b: number, c: number): number {
  const n = b + c
  if (n === 0) return 1
  const k = Math.min(b, c)
  let tail = 0, comb = 1
  for (let i = 0; i <= k; i++) {
    if (i > 0) comb = (comb * (n - i + 1)) / i
    tail += comb
  }
  return Math.min(1, (2 * tail) / Math.pow(2, n))
}
```

`pairedMcNemar` 返回类型改 `{ b: number; c: number; pValue: number; pExact: number }`，return 改 `return { b, c, pValue: chi2Survival1(chi), pExact: mcnemarExact(b, c) }`。

- [ ] **Step 4: report.ts 实现**

顶部加 `import { createHash } from 'node:crypto'`。:15（model 行）后插入：

```ts
  // P10（spec §2.3 / 审查 F5）：环境快照段——P9-F4「报告回显 env 供人眼终检」补票；key 永不回显本体
  lines.push('', '## 环境快照')
  const envOr = (k: string) => process.env[k] ?? '(unset)'
  lines.push(`- EXPERIMENT_STATE_MACHINE=${envOr('EXPERIMENT_STATE_MACHINE')} | EXPERIMENT_VERIFY=${envOr('EXPERIMENT_VERIFY')} | EXPERIMENT_SEQGATE=${envOr('EXPERIMENT_SEQGATE')}`)
  lines.push(`- P7_GATE=${envOr('P7_GATE')} | P7_GATE_CELL=${envOr('P7_GATE_CELL')} | P9_ARMS=${envOr('P9_ARMS')} | P5_SENTINEL=${envOr('P5_SENTINEL')}`)
  lines.push(`- seed 集=[0,1,2,3,4] | key 指纹=${process.env.GLM_API_KEY ? createHash('sha256').update(process.env.GLM_API_KEY).digest('hex').slice(0, 8) : '(no key)'}（sha256 前 8 位）`)
```

四处配对 push（:48/:57/:66/:84）把 `p≈${m.pValue.toFixed(3)}` 统一替换为 `p_exact=${m.pExact.toFixed(3)} p_asym≈${m.pValue.toFixed(3)}`。

- [ ] **Step 5: 全测试** `npx vitest run --config experiments/p5/vitest.config.ts run.test.ts` → 全绿（:300 旧断言 `pValue<0.1` 不动仍过）。

- [ ] **Step 6: 三视角审查 + 提交**

```bash
git add --renormalize experiments/p5/stats.ts experiments/p5/report.ts experiments/p5/run.test.ts
git commit -m "feat(p5): P10 T1 精确McNemar+report环境快照（统计口径精确化，spec §0/§2.3）"
```

---

### Task 2: setup preflight fail-closed 加固（spec §2.2-②；F3）

**Files:**
- Modify: `experiments/p5/setup.ts`（:106-120 整段替换）
- Test: `experiments/p5/setup.test.ts`（追加 describe）

**Interfaces:**
- Produces: `detectPreflightError(text: string): string | null`；`preflightDecision(): Promise<void>`（加固回显走 console.log 进 .log——发射前复核 #7：不返回未消费字段，避免"设计了但未集成"；T6 Step0 从日志抄 latency 基线）。`setupExperiment` 调用点不变。

- [ ] **Step 1: 写失败测试（setup.test.ts，import 行补 `detectPreflightError`）**

```ts
describe('P10 preflight 加固（F3：provider 错误文本不得判成就绪）', () => {
  it('detectPreflightError 命中黑名单', () => {
    for (const bad of ['API Error: 401 Unauthorized', 'HTTP 429 Too Many Requests', '{"error":{"message":"overloaded"}}', '您的额度不足', '请求过于频繁', 'Service Unavailable', 'invalid api key']) {
      expect(detectPreflightError(bad)).toBeTruthy()
    }
  })
  it('不误伤正常回复/裸数字子串；含 quota 的正文宁严勿松照拦', () => {
    expect(detectPreflightError('就绪')).toBeNull()
    expect(detectPreflightError('OK! 一切正常')).toBeNull()
    expect(detectPreflightError('a 20403 number and latency=14290ms')).toBeNull() // 复核#4：数字必须词边界
    expect(detectPreflightError('a text about quota policies')).toBe('quota')
  })
  it('fix-r1：空结果被上游兜底文本替代（EMPTY_RESPONSE，orchestrator/index.ts:623-626）——哨兵必须在黑名单，否则全 error-chunk 故障判就绪', () => {
    expect(detectPreflightError('[Agent 未返回有效内容]')).toBe('未返回有效内容')
  })
})
```

- [ ] **Step 2: 确认失败** Run: `npx vitest run --config experiments/p5/vitest.config.ts setup.test.ts` → FAIL（not defined）

- [ ] **Step 3: setup.ts 实现**（imports 补 `import { createHash } from 'node:crypto'`；替换 :106-120 的 `preflightDecision`）

```ts
/** P10（F3）：CLI 会把 provider 错误当正文返回（401 合成文本先例）——「非空白即通过」会把环境故障判成就绪。
 *  宁严勿松是 fail-closed 方向：preflight 正文本应只有「就绪」，命中签名即判环境不判模型。
 *  发射前复核 #4：数字 token 加词边界，防 latency/正文裸数字子串误伤。 */
export function detectPreflightError(text: string): string | null {
  const m = text.match(/\b(401|403|429)\b|rate[ -]?limit|too many requests|overloaded|quota|额度|余额|限流|过于频繁|unavailable|invalid api key|未返回有效内容|"error"\s*:/i)
  return m ? m[0] : null
}

/** P10 加固：耗时+key 指纹（非 key 本体）回显建立 R1 读分基线（走 console.log 进 .log，T6 Step0 抄录）；
 *  空文本/错误签名都 throw（快速失败不烧批）。返回 void——复核 #7：无消费方的字段不返回。 */
export async function preflightDecision(): Promise<void> {
  const { prisma } = await import('@/lib/db')
  const orch = await prisma.agent.findFirst({ where: { isOrchestrator: true } })
  if (!orch) throw new Error('preflight: 无 orchestrator agent')
  const key = process.env.GLM_API_KEY ?? ''
  const fingerprint8 = createHash('sha256').update(key).digest('hex').slice(0, 8)
  const { executeSingleAgent } = await import('@/lib/orchestrator')
  const t0 = Date.now()
  const { result } = await executeSingleAgent(
    { name: orch.name, systemPrompt: orch.systemPrompt, platform: orch.platform, model: orch.model, baseUrl: orch.baseUrl, apiKey: orch.apiKey },
    '只回复两个字：就绪', '', () => {},
  )
  const latencyMs = Date.now() - t0
  const reply = (result ?? '').slice(0, 60)
  console.log(`[preflight] model=${CONFIG.model} baseUrl=${orch.baseUrl} latency=${latencyMs}ms key#${fingerprint8} reply="${reply}"`)
  if (!result || !result.trim()) throw new Error(`preflight: LLM 返回空（latency=${latencyMs}ms, key#${fingerprint8}）——provider 未配好`)
  const sig = detectPreflightError(result)
  if (sig) throw new Error(`preflight: 回复含 provider 错误签名「${sig}」（latency=${latencyMs}ms, key#${fingerprint8}）——环境故障，不得进探带读数`)
}
```

- [ ] **Step 4: 测试** `npx vitest run --config experiments/p5/vitest.config.ts setup.test.ts` 全绿；再全量 `npx vitest run --config experiments/p5/vitest.config.ts` → 无 key 环境仅真 LLM describe skip、其余绿（`preflightDecision` 保持 `Promise<void>` 签名不变——复核 #7 定案，既有测试断言不受影响）。

- [ ] **Step 5: 三视角审查 + 提交**

```bash
git add --renormalize experiments/p5/setup.ts experiments/p5/setup.test.ts
git commit -m "feat(p5): P10 T2 preflight错误签名黑名单+耗时/指纹回显（F3加固）"
```

---

### Task 3: 启动器 v7 + 超时错位 + sentinel 接线（spec §2.2-①③、§2.3；F4/F7/F9/F12）

**Files:**
- Rewrite: `experiments/p5/run-gate-smoke.ps1`（v7 全文见 Step 3）
- Modify: `experiments/p5/vitest.config.ts`（:13-14）
- Modify: `experiments/p5/run.test.ts`（:626 主 describe + 新增 sentinel describe）

**Interfaces:**
- Produces: 模式 `gate` / `pilot <modelId>`（**无 baseUrl/key 参数**，单槽 .env.local 是唯一切换面）/ `sentinel` / `matrix`（无参默认）/ `check <expectedPassed> [logName] [allowSkipped] [expectRows]`；check 输出标记 `CHECK OK`(exit0) / `CHECK FAIL`(exit1) / `ENV_VALID|ENV_SUSPECT` / `WARN THROTTLE`——T6/T7 读分全依赖。新 env `P5_SENTINEL==='1'`（严格相等）。

- [ ] **Step 1: 超时错位（F7）——config + 内联两处都改（发射前复核 #1：inline 超时覆盖 config，只改 config = F7 静默失效）**

`experiments/p5/vitest.config.ts` :13-14 改：

```ts
    testTimeout: 35 * 60 * 1000,      // P10 F7：比 CONFIG.timeoutMs(30min) 多 5min——内部 deadline 必先触发，kill+finally+teardown 有余量
    hookTimeout: 35 * 60 * 1000,      // beforeAll 真实 preflight，同值
```

再在 `experiments/p5/run.test.ts` 执行 `grep -n '30 \* 60 \* 1000' experiments/p5/run.test.ts`（当前应为 :633 beforeAll 与 :657 逐 it 两处），**全部**改为 `35 * 60 * 1000`。CONFIG.timeoutMs（config.ts:44）保持 30min 不动——错位关系是：内部 deadline(30) < vitest 判死(35)。

- [ ] **Step 2: run.test.ts sentinel 接线** :626 改（Grep `describe.skipIf(!process.env.GLM_API_KEY)` 定位）：

```ts
const SENTINEL = process.env.P5_SENTINEL === '1'
describe.skipIf(!process.env.GLM_API_KEY || SENTINEL)('P5 pilot: 受控实验全矩阵跑批（configs 全臂 × 3 任务 × 5 seed）', () => {
```

主 describe 块之后新增（`setupExperiment` 已 import，缺则补）：

```ts
// P10（spec §2.2-③）：控制组哨兵——只跑 setupExperiment（含 preflight），探带批末「判环境不判模型」回归用
describe.skipIf(!SENTINEL || !process.env.GLM_API_KEY)('P10 sentinel: preflight-only（控制组回归）', () => {
  it('setupExperiment preflight 通过', async () => { await setupExperiment() }, 5 * 60 * 1000)
})
```

- [ ] **Step 3: run-gate-smoke.ps1 重写（v7 全文）**

```powershell
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
  $content = Get-Content (Join-Path $results $log) -Raw
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
$mj = Join-Path $results 'metrics.jsonl'
if (Test-Path $mj) { Move-Item $mj (Join-Path $results "metrics.auto-$mode-$stamp.jsonl") }  # F4: archive before beforeAll rmSync destroys it
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
$inner = "npx vitest run --config experiments/p5/vitest.config.ts experiments/p5/run.test.ts > experiments\p5\results\$log 2>&1"
$p = Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', $inner -WorkingDirectory $repo -PassThru -WindowStyle Hidden
Write-Output "PID=$($p.Id) mode=$mode model=$model keyfp=$(Get-KeyFp8 $envMap['GLM_API_KEY']) log=$log started=$(Get-Date -Format HH:mm:ss)"
```

- [ ] **Step 4: 语法 + check 合成验证（验后删合成物）**

```powershell
powershell -NoProfile -Command "[void][System.Management.Automation.PSParser]::Tokenize((Get-Content -Raw 'experiments/p5/run-gate-smoke.ps1'), [ref]$null); 'PARSE OK'"
```
Expected `PARSE OK`。然后（先手工把现存 `results/metrics.jsonl` 改名挪走）：写 `results/p10-synth.log` 内容 `Tests  5 passed  (5)`；写 5 行合法 RunMetrics JSON（rounds:6,totalTransitions:4）到 `results/metrics.jsonl`；跑 `powershell -NoProfile -File experiments\p5\run-gate-smoke.ps1 check 5 p10-synth.log` → Expected `ENV_VALID...` + `CHECK OK rows=5`（无 WARN THROTTLE）。负例 A：rows 全 rounds:0 → `ENV_SUSPECT`；负例 B：log 改 `Tests  5 passed | 40 skipped` → `CHECK FAIL: skipped=40`；负例 C：`check 1 <sentinel-log> 1 0` 形态对 sentinel（允许 skip、expectRows=0 不查 ENV）→ `CHECK OK`。**验后删除 p10-synth.log 与合成 metrics.jsonl，恢复挪走的真文件。**

- [ ] **Step 5: 回归** `npx vitest run --config experiments/p5/vitest.config.ts` → 全绿（无 key 时两 describe 皆 skip）。

- [ ] **Step 6: 三视角审查 + 提交**

```bash
git add --renormalize experiments/p5/run-gate-smoke.ps1 experiments/p5/vitest.config.ts experiments/p5/run.test.ts
git commit -m "feat(p5): P10 T3 启动器v7(候选隔离/env断言/孤儿闸门/check机判)+35min超时错位+sentinel(F4/F7/F9/F12)"
```

- [ ] **Step 7: T3 fix-r1（实现者上报 4 项经作者裁定后落地；提交 39e769e/d352d3a 后增补）**

1. **baseUrl 白名单放路径**（发现1，方案A）：v7:64 正则改 `^https://([A-Za-z0-9.-]+\.)?(openrouter\.ai|xf-yun\.com|volces\.com|bigmodel\.cn)(/.*)?$`——主机仍锚死（`openrouter.ai.evil.com` 因尾随非 `/` 不匹配），只解耦 path；现存 `.env.local` 的 `…/anthropic` 与 OpenRouter `/api` 均放行。
2. **preflight 黑名单补传输层签名**（发现2，PROBE A 实证：连接拒绝以正文返回判就绪）：setup.ts `detectPreflightError` alternation 加 `unable to connect|connectionrefused|econnrefused|fetch failed|\bapi error\b|\btimed? ?out\b`（数字类保持词边界风格）；setup.test.ts 补正例 `'API Error: Unable to connect to API (ConnectionRefused)'`。
3. **check 标记化机判（消灭 44 单测漂移，发现C/新A）**：run.test.ts 矩阵 describe 内注册循环计数 `let batchExpected = 0`（每个注册的 LLM it +1），afterAll 在报告输出后追加 `console.log('[P5-BATCH] runs=' + batchExpected + ' rows=' + loadMetrics().length)`；check 模式签名改 `check [logName] [batch|sentinel]`（batch 默认）：batch 判据=无 failed 行 ∧ 命中 `\[P5-BATCH\] runs=(\d+)` ∧ runs≥1 ∧ runs==rows ∧ jsonl 实行数==rows ∧ ENV 地板（jsonl 为 harness 落盘，stdout 伪造不过）；sentinel 判据=无 failed ∧ 命中 `\[preflight\]` 行 ∧ 存在 `Tests\s+\d+ passed`。位置参数 expectedPassed/allowSkipped/expectRows 全部退役（`check 5 p10-synth.log` 旧形态不再有效——合成用例随之重写：log 含 marker 行 `[P5-BATCH] runs=5 rows=5` + 5 行 jsonl 才是正例；marker runs≠rows、缺 marker、rows=0 都是 FAIL 负例）。
4. **跨模式 env 卫生（新B，实证 P5_SENTINEL 残留把矩阵降格成哨兵）**：switch 之前统一 `$env:P7_GATE=''; $env:P7_GATE_CELL=''; $env:P9_ARMS=''; $env:P5_SENTINEL=''` 再按模式置位（严格相等语义下 ''=未激活，已验证 parseGateCell/isP9ArmsOnly/SENTINEL 对 '' 均落非激活）。
5. **check 用法守卫 + jsonl 解析 fail-closed 标记**（视角1 🟡×2）：参数非法（非数字/未知 mode 值）→ `CHECK FAIL: usage...` exit 1；`ConvertFrom-Json` 外套 try/catch → `CHECK FAIL: metrics.jsonl unparseable`（不再裸抛无标记）。
6. 文档化不改码：`ENV_SUSPECT` 维持 exit 0 三值契约（T6/T7 读分**必须 grep 文本标记**，不得只看 exit code）；`metrics.auto-*` 归档件清理挂 T8。
7. 备案不动：run.test.ts:628-646 既有 12 条 TS2345（ProcessEnv）属 Tasks1-2 之前的历史存量，非本任务引入，按"不顺手改"纪律留档。

---

### Task 4: 线一分析脚本 analyze-port-replay（spec §2.1；F1/F2/F6/F8/F10/F11/F13）

**Files:**
- Create: `experiments/p5/analyze-port-replay.ts`
- Create: `experiments/p5/analyze-port-replay.test.ts`
- Modify: `experiments/p5/vitest.config.ts`（include 追加 `'**/analyze-port-replay.test.ts'`）

**Interfaces:**
- Produces:
  - `analyzeSessions(sessions: SessionRow[], tasks: TaskRow[]): PartialStats`
  - `gateHits(hits: HitEvent[]): HitEvent[]`（filter `taskCountAtDecision === 0`）
  - `decideBranch(a: { analyzableSessions: number; gateHitCount: number }): { branch: string; text: string }`（`'3'|'manual'`）
  - `assertFailClosed(st: ReplayStats): void`（throw = 不得输出分支结论）
  - `sanitizeExcerpt(raw: string): string`
  - `prepareSnapshot(devDbPath: string, outDir: string): { copyPath: string; sha256: string }`
  - `openGuardedReadonly(copyPath: string): Promise<Client>`（`import type { Client } from '@libsql/client'`）
  - `readAll(client: Client): Promise<{ journalMode: string; sessions: SessionRow[]; tasks: TaskRow[] }>`
  - `renderReport(st: ReplayStats, decision: { branch: string; text: string }, msgs: Record<string, string>, hits: HitEvent[]): string`
  - 类型 `SessionRow/TaskRow/HitEvent/PartialStats/ReplayStats`
- 运行命令（T5 消费）：`npx -y --registry=https://registry.npmmirror.com tsx@4 experiments/p5/analyze-port-replay.ts`（main 仅直接执行时跑）

- [ ] **Step 1: vitest.config.ts include 加一行**：`include: ['**/run.test.ts', '**/setup.test.ts', '**/analyze-cross-batch.test.ts', '**/analyze-port-replay.test.ts'],`

- [ ] **Step 2: 写失败测试 `analyze-port-replay.test.ts`（全文）**

```ts
import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { createClient } from '@libsql/client'
import {
  analyzeSessions, gateHits, decideBranch, assertFailClosed, sanitizeExcerpt,
  prepareSnapshot, openGuardedReadonly, renderReport,
  type SessionRow, type TaskRow, type ReplayStats,
} from './analyze-port-replay'

const dec = (ts: string, state: string, action: string) => ({
  decisionPoint: 'handleOrchestratorDecision', corrections: [], ts,
  inputState: { phase: 'alignment', phaseStep: null, state },
  llmProposal: { action, reason: 'r' },
  validation: { passed: true, validator: 'applyTransition' },
  actualTransition: { from: state, to: state, action, applied: true, escalated: false },
})
const sess = (id: string, trace: string | null, updatedAt = '2026-08-05T00:00:00.000+00:00'): SessionRow =>
  ({ id, type: 'group', title: 'x', createdAt: '2026-08-01T00:00:00.000+00:00', updatedAt, decisionTrace: trace })
const task = (id: string, sessionId: string, createdAt: string): TaskRow => ({ id, sessionId, createdAt })

describe('analyzeSessions：谓词 + 决策时刻 taskCount（F10）', () => {
  it('idle+done 且任务晚于决策时刻 → 决策时刻 0（gate 命中）/终态 1 两列并存', () => {
    const st = analyzeSessions(
      [sess('g1', JSON.stringify([dec('2026-08-01T05:00:00Z', 'idle', 'done')]))],
      [task('tk1', 'g1', '2026-08-01T06:00:00.000+00:00')],
    )
    expect(st.hits.length).toBe(1)
    expect(st.hits[0].taskCountAtDecision).toBe(0)
    expect(st.hits[0].taskCountFinal).toBe(1)
    expect(st.analyzableSessions).toBe(1)
    expect(gateHits(st.hits).length).toBe(1)
  })
  it('决策时刻已有任务 → 非 gate 命中（事件仍记录）；非 idle 或非 done 不记', () => {
    const st = analyzeSessions(
      [sess('g1', JSON.stringify([
        dec('2026-08-01T05:00:00Z', 'idle', 'done'),
        dec('2026-08-01T05:30:00Z', 'exec', 'done'),
        dec('2026-08-01T05:40:00Z', 'idle', 'self'),
      ]))],
      [task('tk1', 'g1', '2026-08-01T04:00:00.000+00:00')],
    )
    expect(st.hits.length).toBe(1) // 只有 idle+done 入选
    expect(gateHits(st.hits).length).toBe(0) // 决策时刻 taskCount=1
  })
  it('p5-* 会话整体除名（实验数据非真实使用）', () => {
    const st = analyzeSessions([sess('p5-a1', JSON.stringify([dec('2026-08-01T05:00:00Z', 'idle', 'done')]))], [])
    expect(st.analyzableSessions).toBe(0)
    expect(st.hits.length).toBe(0)
  })
  it('坏 JSON / 非数组 → parseFailed；null/空数组 → traceEmpty（三态计数，F2）', () => {
    const st = analyzeSessions([sess('g1', '{bad'), sess('g2', '"scalar"'), sess('g3', null), sess('g4', '[]')], [])
    expect(st.parseFailed).toBe(2)
    expect(st.traceEmpty).toBe(2)
  })
  it('trace 触顶 500 → 除名不判命中，truncatedSessions 计数（F11 下界口径）', () => {
    const big = Array.from({ length: 500 }, () => dec('2026-08-01T05:00:00Z', 'idle', 'done'))
    const st = analyzeSessions([sess('g1', JSON.stringify(big))], [])
    expect(st.truncatedSessions).toBe(1)
    expect(st.hits.length).toBe(0)
    expect(st.analyzableSessions).toBe(1)
  })
  it('typeCounts/maxUpdatedAt 供报告元数据', () => {
    const st = analyzeSessions([sess('g1', '[]', '2026-08-06T00:00:00.000+00:00'), sess('g2', '[]')], [])
    expect(st.typeCounts.group).toBe(2)
    expect(st.maxUpdatedAt).toBe('2026-08-06T00:00:00.000+00:00')
  })
})

describe('decideBranch / assertFailClosed / sanitizeExcerpt', () => {
  it('analyzable<20 → branch 3；≥20 → manual（三分支规则）', () => {
    expect(decideBranch({ analyzableSessions: 19, gateHitCount: 0 }).branch).toBe('3')
    expect(decideBranch({ analyzableSessions: 20, gateHitCount: 5 }).branch).toBe('manual')
  })
  const base: ReplayStats = {
    scannedRows: 21, parseFailed: 0, tracePresent: 0, traceEmpty: 21, analyzableSessions: 0,
    truncatedSessions: 0, typeCounts: {}, hits: [], maxUpdatedAt: 'x',
    journalMode: 'delete', dbCopyPath: 'C:/abs/x.db', sha256: 'a'.repeat(64),
  }
  it('fail-closed：空库/解析失败/无 sha/相对路径都 throw（空壳库不得静默落分支3，F2）', () => {
    expect(() => assertFailClosed(base)).not.toThrow()
    expect(() => assertFailClosed({ ...base, scannedRows: 0 })).toThrow(/fail-closed/i)
    expect(() => assertFailClosed({ ...base, parseFailed: 2 })).toThrow(/fail-closed/i)
    expect(() => assertFailClosed({ ...base, sha256: '' })).toThrow(/fail-closed/i)
    expect(() => assertFailClosed({ ...base, dbCopyPath: 'rel/x.db' })).toThrow(/fail-closed/i)
  })
  it('sanitizeExcerpt：| 转义、控制符/双向覆盖剥离、80 码点截断（emoji 安全，F8）', () => {
    expect(sanitizeExcerpt('a|b\nc')).toBe('a\\|b c')
    expect(sanitizeExcerpt('x‮y')).toBe('x y')
    const emo = '😀'.repeat(85)
    const out = sanitizeExcerpt(emo)
    expect(Array.from(out).length).toBe(81) // 80 码点 + 截断标记「…」1
    expect(out).toBe('😀'.repeat(80) + '…')
  })
})

describe('prepareSnapshot / openGuardedReadonly（F1/F6 实证配方）', () => {
  it('源不存在 throw；wal 非空 throw；正常拷贝 sha256=64hex 且字节一致', () => {
    const dir = mkdtempSync(join(tmpdir(), 'p10snap-'))
    expect(() => prepareSnapshot(join(dir, 'nope.db'), dir)).toThrow(/不存在/)
    writeFileSync(join(dir, 'dev.db'), 'dummy-bytes')
    writeFileSync(join(dir, 'dev.db-wal'), 'nonempty')
    expect(() => prepareSnapshot(join(dir, 'dev.db'), dir)).toThrow(/wal/)
    rmSync(join(dir, 'dev.db-wal'))
    const r = prepareSnapshot(join(dir, 'dev.db'), join(dir, 'out'))
    expect(r.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(r.sha256).toBe(createHash('sha256').update(readFileSync(join(dir, 'dev.db'))).digest('hex'))
    expect(existsSync(r.copyPath)).toBe(true)
  })
  it('openGuardedReadonly：query_only 拦真写；缺 Session 表 → 自测不通过即中止', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'p10db-'))
    const p = join(dir, 't.db')
    const c = createClient({ url: 'file:' + p })
    await c.execute('CREATE TABLE Session (id TEXT PRIMARY KEY, phase TEXT)')
    await c.execute("INSERT INTO Session (id, phase) VALUES ('s1', 'idle')")
    c.close()
    const g = await openGuardedReadonly(p)
    await expect(g.execute("INSERT INTO Session (id) VALUES ('x')")).rejects.toThrow(/readonly/i)
    expect((await g.execute('SELECT id FROM Session')).rows.length).toBe(1) // 读仍可行
    g.close()
    const p2 = join(dir, 'empty.db')
    const c2 = createClient({ url: 'file:' + p2 })
    await c2.execute('SELECT 1')
    c2.close()
    await expect(openGuardedReadonly(p2)).rejects.toThrow(/write-self-test/)
  })
})

describe('renderReport', () => {
  it('含聚合行/分支/消毒摘录；决策与终态两列并示', () => {
    const st: ReplayStats = {
      scannedRows: 21, parseFailed: 0, tracePresent: 1, traceEmpty: 20, analyzableSessions: 4,
      truncatedSessions: 0, typeCounts: { group: 16 }, hits: [], maxUpdatedAt: '2026-08-05',
      journalMode: 'wal', dbCopyPath: 'C:/abs/snap/dev.db', sha256: 'b'.repeat(64),
    }
    const hits = [{ sessionId: 'g1', ts: 1, taskCountAtDecision: 0, taskCountFinal: 1 }]
    const md = renderReport(st, decideBranch({ analyzableSessions: 4, gateHitCount: 1 }), { g1: '帮我|做个东西\n谢谢' }, hits)
    expect(md).toContain('分支 **3**')
    expect(md).toContain('\\|')
    expect(md).toContain('决策时刻')
    expect(md).toContain('sha256')
  })
})
```

- [ ] **Step 3: 跑测试确认失败** `npx vitest run --config experiments/p5/vitest.config.ts analyze-port-replay.test.ts` → FAIL（模块不存在）

- [ ] **Step 4: 实现 `analyze-port-replay.ts`（全文）**

```ts
/** P10 线一：seqgate 移植回顾决策（spec 2026-09-01 §2.1）——dev.db 快照只读分析，零 LLM。
 *  安全配方（审查 F1/F2/F6/F8/F10/F11/F13 并入）：快照副本 + query_only + write-self-test +
 *  fail-closed 前置闸门；禁 import @/lib/db（prisma-libsql 切 WAL + Windows 句柄泄漏，setup.ts:131 实证）；
 *  永不发 PRAGMA journal_mode=<设置>（只读取值）。
 *  注（发射前复核 #5）：query_only 连接可能在快照目录留 -wal/-shm 伴生文件——副本 disposable 无害
 *  （close 不释放句柄是 vitest runner 已知行为，本脚本走 tsx 单进程）；本脚本绝不对活体 dev.db 指路径。 */
import { createClient, type Client } from '@libsql/client'
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { basename, isAbsolute, join, resolve } from 'node:path'

const HERE = import.meta.dirname
const MAX_TRACE = 500 // decision-trace.ts:96 同封顶：截断丢最旧、idle 事件天然最前 → 命中面为下界

export interface SessionRow { id: string; type: string; title: string; createdAt: string; updatedAt: string; decisionTrace: string | null }
export interface TaskRow { id: string; sessionId: string; createdAt: string }
export interface HitEvent { sessionId: string; ts: number; taskCountAtDecision: number; taskCountFinal: number }
export interface PartialStats {
  scannedRows: number; parseFailed: number; tracePresent: number; traceEmpty: number
  analyzableSessions: number; truncatedSessions: number; typeCounts: Record<string, number>
  hits: HitEvent[]; maxUpdatedAt: string
}
export interface ReplayStats extends PartialStats { journalMode: string; dbCopyPath: string; sha256: string }

/** 谓词（双审实证）：decisionPoint='handleOrchestratorDecision' ∧ inputState.state='idle' ∧ llmProposal.action='done'
 *  （llmProposal 是纠正前快照，chat-router:82-87）；transitionPhase 条目天然排除。
 *  taskCountAtDecision = Task.createdAt ≤ entry.ts（Date.parse 数值比，F10）。 */
export function analyzeSessions(sessions: SessionRow[], tasks: TaskRow[]): PartialStats {
  const st: PartialStats = {
    scannedRows: 0, parseFailed: 0, tracePresent: 0, traceEmpty: 0, analyzableSessions: 0,
    truncatedSessions: 0, typeCounts: {}, hits: [], maxUpdatedAt: '',
  }
  for (const s of sessions) {
    st.scannedRows++
    st.typeCounts[s.type] = (st.typeCounts[s.type] ?? 0) + 1
    if (String(s.updatedAt) > st.maxUpdatedAt) st.maxUpdatedAt = String(s.updatedAt) // 展示用同格式可字典序
    if (s.id.startsWith('p5-')) continue
    const raw = s.decisionTrace
    if (raw == null || raw === '' || raw === '[]') { st.traceEmpty++; continue }
    let entries: unknown
    try { entries = JSON.parse(raw) } catch { st.parseFailed++; continue }
    if (!Array.isArray(entries)) { st.parseFailed++; continue }
    st.tracePresent++
    const decEntries = (entries as any[]).filter(e => e?.decisionPoint === 'handleOrchestratorDecision')
    if (decEntries.length > 0) st.analyzableSessions++
    if ((entries as unknown[]).length >= MAX_TRACE) { st.truncatedSessions++; continue }
    const own = tasks.filter(t => t.sessionId === s.id)
    for (const e of decEntries) {
      if (e?.inputState?.state !== 'idle' || e?.llmProposal?.action !== 'done') continue
      const ts = Date.parse(String(e.ts))
      if (Number.isNaN(ts)) { st.parseFailed++; continue }
      const atDecision = own.filter(t => Date.parse(String(t.createdAt)) <= ts).length
      st.hits.push({ sessionId: s.id, ts, taskCountAtDecision: atDecision, taskCountFinal: own.length })
    }
  }
  return st
}

/** 命中面 = seqgate 若在生产会拦的事件（idle 过早 done 且决策时零任务） */
export function gateHits(hits: HitEvent[]): HitEvent[] {
  return hits.filter(h => h.taskCountAtDecision === 0)
}

/** 三分支规则（spec §2.1；计量单位=含 ≥1 条决策点 trace 的非 p5 会话数） */
export function decideBranch(a: { analyzableSessions: number; gateHitCount: number }): { branch: string; text: string } {
  if (a.analyzableSessions < 20) {
    return { branch: '3', text: `样本不足（可分析会话 ${a.analyzableSessions} < 20）→ 维持 env 门控（EXPERIMENT_SEQGATE 生产默认关）不转正。启动条件：可分析会话 ≥20 且 gate 命中 ≥5 时重跑本脚本即出分支 manual 数据（当前命中 ${a.gateHitCount}）` }
  }
  return { branch: 'manual', text: '样本充足 → 人工复核报告命中表的首条用户消息意图（真需求被偷懒 vs 闲聊自然收尾）：误伤高=不转正负决策 / 误伤低=可转正+就绪评估（实施另立项）' }
}

/** fail-closed 前置闸门（F2：任何路径错误不得产出与"真相"同形的报告） */
export function assertFailClosed(st: ReplayStats): void {
  const bad: string[] = []
  if (st.scannedRows === 0) bad.push('scannedRows=0（错路径/空壳库？）')
  if (st.parseFailed > 0) bad.push(`parseFailed=${st.parseFailed}（禁止静默丢弃）`)
  if (!isAbsolute(st.dbCopyPath)) bad.push('dbCopyPath 非绝对路径')
  if (!/^[0-9a-f]{64}$/.test(st.sha256)) bad.push('sha256 未记录')
  if (bad.length) throw new Error(`[port-replay fail-closed] ${bad.join('；')} —— 不得输出任何分支结论`)
}

/** F8 消毒：控制字符（含 ESC/NUL）与双向覆盖符剥离、| 转义防表格撕裂、80 码点截断 */
export function sanitizeExcerpt(raw: string): string {
  const clean = raw.replace(/[\p{Cc}‪-‮⁦-⁩]/gu, ' ').replace(/\|/g, '\\|')
  const cps = Array.from(clean)
  return cps.length > 80 ? cps.slice(0, 80).join('') + '…' : cps.join('')
}

/** F6：wal 非空=应用可能在写 → 拒；只拷主文件（wal 为空无未 checkpoint 提交） */
export function prepareSnapshot(devDbPath: string, outDir: string): { copyPath: string; sha256: string } {
  const src = resolve(devDbPath)
  if (!existsSync(src)) throw new Error(`dev.db 不存在: ${src}`)
  const wal = src + '-wal'
  if (existsSync(wal) && statSync(wal).size > 0) throw new Error(`dev.db-wal 非空（应用可能在写）——先停应用再跑: ${wal}`)
  mkdirSync(outDir, { recursive: true })
  const copyPath = join(outDir, basename(src))
  copyFileSync(src, copyPath)
  return { copyPath, sha256: createHash('sha256').update(readFileSync(copyPath)).digest('hex') }
}

/** F1 实证配方：独立连接 + query_only + write-self-test（UPDATE 必须被拦；缺 Session 表=假只读，中止） */
export async function openGuardedReadonly(copyPath: string): Promise<Client> {
  const client = createClient({ url: 'file:' + copyPath })
  await client.execute('PRAGMA query_only=ON;')
  let blocked = false
  try { await client.execute('UPDATE Session SET phase = phase WHERE 1=0') } catch (e) { blocked = /readonly|query only/i.test(String((e as Error)?.message)) }
  if (!blocked) { client.close(); throw new Error('[port-replay] write-self-test 未拦截写（query_only 失效或库缺 Session 表）——中止') }
  return client
}

export async function readAll(client: Client): Promise<{ journalMode: string; sessions: SessionRow[]; tasks: TaskRow[] }> {
  const jm = await client.execute('PRAGMA journal_mode;')
  const s = await client.execute({ sql: 'SELECT id, type, title, createdAt, updatedAt, decisionTrace FROM Session', args: [] })
  const t = await client.execute({ sql: 'SELECT id, sessionId, createdAt FROM Task', args: [] })
  return {
    journalMode: String((jm.rows[0] as Record<string, unknown>)?.journal_mode ?? ''),
    sessions: s.rows as unknown as SessionRow[],
    tasks: t.rows as unknown as TaskRow[],
  }
}

/** 命中会话首条 user 消息（参数化逐查，命中面≤几十；禁 SELECT * / 禁查 Agent/Provider，F13） */
export async function firstMessages(client: Client, ids: string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  for (const id of ids) {
    const r = await client.execute({ sql: 'SELECT rawContent FROM Message WHERE sessionId = ? ORDER BY createdAt ASC LIMIT 1', args: [id] })
    out[id] = r.rows.length ? String((r.rows[0] as Record<string, unknown>).rawContent ?? '') : ''
  }
  return out
}

export function renderReport(st: ReplayStats, decision: { branch: string; text: string }, msgs: Record<string, string>, hits: HitEvent[]): string {
  const gh = gateHits(hits)
  const l: string[] = []
  l.push('# P10 线一：seqgate 移植回顾决策报告', '')
  l.push('> 本文件在 results/（gitignored）。可提交产物只允许聚合数字（F8）。')
  l.push('', '## 快照元数据（fail-closed 闸门证据）')
  l.push(`- 副本: ${st.dbCopyPath} | sha256: ${st.sha256} | journal_mode: ${st.journalMode} | 快照边界 maxUpdatedAt: ${st.maxUpdatedAt}`)
  l.push(`- 扫描会话 ${st.scannedRows} | trace 三态: 有 ${st.tracePresent} / 空 ${st.traceEmpty} / 解析失败 ${st.parseFailed}（必为 0）`)
  l.push(`- 按 type ${JSON.stringify(st.typeCounts)} | 可分析会话（≥1 决策点，除 p5-）: ${st.analyzableSessions} | 触顶截断除名: ${st.truncatedSessions}（命中面为下界）`)
  l.push('', '## 命中面')
  l.push(`- idle∧done 决策事件 ${hits.length}；其中决策时刻 taskCount=0（seqgate 会拦）: ${gh.length}`)
  if (hits.length) {
    l.push('', '| session（截 8 位） | 决策时刻任务数 | 终态任务数 | 首条消息摘录（消毒） |', '|---|---|---|---|')
    for (const h of hits) l.push(`| ${h.sessionId.slice(0, 8)}… | ${h.taskCountAtDecision} | ${h.taskCountFinal} | ${msgs[h.sessionId] ? sanitizeExcerpt(msgs[h.sessionId]) : '—'} |`)
  }
  l.push('', '## 决策', `- 分支 **${decision.branch}**：${decision.text}`)
  return l.join('\n')
}

async function main(): Promise<void> {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
  const outDir = join(HERE, 'results', `snapshot-${stamp}`)
  const { copyPath, sha256 } = prepareSnapshot(join(HERE, '..', '..', 'dev.db'), outDir)
  const client = await openGuardedReadonly(copyPath)
  const { journalMode, sessions, tasks } = await readAll(client)
  const stats: ReplayStats = { ...analyzeSessions(sessions, tasks), journalMode, dbCopyPath: copyPath, sha256 }
  try {
    assertFailClosed(stats)
  } catch (e) {
    console.error(String((e as Error)?.message ?? e))
    client.close()
    process.exit(1)
  }
  const gh = gateHits(stats.hits)
  const decision = decideBranch({ analyzableSessions: stats.analyzableSessions, gateHitCount: gh.length })
  const msgs = await firstMessages(client, [...new Set(stats.hits.map(h => h.sessionId))])
  client.close()
  writeFileSync(join(HERE, 'results', 'report-p10-port-decision.md'), renderReport(stats, decision, msgs, stats.hits), 'utf8')
  console.log(`BRANCH=${decision.branch}`)
  console.log(`聚合行（可入 docs/memory）: 扫描${stats.scannedRows}/可分析${stats.analyzableSessions}/命中${gh.length}/截断${stats.truncatedSessions} → 分支${decision.branch}`)
}
if (process.argv[1] && process.argv[1].includes('analyze-port-replay')) void main()
```

- [ ] **Step 5: 跑测试** `npx vitest run --config experiments/p5/vitest.config.ts analyze-port-replay.test.ts` → 全 22 断言组绿；再全量 p5 套件 + 生产 `npx vitest run`（根配置）确认零回归。

- [ ] **Step 6: 三视角审查 + 提交**

```bash
git add experiments/p5/analyze-port-replay.ts experiments/p5/analyze-port-replay.test.ts
git add --renormalize experiments/p5/vitest.config.ts
git commit -m "feat(p5): P10 T4 线一analyze-port-replay（快照+query_only+fail-closed，审查F1/F2/F6/F8/F10/F11/F13配方）"
```

---

### Task 5: 线一执行——真库快照分析 + 移植决策落档（spec §2.1 收尾；主控执行）

**Files:**
- Create: `experiments/p5/results/snapshot-<ts>/dev.db`、`results/report-p10-port-decision.md`（均 gitignored）
- Modify: `PROGRESS.md`（完成表 + 待办行）、规划文档 §9.2（本地）、memory（本地）——**只写聚合行（F8）**

**Interfaces:** Consumes T4 的 CLI 命令；Produces 决策一句话 + 启动条件（T8 文档同步、未来复算引用源）。

- [ ] **Step 1: 跑分析** `npx -y --registry=https://registry.npmmirror.com tsx@4 experiments/p5/analyze-port-replay.ts`
  Expected: 输出 `BRANCH=3` + 聚合行 `扫描21/可分析0/命中0/截断0 → 分支3`（若 §0 探测后 dev.db 变化以实输出为准）；exit 0；`results/report-p10-port-decision.md` 出现。
- [ ] **Step 2: 人工验报告**：打开报告确认快照元数据齐（sha256/journal_mode/三态计数），命中表为空或符合 §0 事实。**若命令 exit 1 / 无 `BRANCH=` 行**：fail-closed 闸门触发（复核 #6）——看 stderr 找根因，此时**没有报告文件、不得手搓一份**；修复后重跑。
- [ ] **Step 3: 落档（聚合数字 only）**——PROGRESS.md 待办表上方完成表加一行：
  `| P10-线一 | seqgate 移植回顾决策：**维持 env 门控不转正**（dev.db 快照可分析会话 0<20，分支3）；启动条件=可分析≥20 且命中≥5 重跑 analyze-port-replay | results/report-p10-port-decision.md | 2026-09-0X |`
  规划 §9.2 与 memory 各加同义一句话（本地文档，手动 Edit）。
- [ ] **Step 4: 提交（仅 PROGRESS）** `git add --renormalize PROGRESS.md && git commit -m "docs(progress): P10 线一移植决策落档（分支3 维持门控+启动条件）"`

---

### Task 6: 弱模型探带（pilot）执行（spec §2.2；主控执行，不派子代理）

**Files:**
- Create: `experiments/p5/results/p10-candidates.md`、`results/p10-band-notes.md`（gitignored 台账）
- Modify: `experiments/p5/.env.local`（切 OpenRouter 三元组，验后恢复讯飞——**永不 commit**）

- [ ] **Step -1: 终审 should-fix 两行（终审 PROCEED 附带，先于 T6 落地）**：① ps1 sentinel 分支加固：`check <log> sentinel` 遇日志含 `[P5-BATCH]` 时输出 `CHECK FAIL: batch log passed as sentinel` exit 1（防误用形态跳过 ledger 交叉核）；② report.ts `## 环境快照` 段尾加一行注释：`注: EXPERIMENT_* 为进程基线（批内恒 unset）——每 run 臂值由 metrics 行 config 列驱动（envForConfig 透传），逐格读 pass 数组行，勿读本段判臂`（防 45-run 矩阵报告里 `EXPERIMENT_SEQGATE=(unset)` 被误读为"seqgate 没开"）。两行改动+覆盖断言，提交一个 commit。

- [ ] **Step 0: 基线哨兵（回归 T3 启动器 + 记录强模型基线）**：`.env.local` 仍为讯飞时跑 `powershell -NoProfile -File experiments\p5\run-gate-smoke.ps1 sentinel` → 验日志文件出现（Glob `experiments/p5/results/p10-sentinel-*.log`）→ 完成后 `powershell ... run-gate-smoke.ps1 check <该log> sentinel` → Expected `CHECK OK`（preflight 行含 latency 基线，抄进 p10-candidates.md）。若 FAIL：T3 装置或环境有问题，**停，回修 T3，不带病探带**。
- [ ] **Step 1: 钉候选** `curl -s https://openrouter.ai/api/v1/models -H "Authorization: Bearer <读自.env.local>"`（key 从文件读，不上命令行明文——用 `--header @` 或 powershell 变量拼接）筛 3~9B 付费带 4 个（预期如 `qwen/qwen3-8b`、`meta-llama/llama-3.1-8b-instruct`、`qwen/qwen2.5-7b-instruct`、GLM-4.9(9B) 级；以目录实况+价格定，记录 modelId/价格/参数规模于 p10-candidates.md）。
- [ ] **Step 2: 切 `.env.local`** 三行 = OpenRouter（baseUrl `https://openrouter.ai/api`、key、model 占位候选1）。
- [ ] **Step 3: 逐候选探带**（每候选循环以下 5 步，全程记 p10-band-notes.md）：
  1. `run-gate-smoke.ps1 pilot <modelId>` → **Glob 验 `p10-pilot-<model>-*.log` 出现**才离开（教训③）；
  2. 轮询至 vitest 结束（5 run，预计 20-40min）；
  3. `check <该log>`（batch 标记制） → 记录 `CHECK OK/FAIL`、`ENV_VALID/ENV_SUSPECT`、`WARN THROTTLE` 三标记；
  4. **有效性裁决（F3）**：ENV_SUSPECT 或 WARN THROTTLE → 该候选**重探一次**；再现 → 记「环境除名」，**不计入 H4 地板证据**（不得把限流写成模型失能）；
  5. 有效批读分：powershell `Get-Content results/metrics.jsonl | ConvertFrom-Json` → pass 计数 + failKind 分布 + rounds/trans/latency 列，对照中间带标准（pass 1-4/5 且 skip/非法形态出现）。
- [ ] **Step 4: 控制组哨兵（批末）**：`.env.local` 恢复讯飞三元组 → 再跑 `sentinel` + `check <该log> sentinel`。Expected `CHECK OK`；若控制组也退化 ⇒ **本批探带读分全部作废判环境**，记录并停（不与模型结论混淆）。
- [ ] **Step 5: H4 裁决**：≥1 合格 → 取 |pass数-2.5| 最小者（并列取 latency 低者）钉为弱模型批唯一模型，写 p10-candidates.md 钉选行；全环境除名/全地板/全天花板 → 负结果按 spec §2.2 落档（PROGRESS 一行 + 规划 §9.2 一句），**T7 跳过，直达 T8**。
- [ ] **Step 6: 提交**（本任务无 tracked 代码改动；台账 gitignored；仅当有裁决落档时改 PROGRESS 提交）

---

### Task 7: 条件触发——弱模型 45-run 矩阵 + H5/H6 裁决（spec §2.3；主控执行）

**前置：** T6 有钉选模型。否则本任务标记 SKIPPED。

**Files:**
- Create: `results/metrics.p10-weak-<ts>.bak.jsonl`（发射时自动归档产生）、`results/report-p10-weak.md`（从日志截取+补裁决段）、`results/p10-weak-health.md`
- Modify: `experiments/p5/.env.local`（GLM_MODEL=钉选模型，OpenRouter 三值；**永不 commit**）；`PROGRESS.md`（裁决行）

- [ ] **Step 1: 发射**：`.env.local` 指向钉选模型 → 无参启动器（matrix 模式）→ **Glob 验 `p10-matrix-*.log` 出现**；预计 45 run × 2-5min。
- [ ] **Step 2: 批终机判**：`check <log>` → `CHECK OK` + `ENV_VALID`；`Tests ... passed` 不符（含 flake）→ 复跑一次整批（vitest 单例 Temp/ssr ENOENT 已知，三次以上才升级 ISSUE）。
- [ ] **Step 3: 健康检查（不改 analyze-cross-batch，NormRow 内联，spec §2.3）**：

```bash
node -e "
const rows = require('fs').readFileSync('experiments/p5/results/metrics.jsonl','utf8').split('\n').filter(Boolean).map(l=>JSON.parse(l));
const n=rows.length||1;
const avgTrans=rows.reduce((s,r)=>s+r.totalTransitions,0)/n;
const defectRatio=rows.filter(r=>r.failKind==='defect').length/n;
const roundsFullRatio=rows.filter(r=>r.rounds>=6).length/n;
const contaminated=avgTrans<1.0&&defectRatio>0.8&&roundsFullRatio>0.5;
console.log(JSON.stringify({n,avgTrans,defectRatio,roundsFullRatio,contaminated}));
"
```
Expected `contaminated:false`；true ⇒ 本批改标 `p10-weak-aborted` 落档，停（不得进裁决）。
- [ ] **Step 4: 截取报告**：从 log 中 `===== P5 PILOT REPORT =====` 至尾写入 `results/report-p10-weak.md`（含环境快照段——逐字核对 model/baseUrl/key 指纹与预期一致，F5 人眼终检）。
- [ ] **Step 5: H5/H6 裁决（精确口径为主；终审修正：每 task 5 对下精确双侧 p 下限 = 2/2⁵ = 0.0625，"<0.05" 不可达——以下三类判据取代 v1 的 <0.05 二分）**：读 report 的 `## 配对 McNemar` 与 `## seqgate 臂增量` 各行 `p_exact` 与 b/c：
  - **H5（OFF vs ON）**：(a) 任一 task 不一致对全同向且 p_exact=0.0625（5-0 扫描）⇒ 「方向性强证据（n=5 精确检验下限 0.0625，达不到 0.05），显著性不定论」；(b) 不一致对混合/稀少 ⇒ 「H5 未证实——H1′ 修正义务转 P11」；(c) 天花板/地板格无判别空间 ⇒ 如实注明中间带局限。
  - **H6（seqgate 两行，C 重点）**：(a) seqgate 臂 ≥1 task 出现 b=0 c=4/5 型全同向优势扫描 ⇒ 「方向性强证据（同上口径）」；(b) **镜像否证**：任一 task 出现 b>c 全同向劣势扫描（如 b=4/5 c=0，p_exact=0.0625）⇒ 记「方向性否定证据——seqgate 在弱模型减分」，不得静默落"中间态"；(c) 其余 ⇒ 中间态「方向性证据、n 小不定论」（P9 §11 传统）。
  - 裁决表必须**逐格抄 b/c/p_exact 原始数字**再下判语——先数字后结论，禁止先结论后找数。
  - 裁决表（H4/H5/H6 行 × 依据）手写进 report-p10-weak.md 尾部 `## P10 裁决`。
- [ ] **Step 6: ④顺带并排表**：report-p10-weak.md 加 `## A 任务跨批并排（观察项，非配对）`——强批（off 3/on 2/seqgate 4）vs 弱批 A 三臂行，注「跨模型不构成配对，不做合并显著性声明」。
- [ ] **Step 7: `.env.local` 恢复讯飞** + 提交 PROGRESS 一行裁决摘要。

---

### Task 8: 收尾——随手账 + P9 口径更正同步 + 幽灵线索验证 + 推送门禁（spec §2.4/§0 同步）

**Files:**
- Modify: `CLAUDE.md`（p5 节两行）、`PROGRESS.md`、规划 §9.2（本地）、memory + MEMORY.md（本地）、`results/report-p9b-strong.md`（本地 gitignored，加口径更正行）
- Create: `issues/ISSUE-020-work-dir-teardown-recreation.md`、`issues/ISSUE-021-env-example-ghost-write.md`（若线索验证成立）

- [ ] **Step 1: work/ 清理（F7 后应无孤儿，先查再删）**：

```powershell
powershell -NoProfile -Command "if (Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object CommandLine -match '--model') { 'RUNNING - skip' } else { Remove-Item 'experiments/p5/work/*' -Recurse -Force; (Get-ChildItem 'experiments/p5/work').Count }"
```
Expected: `0`。清理前后计数记入 ISSUE-020。
- [ ] **Step 2: ISSUE-020 建档**（模板照 issues/ 惯例：teardown 无 warn 后目录重建，疑 F7 超时同值孤儿写；状态 🟡 观察中；P10 若再现记录）。
- [ ] **Step 3: CLAUDE.md 两行**——p5 节 :284 include 句 `（仅 run.test.ts/setup.test.ts）` 改为 `（run/setup/analyze-cross-batch/analyze-port-replay 四文件）`；:285 之后加一行：
  `- **长批（>60s）偶发 vitest Temp/ssr ENOENT flake**（P8/P9乙 三次，复跑即绿）：单例失败先整批复跑一次再判，勿改代码找根因（P10 记录）`
- [ ] **Step 4: `.env.example` 幽灵线索验证（只读，不改代码）**：Grep claude-code adapter/process-registry 的 cwd 选择逻辑（`cwd:` in `src/lib/adapter/**`），核对 task C run 的执行 CLI 是否可能在 cwd 回落到仓库根时执行「改 .env.example 端口」罐头指令（tasks.ts:36 + 现存 work 残留 `*/.env.example` 含 PORT=8080——在 Step 1 删除前先取样：`Select-String -Path experiments/p5/work/*/.env.example -Pattern 'PORT=8080' | Select-Object -First 5`）。成立 ⇒ 建 ISSUE-021（🔍 排查中，附证据链，处理建议=未来 harness 锁 cwd，不属 P10）；不成立 ⇒ PROGRESS 记「线索排除」。
- [ ] **Step 5: P9 统计口径更正同步**：PROGRESS 完成表 P9-乙 行与规划 §9.2、memory 描述行中「p≈0.046 显著」处统一改为：`C b=0 c=4：渐近 p≈0.046／精确 p=0.125——P10 口径更正：定性为方向性强证据（gate 触发与 pass 完全同现），显著性由弱模型批精确口径复检`；`results/report-p9b-strong.md` 尾部加同义更正段（本地）。
- [ ] **Step 6: 全量回归** `npx vitest run`（根，Expected 1067+ 全绿或已知 flake 复跑）+ `npx vitest run --config experiments/p5/vitest.config.ts` 全绿。
- [ ] **Step 7: 推送门禁（用户确认后执行）**：密钥扫描（`git diff origin/master..HEAD | grep -iE 'sk-|api[_-]?key\s*=\s*[A-Za-z0-9]'` 排除测试占位）→ 文档同步自查 → `.env*`/results gitignore 复核 → `git push`。推送结果如实回报。

---

## Self-Review 记录（写计划后回查）

1. **spec 覆盖**：§0 更正→T1/T5/T8；§2.1 全部→T4/T5；§2.2-①②③④→T3/T2/T6；§2.3→T1(精确/快照)/T3(超时/sentinel)/T7(健康/裁决/④)；§2.4→T8；§4 验证→各任务 Step + T3-Step4；§5 R1-R8→T3 check 标记/T6 Step3-4/T8 Step1-2。无缺口。
2. **占位符**：无 TBD；T6 候选名单允许「以目录实况定」属 spec 既定的计划化动作（附预期示例与筛选规则），非占位。
3. **类型一致**：`pExact`（T1 产）↔ report 行（T1 内）；`P5_SENTINEL`（T3 两处）；`check` v7.1 标记制（T3-Step7 定义 ↔ T6 Step0 `check <log> sentinel` / T7 batch 调用）；`gateHits/decideBranch` 签名（T4 测试↔实现↔T5 消费）；`analyzeSessions` 返回 `PartialStats` + main 里 spread 补三字段成 `ReplayStats`——一致。
4. **已知偏差声明**：`spec §2.2-① 的 metrics 行断言`实现为 check 模式 expectRows ≥ 判定（不是 ==），因为 resume 批行数可超——刻意保留。
5. **发射前复核并入（Security Engineer PROCEED_WITH_FIXES，实证 15+ 承重假设全部对上 schema/migration/dev.db 实测）**：#1 run.test.ts 内联 30min 超时覆盖 config→T3 Step1 加两处 35min；#2 throttle `429` 裸子串误伤 latency 数字→词边界+HTTP/rate 短语；#3 孤儿闸门会拦无关交互会话→打印明细+`P5_FORCE_LAUNCH==='1'` 显式通道（fail-safe 不 kill）；#4 preflight 数字 token 加 `\b`（含负例测试）；#5 T4 注记（副本伴生文件无害/永不指活库）；#6 T5 fail-closed 无报告时看 stderr 禁止手搓；#7 preflightDecision 无消费方字段删除改回 void（防"设计了未集成"）。复核并确证：SQL 列名/表名、`+00:00` 日期格式、write-self-test 双分支、dev.db 实数（扫描21/可分析0/命中0→分支3）、vitest 下 argv 守卫、T1 四处替换行字节一致无旧断言冲突。


