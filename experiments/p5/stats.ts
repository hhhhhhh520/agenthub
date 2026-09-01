import type { RunMetrics } from './metrics'

/** bootstrap 重采样 CI（Spec §4.4：≥1000 resample） */
export function bootstrapCI(passes: boolean[], n = 1000): { low: number; high: number; mean: number } {
  if (passes.length === 0) return { low: 0, high: 0, mean: 0 }
  const sample = () => {
    let ok = 0
    for (let i = 0; i < passes.length; i++) if (passes[Math.floor(Math.random() * passes.length)]) ok++
    return ok / passes.length
  }
  const dist = Array.from({ length: n }, sample).sort((a, b) => a - b)
  return {
    low: dist[Math.floor(n * 0.025)],
    high: dist[Math.floor(n * 0.975)],
    mean: passes.filter(Boolean).length / passes.length,
  }
}

// Abramowitz & Stegun 7.1.26 erf 近似（误差 <1.5e-7）
const AS_P = 0.3275911
const AS_A = [0.254829592, -0.284496736, 1.421413741, -1.453152027, 1.061405429]
function erf(x: number): number {
  const sign = x < 0 ? -1 : 1
  x = Math.abs(x)
  const t = 1 / (1 + AS_P * x)
  const y = 1 - ((((AS_A[4] * t + AS_A[3]) * t + AS_A[2]) * t + AS_A[1]) * t + AS_A[0]) * t * Math.exp(-x * x)
  return sign * y
}
/** 卡方(1 自由度) 生存函数 = 1 - erf(sqrt(chi/2))；chi=0 → 1（无差异） */
function chi2Survival1(chi: number): number {
  return chi <= 0 ? 1 : Math.max(0, 1 - erf(Math.sqrt(chi / 2)))
}
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

/**
 * 同 seed 配对 McNemar（每 task 同 seed 5 对（无 15 对合并检验——P10 声明核查修正）；n 小功效有限只当参考）
 * review 修正：brief 原式 `1 - 0.5*(chi/3.841)` 在 chi=3（b=3,c=0）得 p≈0.61，
 * 与其测试断言 p<0.1 及注释"3.841→p<0.05"自相矛盾。改用卡方(1)生存函数（erf 近似）：
 * chi=3 → p≈0.083（满足测试），chi=3.841 → p≈0.050（对齐注释）。
 */
export function pairedMcNemar(offRes: boolean[], onRes: boolean[]): { b: number; c: number; pValue: number; pExact: number } {
  if (offRes.length !== onRes.length) console.warn(`[stats] pairedMcNemar 长度不等: off=${offRes.length} on=${onRes.length}（配对错位风险）`)
  let b = 0, c = 0
  for (let i = 0; i < Math.min(offRes.length, onRes.length); i++) {
    if (offRes[i] && !onRes[i]) b++
    if (!offRes[i] && onRes[i]) c++
  }
  const chi = b + c === 0 ? 0 : ((b - c) ** 2) / (b + c)
  return { b, c, pValue: chi2Survival1(chi), pExact: mcnemarExact(b, c) }
}

/** seed noise = 同格内 pass 的方差占比（Spec §4.4：ClawBench 47% 警示） */
export function seedNoise(metrics: RunMetrics[]): { cell: string; passes: boolean[]; variance: number }[] {
  const cells = new Map<string, boolean[]>()
  for (const m of metrics) {
    const k = `${m.config}-${m.taskId}`
    if (!cells.has(k)) cells.set(k, [])
    cells.get(k)!.push(m.pass)
  }
  return Array.from(cells.entries()).map(([cell, passes]) => {
    const p = passes.filter(Boolean).length / passes.length
    return { cell, passes, variance: p * (1 - p) } // 伯努利方差
  })
}
