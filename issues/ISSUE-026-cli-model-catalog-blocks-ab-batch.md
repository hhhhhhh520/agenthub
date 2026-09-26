# CLI model catalog 拒绝未知模型名 → A/B 批跑 40 runs 全空转 + preflight 闸门被穿透
> 创建时间: 2026-09-26 | 状态: 🟢 已解决（线路切换跑通 + 闸门加固落地；后续项见文末）

## 问题描述

2026-09-26 首次 P11 monitor A/B 批跑（MONITOR_AB=1，tokenrhythm 线路 qwen3.8-flash）40 runs 全部
`pass:false / failKind:defect / totalTransitions:0 / rounds≈6 / monitorCycles:0`，3 分钟内"跑完"。
报告全零——不是实验结论，是整批空转。

## 出现原因（根因链，均有 transcript/DB 证据）

1. **Claude Code CLI 新版 model catalog 强制校验**：`--model qwen3.8-flash` 被本地拒绝
   （`[claude-code:unrecognized_model]` + "There's an issue with the selected model"），
   **请求从未发出**。assistant 消息 `model=<synthetic>`（CLI 合成错误，非任何 LLM）。
   9/2-9/4 P10 批跑通过是因当时 CLI 版本旧、无此校验——环境漂移型故障。
2. **CLI 错误文本被当 result**（P10 F3 已知缺陷的变体）：错误文本不含
   `detectPreflightError` 黑名单任何签名（401/403/api error/unable to connect…）→
   **preflight 误判 provider 就绪**，三道闸门放行整批（preflight-last.json 照常落盘）。
3. 决策层 `parseJSON` throw（错误文本无 JSON）→ chat-router 决策失败降级 self →
   mock 罐头"我已处理，结果如下。"落库 6 轮 → phase 恒 idle → no-progress break。
4. 第二堵独立墙：即使 CLI 放行，**tokenrhythm 对 ANTHROPIC 协议 400**
   （"当前模型不支持该协议：anthropic"，qwen3.8-flash 仅 OpenAI 协议）——
   catalog 认识的模型名实测撞墙证实。

## 解决方案

- **线路**：火山方舟 Ark plan（`https://ark.cn-beijing.volces.com/api/plan` + `ark-code-latest`，
  用户 2026-09-26 提供）——CLI 对该 provider id 仅警告不拒跑，ANTHROPIC 协议原生兼容
  （`volces.com` 本在 p5 端点白名单内；CLI transcript 实证真 LLM 响应，网关侧映射 glm-5-3-flash-260901）。
  第二批 40/40 有效跑完（109min LLM 延迟），报告落档 `results/report.monitor-2026-09-26.md`。
- **无效数据隔离**：`metrics.monitor-invalid-20260926-cli-model-reject.jsonl.bak` +
  `monitor-batch-last.invalid-20260926.json.bak`（效度口径"跨批比较按批次切分"的实例）。
- **闸门加固（已落地，TDD 先红 + 变异 3 组精确红 + 双审查 Agent 拍板）**：
  1. `detectPreflightError`（setup.ts）黑名单补 CLI 三签名：`unrecognized_model` /
     `issue with the selected model` / `model catalog`（第三条为工单原稿全句的稳定子串超集）。
  2. preflightDecision 相关性检查（黑名单之外的兜底层）：回复必须**精确为**「就绪」（`result.trim() !== '就绪'` throw）。
     双审查从不同角度拍板 exact-match 而非 `includes('就绪')`——堵「服务未就绪」子串洞与 CLI 回显 sentinel prompt 的
     假绿洞；「就绪。」「好的就绪」润饰变体被拒属预期（指令不遵从正是 preflight 要拦的）。失效方向=响亮拒批（带 reply 回显）。
  3. sentinel prompt 处加同源注释（prompt 与检查词耦合，三处拷贝一处改全改）。

## 教训（追加）

- **批跑（后台 vitest）运行期间禁编辑 include 集合内文件**：vitest fork 按需加载，尾部测试文件会读到
  编辑/变异中间态（本批 setup.test.ts 尾 fork 撞加固变异窗口红 2 例；run.test 主体 16:14 fork 时数据效度不受影响，
  但纯属侥幸——正确做法是批跑期间冻结装置文件或把 commit 排到批跑后）。

## 后续项

- [ ] 决策 LLM 行为方差（D 罐头两臂 pass 0/5 定性：跳过对齐直接 delegate/self 空转）——罐头剧本补引导或 prompt 强化，需单独拍板
- [ ] 若需显著性：runsPerCell 5→10 加 seed 重跑（装置现成，成本 ×2）
- [ ] run-gate-smoke.ps1 的 mtime 门诚实局限（preflight-last.json 被测试进程刷新 mtime）维持已声明口径

## 相关文件

- `experiments/p5/setup.ts:113-116`（detectPreflightError 黑名单）
- `experiments/p5/run-one.ts:117-162`（no-progress 循环——空转的直接形态）
- `experiments/p5/run.test.ts:84-95`（mock 放行真实 CLI 的 preflight/决策/监控三处）
- `src/lib/adapter/process-registry.ts:311-318`（--model 透传，剥 [1m] 后缀）
- `.claude-cfg/projects/*/…jsonl`（model=<synthetic> transcript = 直接证据）

## 参考资料

- 火山方舟 Claude Code 接入（Ark plan ANTHROPIC 协议网关）
- CLI 报错自述：catalog 未知模型可经 modelOverrides/behavesAs 映射放行（本次未用——换线路更快）
