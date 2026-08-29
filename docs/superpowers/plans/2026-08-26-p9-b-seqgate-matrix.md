# P9-乙 序列闸门矩阵 Implementation Plan

> **状态（2026-08-30）**：T1-T4 已完成并通过 SDD 逐任务评审 + opus 终审 Approve（commits 38d99ed/1eec643/0b72cf7/9a37bd8/db73c72）；T5 Gate 冒烟首跑暴露 ISSUE-013（继承 provider env 泄漏→CLI 401），已修复（ba07df6）并复跑通过（4/5 pass、gate 4/5、健康阴性）。**T5 全矩阵 45-run 已完成（2026-08-30）**：首发射暴露计划接线缺口（T3 保留 5 配置数组、T5 未指定三臂选择器→无参跑成 75 格；中途止，加 `P9_ARMS=1` 门控修复 455591a，中断批 24 行弃用留 metrics.p9b-aborted-21.bak.jsonl）；重跑 45/45、三臂污染判阴、trace 中毒 0。**结果：seqgate 增量在 C（捷径）显著 p≈0.046（0/5→4/5），A 方向正不显著（2/5→4/5 p=0.317），B 天花板；H1✅ H2✅(仅C传导) H3原句"不影响C"被否、v3.1 修正版证实**。报告 results/report-p9b-strong.md。**T6 弱模型 pilot 已探带（2026-08-30）＝负结果**：讯飞 xophunyuan7bmt 无权限 403；本地 Qwen1.5-0.5B（5/5 defect trans=0）与 1.8B（3/3 defect，短 prompt 合规但 CLI 数十 KB prompt 下注意力崩坏）均 out-of-band——**本地小模型过不动生产 CLI 通道，弱模型维度转 P10**（详见 PROGRESS 2026-08-30 T6 行）。乙阶段到此收官，待推送（33 commit）。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现第三臂 `on-seqgate+verify`（idle 过早 done 闸门），扩展 harness 到三臂矩阵，跑强模型（deepseek@xfyun）45 run；弱模型 pilot 探带后铺第二矩阵。

**Architecture:** 生产侧一个 env 门控纯函数（`idlePrematureDoneGate`）+ chat-router 决策点一行接线（canonicalCorrect 之后、与 idleExecuteGate 同层）；harness 侧 config/run-one/metrics/report/GATE 五点扩三臂。生产默认行为（env 未设）字节级不变。

**Tech Stack:** TypeScript + vitest；无新依赖。

**上游 spec:** `docs/superpowers/specs/2026-08-23-p9-surface-matrix-design.md`（v3.1 §4.2/§4.3 + §8 F1-F8 条款）

## Global Constraints

- **src/lib 改动边界**：仅两处 env 门控分支——① state-machine.ts 新增纯函数+开关读取函数；② chat-router.ts 决策点守卫带内新增一个 if 块。env 未设时生产行为必须与 HEAD 字节级一致（有对照测试）
- **EXPERIMENT_SEQGATE 严格相等语义**（F4-Medium 核心）：只认 `process.env.EXPERIMENT_SEQGATE === 'on'`，禁止真值判断
- **RunEnvSnapshot/saveRunEnv/restoreRunEnv 扩三变量**（F4 必办②）：含 EXPERIMENT_SEQGATE 的保存/恢复/delete 语义，配 T9 同款回归测试
- **防呆断言**（F4 必办③）：测试断言「EXPERIMENT_SEQGATE 未设时 on-seqgate+verify 与 on+verify 行为路径相同」+「设 '1'/'true' 等残留值不激活」（严格相等语义验证）
- **守卫带插入位置**（F6）：chat-router.ts:98 canonicalCorrect 之后、与 idleExecuteGate（:106-114）同层的 if 块内；redirect 目标必须在当前态 TRANSITIONS 表内（实现内 assert）
- **模型 ID 白名单**（F2）：候选模型 ID 过 `^[A-Za-z0-9._\/:-]+$` 校验后才进 spawn 参数（process-registry.ts:358 默认 shell:true）
- **CLAUDE_CONFIG_DIR 下沉为 harness 断言**（F3）：setupExperiment preflight 显式校验已设置且指向实验专属目录，未设置直接 throw 拒跑
- **gateInterventionCount?: number** optional 字段（JSONL 兼容旧行）；seqgate 触发计数用结构化信号采集（corrections 数组 from:'done' to:'align_decompose' 且 inputState.state==='idle'），不用 reason 子串（F7 同源）
- **每批跑完自动过 detectBatchContamination 验伪**（analyze-cross-batch.ts 已导出）；teardown work/<runId>（afterAll rmSync force）
- **新测试文件同步扩 experiments/p5/vitest.config.ts include**（P9-丙实测坑）
- 注释中文；commit 一律 `--no-verify`
- **F1 时序前置**：接任何新 provider 前，先轮换存量两把 key（讯飞+OpenRouter）——用户操作，非本计划任务，但弱模型阶段硬性前置

## File Structure

| 文件 | 职责 |
|---|---|
| `src/lib/orchestrator/state-machine.ts` | 新增 `isSeqgateOn()` 开关读取 + `idlePrematureDoneGate(state, action, taskCount)` 纯函数 |
| `src/lib/services/chat-router.ts` | 决策点守卫带内新增 seqgate if 块（~6 行） |
| `tests/state-machine.test.ts` | 纯函数单测 + env 语义测试 + 生产行为不变对照 |
| `tests/chat-router.test.ts` | 决策点集成测试（gate 触发 redirect / 不触发放行 / OFF 不触发） |
| `experiments/p5/config.ts` | configs 加 `on-seqgate+verify`；envForConfig 第三开关透传 |
| `experiments/p5/run-one.ts` | RunEnvSnapshot 三变量；runOne 透传第三开关 |
| `experiments/p5/metrics.ts` | gateInterventionCount optional 字段 + 结构化采集 |
| `experiments/p5/report.ts` | 三臂分组（startsWith 兼容自动生效，补显式对照段） |
| `experiments/p5/run.test.ts` | GATE 扩展 + 三臂矩阵循环 |
| `experiments/p5/vitest.config.ts` | 仅当新增独立测试文件时扩 include |

---

### Task 1: 生产纯函数 + 开关（state-machine.ts）

**Files:**
- Modify: `src/lib/orchestrator/state-machine.ts`
- Test: `tests/state-machine.test.ts`

**Interfaces:**
- Produces:

```ts
/** P9-乙 seqgate 开关：严格相等语义（F4），'1'/'true'/残留值一律不激活 */
export function isSeqgateOn(): boolean {
  return process.env.EXPERIMENT_SEQGATE === 'on'
}

/**
 * P9-乙 idle 过早 done 闸门（spec v3.1 靶点）：idle 态提议 done 且零任务 → 序列不完整，
 * redirect 补走拆解。判定信号 = taskCount（代码查库，非 LLM 自证，沿 §10.2 精神）。
 * - taskCount=0：形式路径从未开始 → 拦（redirect align_decompose）
 * - taskCount>0：已有任务背书，done 合法性交还既有转移表（idle+done 容错边保留，本闸门不管）
 * 非 idle 态 / 非 done action 一律放行（返回 false）。
 */
export function idlePrematureDoneGate(state: State, action: string, taskCount: number): boolean
// 返回 true = 拦截（调用方 redirect align_decompose）；false = 放行
```

- [ ] **Step 1: 写失败测试**

```ts
// tests/state-machine.test.ts 追加 describe
import { isSeqgateOn, idlePrematureDoneGate } from '@/lib/orchestrator/state-machine'

describe('P9-乙 idlePrematureDoneGate', () => {
  afterEach(() => { delete process.env.EXPERIMENT_SEQGATE })

  it('idle+done+零任务 → 拦截', () => {
    expect(idlePrematureDoneGate('idle', 'done', 0)).toBe(true)
  })
  it('idle+done+有任务 → 放行（合法性交还转移表）', () => {
    expect(idlePrematureDoneGate('idle', 'done', 2)).toBe(false)
  })
  it('非 idle 态的 done → 放行', () => {
    expect(idlePrematureDoneGate('exec', 'done', 0)).toBe(false)
    expect(idlePrematureDoneGate('align_pm', 'done', 0)).toBe(false)
  })
  it('idle 态非 done action → 放行', () => {
    expect(idlePrematureDoneGate('idle', 'execute', 0)).toBe(false)
    expect(idlePrematureDoneGate('idle', 'self', 0)).toBe(false)
  })
})

describe('P9-乙 EXPERIMENT_SEQGATE 严格相等语义（F4）', () => {
  afterEach(() => { delete process.env.EXPERIMENT_SEQGATE })
  it("仅 'on' 激活", () => {
    process.env.EXPERIMENT_SEQGATE = 'on'
    expect(isSeqgateOn()).toBe(true)
  })
  it("真值字符串 '1'/'true'/'ON'/空串 均不激活（防残留值 fail-unsafe）", () => {
    for (const v of ['1', 'true', 'ON', '']) {
      process.env.EXPERIMENT_SEQGATE = v
      expect(isSeqgateOn()).toBe(false)
    }
  })
  it('未设 → 不激活（生产行为不变）', () => {
    delete process.env.EXPERIMENT_SEQGATE
    expect(isSeqgateOn()).toBe(false)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/state-machine.test.ts`
Expected: FAIL（导出不存在）

- [ ] **Step 3: 最小实现**

state-machine.ts 在 idleExecuteGate 之后追加：

```ts
/** P9-乙 seqgate 开关：严格相等语义（spec F4），'1'/'true'/残留值一律不激活 */
export function isSeqgateOn(): boolean {
  return process.env.EXPERIMENT_SEQGATE === 'on'
}

/**
 * P9-乙 idle 过早 done 闸门（spec v3.1 靶点裁定）：66/77 缺边会话 = bypass 循环后
 * 从 idle 直接 done 收尾（taskCount 全 0）。判定信号 taskCount 由代码查库，不可 LLM 自证。
 * 拦截返回 true（调用方 redirect align_decompose，表内合法目标）；false = 放行。
 */
export function idlePrematureDoneGate(state: State, action: string, taskCount: number): boolean {
  return state === 'idle' && action === 'done' && taskCount === 0
}
```

- [ ] **Step 4: 跑测试通过 + 生产行为不变确认**

Run: `npx vitest run tests/state-machine.test.ts tests/chat-router.test.ts`
Expected: 新测试 PASS，既有测试全绿（env 未设零影响）

- [ ] **Step 5: Commit**

```bash
git add src/lib/orchestrator/state-machine.ts tests/state-machine.test.ts
git commit --no-verify -m "feat(state-machine): P9-乙 seqgate 纯函数+严格相等开关"
```

---

### Task 2: chat-router 决策点接线（守卫带同层插入）

**Files:**
- Modify: `src/lib/services/chat-router.ts`
- Test: `tests/chat-router.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `isSeqgateOn` / `idlePrematureDoneGate`
- 插入位置（F6）：现有 `if (!experimentOff) { ... }` 守卫带内、done 业务守卫（:118）之前、idleExecuteGate 块（:106-114）之后同层——canonicalCorrect 之后保证 redirect 链顺序可预测，与 execute 闸门对称

- [ ] **Step 1: 写失败测试**

```ts
// tests/chat-router.test.ts 追加
describe('P9-乙 seqgate 决策点接线', () => {
  // 复用文件内既有 mock session/prisma 设施；三个核心 case：
  it('SEQGATE=on + idle + done + 零任务 → corrections 记 done→align_decompose，action 变 align_decompose', async () => {
    process.env.EXPERIMENT_SEQGATE = 'on'
    // …mock：session phase=idile/phaseStep=''，Task.count=0，LLM 提议 done
    // 断言：traceEntry.corrections 含 {from:'done',to:'align_decompose'}；
    //       actualTransition.action==='align_decompose'
  })
  it('SEQGATE=on + idle + done + 有任务 → 不拦（放行走 done handler）', async () => {
    process.env.EXPERIMENT_SEQGATE = 'on'
    // mock Task.count=1 → corrections 为空，action 保持 done
  })
  it('SEQGATE 未设 + 同输入 → 行为与 HEAD 完全一致（生产行为不变对照）', async () => {
    delete process.env.EXPERIMENT_SEQGATE
    // 同上 mock（零任务+done 提议）→ corrections 为空，action 保持 done（现状：idle+done 表内容错边直通）
    // 【审查 C 建议】加 spy 断言 prisma.task.count 未被调用——「零额外 DB 查询」用测试钉死而非只靠短路结构
  })
  it("SEQGATE='1'（残留值形态）→ 不激活", async () => {
    process.env.EXPERIMENT_SEQGATE = '1'
    // 同 case 1 输入 → 不拦
  })
  // 每个 case 后 cleanup：delete process.env.EXPERIMENT_SEQGATE
})
```

> 实现者注意：mock 设施照抄文件内既有 describe 的模式；上面伪码给的是断言要点，不是可运行代码。

- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 实现（chat-router.ts 守卫带内，idleExecuteGate 块之后）**

```ts
    // P9-乙 序列闸门（spec v3.1）：idle 态过早 done 且零任务 → redirect 补走拆解。
    // 插入约束（F6）：canonicalCorrect 之后、与 idleExecuteGate 同层；OFF 大开关下整块跳过。
    // 【审查 A 必补】redirect 目标表内断言（F6 条款落地，防未来 TRANSITIONS 改动后静默落 escalate）：
    if (isSeqgateOn() && decision.action === 'done' && state === 'idle') {
      const taskCount = await prisma.task.count({ where: { sessionId } })
      if (idlePrematureDoneGate(state, decision.action, taskCount)) {
        // F6 断言：目标必须在当前态 TRANSITIONS 表内（表外落 escalate 属 fail-closed 但污染实验）
        console.assert(applyTransition('idle', 'align_decompose').ok, 'seqgate redirect 目标必须表内合法')
        const reason = `序列闸门：会话尚无任务，需先对齐拆解（当前 ${taskCount} 任务）`
        corrections.push({ from: 'done', to: 'align_decompose', reason })
        decision = { ...decision, action: 'align_decompose', reason }
      }
    }
```

import 行补 `isSeqgateOn, idlePrematureDoneGate` 及 `applyTransition`。测试同步钉死：`expect(applyTransition('idle','align_decompose')).toMatchObject({ok:true})`。

- [ ] **Step 4: 跑全部生产测试**

Run: `npx vitest run tests/state-machine.test.ts tests/chat-router.test.ts`
Expected: 新 case 全绿 + 既有全绿（env 未设对照 case 是关键防线）

- [ ] **Step 5: Commit**

```bash
git add src/lib/services/chat-router.ts tests/chat-router.test.ts
git commit --no-verify -m "feat(chat-router): P9-乙 seqgate 守卫带接线（idle过早done拦截）"
```

---

### Task 3: harness 三臂扩展（config/run-one/metrics/report）

**Files:**
- Modify: `experiments/p5/config.ts`, `run-one.ts`, `metrics.ts`, `report.ts`
- Test: `experiments/p5/run.test.ts`

**Interfaces:**

config.ts:
```ts
export const envForConfig = (config: string) => ({
  EXPERIMENT_STATE_MACHINE: config.startsWith('off') ? 'off' : undefined,
  EXPERIMENT_VERIFY: config.includes('no-verify') ? 'off' : undefined,
  EXPERIMENT_SEQGATE: config.startsWith('on-seqgate') ? 'on' : undefined,  // F4：严格值透传
})
// CONFIG.configs 加 'on-seqgate+verify'（保 startsWith 前缀约定：
// metrics.ts:110/125、report.ts:113 的 startsWith('off')/startsWith('on')
// 对 'on-seqgate+verify' 天然落 ON 口径——这正是命名设计意图，需测试钉死）
```

run-one.ts:
```ts
export interface RunEnvSnapshot {
  EXPERIMENT_STATE_MACHINE: string | undefined
  EXPERIMENT_VERIFY: string | undefined
  EXPERIMENT_SEQGATE: string | undefined   // F4 必办②：三变量
}
// saveRunEnv 读三个键；restoreRunEnv 三键同款 undefined→delete 语义
// 【审查 D 强建议，采纳】三键透传抽成可测纯函数，封堵第四种静默退化路径
// （envForConfig 正确产出但 runOne 忘写透传行 → 单测全绿、真实 run 静默跑成 ON 臂）：
export function applyRunEnv(env: ReturnType<typeof envForConfig>): void {
  // 三键各按 set/delete 处理；runOne 调它替代现有 ：47-50 内联硬编码两键
}
```

metrics.ts:
```ts
export interface RunMetrics {
  ...
  gateInterventionCount?: number   // P9-乙：seqgate 触发数（optional 保 JSONL 兼容）
}
// collectMetrics 内结构化采集（F7 同源原则，不用 reason 子串）：
const gateInterventionCount = entries.filter(e =>
  e.decisionPoint === 'handleOrchestratorDecision' &&
  e.inputState?.state === 'idle' &&
  Array.isArray(e.corrections) &&
  e.corrections.some((c: any) => c.from === 'done' && c.to === 'align_decompose')
).length
// 仅 on-seqgate 前缀配置写入该字段（其余臂字段缺省——区分「没开」和「开了没触发」）
if (config.startsWith('on-seqgate')) row.gateInterventionCount = gateInterventionCount
// 签名唯一性（审查 G 已核对）：(idle, done→align_decompose) 在现有 corrections.push 点中
// 唯一命中 seqgate——execute 闸门是 execute→align_decompose（from 不同），规则1 是 align_pm 态（state 不同）。
// report 合计行消费 optional 字段须 ?? 0 合并旧行；丙的 classifyCorrections 分类学将出现第四类，
// 跨批分析遇乙批数据时的归桶口径在报告注明。
```

report.ts:
- 逐格 pass 数组循环天然吃第 5 个 config（bySeed 按 config 精确匹配）
- 状态机主效应段加第三组：`on-seqgate+verify vs off+verify`（OFF vs ON-seqgate 配对）
- 新增小节「seqgate 臂增量（ON vs ON-seqgate）」：pairedMcNemar(onArr, onSeqgateArr) per task + gateInterventionCount 合计行

- [ ] **Step 1: 写失败测试（run.test.ts 追加，不新建文件——免 vitest include 扩展）**

```ts
describe('P9-乙 T3: 三臂配置矩阵', () => {
  it('CONFIG.configs 含 on-seqgate+verify 且 envForConfig 三开关映射正确', () => {
    expect(CONFIG.configs).toContain('on-seqgate+verify')
    const env = CONFIG.envForConfig('on-seqgate+verify')
    expect(env.EXPERIMENT_SEQGATE).toBe('on')
    expect(env.EXPERIMENT_STATE_MACHINE).toBeUndefined()   // ON 臂语义
    expect(env.EXPERIMENT_VERIFY).toBeUndefined()
    // 前缀约定钉死：既有消费点对新配置名落正确口径
    expect('on-seqgate+verify'.startsWith('on')).toBe(true)   // ON 口径（corr 列）
    expect('on-seqgate+verify'.startsWith('off')).toBe(false) // 不落 OFF 口径
  })
  it('RunEnvSnapshot 三变量 save/restore 往返（T9 同款，F4 必办②）', () => {
    process.env.EXPERIMENT_STATE_MACHINE = 'keep-sm'
    process.env.EXPERIMENT_VERIFY = 'keep-v'
    process.env.EXPERIMENT_SEQGATE = 'keep-sg'
    const prev = saveRunEnv()
    expect(prev.EXPERIMENT_SEQGATE).toBe('keep-sg')
    process.env.EXPERIMENT_SEQGATE = 'changed'
    restoreRunEnv(prev)
    expect(process.env.EXPERIMENT_SEQGATE).toBe('keep-sg')
    // undefined→delete 语义
    delete process.env.EXPERIMENT_SEQGATE
    const prev2 = saveRunEnv()
    restoreRunEnv(prev2)
    expect(process.env.EXPERIMENT_SEQGATE).toBeUndefined()
    // cleanup
    process.env.EXPERIMENT_STATE_MACHINE = 'keep-sm'; process.env.EXPERIMENT_VERIFY = 'keep-v'
  })
  it('applyRunEnv 三键透传（审查 D：封堵 runOne 忘写透传行的第四种静默退化）', () => {
    applyRunEnv({ EXPERIMENT_STATE_MACHINE: undefined, EXPERIMENT_VERIFY: undefined, EXPERIMENT_SEQGATE: 'on' })
    expect(process.env.EXPERIMENT_SEQGATE).toBe('on')
    expect(process.env.EXPERIMENT_STATE_MACHINE).toBeUndefined()
    applyRunEnv({ EXPERIMENT_STATE_MACHINE: 'off', EXPERIMENT_VERIFY: undefined, EXPERIMENT_SEQGATE: undefined })
    expect(process.env.EXPERIMENT_STATE_MACHINE).toBe('off')
    expect(process.env.EXPERIMENT_SEQGATE).toBeUndefined()   // delete 语义
    // cleanup 两键
    delete process.env.EXPERIMENT_STATE_MACHINE; delete process.env.EXPERIMENT_SEQGATE
  })
  it('configs 数组遍历式断言（审查 D 升级：防拼写漂移脱钩）', () => {
    const seqgateConfigs = CONFIG.configs.filter(c => c.startsWith('on-seqgate'))
    expect(seqgateConfigs).toHaveLength(1)
    expect(CONFIG.envForConfig(seqgateConfigs[0]).EXPERIMENT_SEQGATE).toBe('on')
  })
  it('collectMetrics 采 gateInterventionCount（结构化信号，非 reason 子串）', async () => {
    // 构造 trace entries：idle 态决策点 corrections=[{from:'done',to:'align_decompose'}]
    // config='on-seqgate+verify' → gateInterventionCount===1
    // config='on+verify' 同 trace → 字段 undefined（臂间区分「没开」vs「开了」）
  })
  it('防呆断言（F4 核心）：SEQGATE 未设时 on-seqgate 臂不得静默等同 on 臂', () => {
    // envForConfig('on-seqgate+verify') 必须产出 EXPERIMENT_SEQGATE='on'
    // 若此断言失败 = 配置名拼错/漏改 envForConfig → seqgate 臂静默退化（fail-unsafe 场景）
    expect(CONFIG.envForConfig('on-seqgate+verify').EXPERIMENT_SEQGATE).toBe('on')
    expect(CONFIG.envForConfig('on+verify').EXPERIMENT_SEQGATE).toBeUndefined()
  })
})
```

- [ ] **Step 2: 实现 config/run-one/metrics/report 四文件改动**

- [ ] **Step 3: 跑 harness 测试**

Run: `npx vitest run experiments/p5/run.test.ts`
Expected: 新 describe 绿 + P6 T8/T9 既有断言绿（configs 数组精确断言那两条需同步更新为 5 配置——搜索 `toEqual(['on+verify'` 定位）

- [ ] **Step 4: Commit**

```bash
git add experiments/p5/config.ts experiments/p5/run-one.ts experiments/p5/metrics.ts experiments/p5/report.ts experiments/p5/run.test.ts
git commit --no-verify -m "feat(p5): P9-乙 T3 三臂harness扩展(config/run-one/metrics/report)"
```

---

### Task 4: 运行纪律硬化（CLAUDE_CONFIG_DIR 断言 + work teardown + 白名单）

**Files:**
- Modify: `experiments/p5/setup.ts`（或 run.test.ts beforeAll）、`experiments/p5/process-launch 相关文件`（白名单校验点按实际 spawn 路径定位）
- Test: `experiments/p5/run.test.ts`

**背景**：P8 实证 CLI 子进程继承用户默认 CLAUDE_CONFIG_DIR 会启动挂死；当时靠手动设 env 绕过。本次下沉为代码强制（F3）。模型 ID 真实流向（审查 E 已核实）：`GLM_MODEL → CONFIG.model → setup.ts ensureExperimentAgents upsert 进 Agent 表 → run-one 从 DB 读 agents → adapter → process-registry spawn --model`（spawn 点 process-registry.ts:347-359 默认 shell:true）——畸形 ID 即注入面（F2）。**生产 spawn 面是存量暴露，非本次引入；按「src/lib 仅两处改动」边界不修，作为显式遗留项记入乙报告。**

- [ ] **Step 1: 写失败测试**

```ts
describe('P9-乙 T4: 运行纪律硬化', () => {
  it('preflight 断言 CLAUDE_CONFIG_DIR 白名单包含判定（F3，审查 F 必修版）', () => {
    // 实现 = resolve 后必须等于或位于 experiments/p5 之内（白名单前缀，非子串猜测）
    expect(() => assertCliConfigDir(undefined)).toThrow()
    expect(() => assertCliConfigDir('C:\\Users\\18387\\.claude')).toThrow()      // 用户默认（反斜杠）
    expect(() => assertCliConfigDir('C:/Users/18387/.claude')).toThrow()        // 用户默认（正斜杠——原方案 fail-open 实锤反例）
    expect(() => assertCliConfigDir('~/.claude')).toThrow()                     // 家目录形态
    expect(() => assertCliConfigDir('C:\\Users\\p5fan\\.claude')).toThrow()     // 用户名恰含 p5 的击穿反例
    expect(() => assertCliConfigDir('D:\\ai全栈挑战赛\\agenthub\\experiments\\p5\\.claude-cfg')).not.toThrow()
    expect(() => assertCliConfigDir('D:/ai全栈挑战赛/agenthub/experiments/p5/.claude-cfg')).not.toThrow()
  })
  it('候选模型 ID 白名单校验（F2）', () => {
    expect(isValidModelId('xopdeepseekv4flash0731')).toBe(true)
    expect(isValidModelId('stealth/ox-alpha')).toBe(true)
    expect(isValidModelId('deepseek-v4-flash')).toBe(true)
    for (const bad of ['a;rm -rf', 'x"&&calc', 'a b', '中文模型', 'id\ninjection', '%PATH%', 'a^b', 'x|y', '`id`'])
      expect(isValidModelId(bad)).toBe(false)
  })
})
```

- [ ] **Step 2: 实现**

```ts
// 纯函数放 setup.ts：
export function isValidModelId(id: string): boolean {
  return /^[A-Za-z0-9._\/:-]+$/.test(id)   // cmd.exe 元字符集 &|^<>()%!" 空格 反引号 $ CR LF \ 全排除（审查 E 核对）
}
// 【审查 F 必修】白名单包含判定：resolve 统一斜杠 + experiments/p5 前缀检查。
// 原子串猜测方案（includes('\\.claude') && !includes('p5')）对正斜杠形态 fail-open，
// 且 p5 子串可被用户名击穿/误伤合法目录——已废弃。
import { resolve, sep } from 'node:path'
const ALLOW_PREFIX = resolve(import.meta.dirname)   // experiments/p5
export function assertCliConfigDir(dir: string | undefined): void {
  const d = dir ? resolve(dir) : ''
  if (!d || !(d === ALLOW_PREFIX || d.startsWith(ALLOW_PREFIX + sep))) {
    throw new Error('[preflight] CLAUDE_CONFIG_DIR 未隔离——CLI 子进程将继承用户默认目录导致挂死（P8 实证）。请设为实验专属目录（experiments/p5 之下）。')
  }
}
```

接线点（审查 E 修正后）：
1. `assertCliConfigDir(process.env.CLAUDE_CONFIG_DIR)` 进 setupExperiment preflight（throw 拒跑）
2. `isValidModelId(CONFIG.model)` 在 ensureExperimentAgents upsert 前（setup.ts:48 附近）校验，不过即 throw 拒跑——这是模型 ID 真实流向的入口闸门。~~若 harness 不经该路径则放 envForConfig 消费侧~~（错误兜底已删：envForConfig 是配置名→实验开关映射，模型 ID 不经过它）
3. 生产 spawn 面（process-registry）校验为遗留项，写入乙报告

- [ ] **Step 3: work/<runId> teardown**

run.test.ts afterAll 补：
```ts
afterAll(async () => {
  // P9-乙：teardown 本批 mkdtemp 目录（存量 398 泄漏另列一次性清理，不在此处）
  for (const d of createdWorkDirs) rmSync(d, { recursive: true, force: true })
})
```
（首选：runOne 注册其 mkdtempSync 返回的精确路径到模块级数组，afterAll 逐个删——无通配、审查 H 放行。若侵入面大退而按 runId 前缀 glob 清理，**强制护栏（审查 H）：rmSync 前断言 `resolve(候选路径)` 以 `resolve(CONFIG.workDir)` 为前缀，glob 前缀禁止空/过短**；统一用 node:fs API 不走 shell）

- [ ] **Step 4: 跑测试 + Commit**

```bash
npx vitest run experiments/p5/run.test.ts
git add -A experiments/p5/
git commit --no-verify -m "feat(p5): P9-乙 T4 运行纪律硬化(CONFIG_DIR断言+模型ID白名单+work teardown)"
```

---

### Task 5: 强模型 45-run（deepseek@xfyun）+ Gate 早停

**前置硬性检查（人工）：**
- [ ] `.env.local` 里 GLM_MODEL=xopdeepseekv4flash0731、GLM_BASE_URL=讯飞 anthropic 端点、GLM_API_KEY 有效（P8 同款）
- [ ] 独立 CLAUDE_CONFIG_DIR 目录存在

**执行配方（沿 P7/P8 成熟姿势）：**

- [ ] **Gate 冒烟先跑**：`P7_GATE=1`（Task 3 已扩为 on-seqgate 单格过滤——实现时把 P7_GATE 的 config 从 'off+verify' 换 'on-seqgate+verify'，taskId 'A' 不变）×5

```powershell
# PowerShell Start-Process 脱离 shell（后台长跑惯例）
Start-Process cmd '/c chcp 65001 && set P7_GATE=1&& set GLM_API_KEY=<key>&& npx vitest run experiments/p5/run.test.ts > results\p9b-gate.log 2>&1'
```

- [ ] **读 Gate 结果**：on-seqgate-A ×5。判据：① 无 defect 灌满（健康）；② gateInterventionCount>0 出现（闸门活着）；③ skip 形态可见。任一异常停，排查后再铺
- [ ] **备份 metrics.jsonl → metrics.p9b-strong-gate.bak.jsonl**
- [ ] **全矩阵 45 run**（三臂 × A/B/C × s0-s4）：

```powershell
Start-Process cmd '/c chcp 65001 && set GLM_API_KEY=<key>&& npx vitest run experiments/p5/run.test.ts > results\p9b-strong.log 2>&1'
```

- [ ] **监控**：metrics.jsonl 行数增长 + Session.updatedAt（分类器抖动期 Bash 可能被挡，用只读 ls/wc 重试穿透）
- [ ] **跑完验收**：45 行齐 + detectBatchContamination 断阴（写一次性 tsx 脚本调 analyze-cross-batch 导出）+ 报告生成
- [ ] **Commit**（metrics/report gitignored，commit 只含可能的 harness 微修）

---

### Task 6: 弱模型 pilot 探带 + 第二矩阵（条件任务）

**⚠️ 前置硬性动作（F1）：轮换讯飞+OpenRouter 两把 key（用户操作）后才接任何新 provider。**

- [ ] **列候选**：`GET $BASE/v1/models`（讯飞 MaaS）拿可用模型清单；剔除已知地板（挂死型）/天花板（deepseek 级）；优先选小参数 instruct 类
- [ ] **单格探带**：候选 × off+verify × A ×5（诊断格标准沿 spec §4.3：pass 1-4/5 中间带 + skip/ill 形态出现）
- [ ] **探带通过** → 该模型重跑三臂 45 run（同 Task 5 配方，key 换新 provider 凭据，模型 ID 过白名单）
- [ ] **探带全灭**（候选全地板/天花板）→ 停在强模型矩阵，报告声明弱模型维度缺失原因，H1/H2/H3 按可得数据裁决
- [ ] 每批 metrics 备份 + 污染检测 + teardown 照 Task 5

---

## Self-Review 记录

1. **Spec 覆盖**：§4.2 语义契约（T1/T2 靶点实现）、F4 三件套+审查 D 第四路径（T1 严格相等 + T3 三变量快照/applyRunEnv/遍历断言 + T3 防呆）、F6 插入位置+表内断言（T2）、F2/F3 审查修正版（T4 白名单包含判定 + upsert 前校验）、F7 结构化采集（T3 metrics）、F1 时序（T6 前置）、§4.3 Gate 早停（T5）、§5-5 teardown 带 H 护栏（T4）。✅
2. **安全审查落点**（2026-08-26 Security Engineer APPROVE_WITH_MINOR_CHANGES）：必修 2 条已并入——[F] assertCliConfigDir 重写白名单包含判定（正斜杠 fail-open 修掉）；[E] 删 envForConfig 错误兜底、接线点改 ensureExperimentAgents upsert 前。强建议 5 条全部采纳（applyRunEnv 抽取 / 表内 assert / teardown 护栏 / spy 断言提示 / ?? 0 合并与第四类归桶注记）。生产 spawn 面（process-registry）存量暴露作为遗留项写入乙报告。
3. **占位符**：T2 Step 1 测试是伪码骨架（mock 设施依赖文件内既有模式，实现者照抄现成 describe）；均已显式声明而非隐藏。
4. **类型一致性**：RunEnvSnapshot 三变量 / gateInterventionCount optional / configs 第 5 元素跨任务签名一致。
