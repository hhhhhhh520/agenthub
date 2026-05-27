# 回归 Bug 修复 + 乱码检测
> 创建时间: 2026-05-26 | 状态: 🟢已解决

## 问题描述

上一轮 12+2 项修复后，3 个新问题出现：
1. 聊天返回 `[Agent 未返回有效内容]` — callLLM/callLLMForAnalysis 不累加 error chunks
2. 中文会话名乱码无检测 — GBK 误编 UTF-8 的请求直接入库
3. runDiscussion 遗漏 BUG-1 修复 — 累加 status chunk

## 出现原因

1. **callLLM 空响应**: `callLLM`/`callLLMForAnalysis` 只累加 `type === 'text'` chunks。LLM API 失败时 adapter yield `{ type: 'error', content: '...' }`，被忽略 → result 为空 → Q3 空响应检查触发 `[Agent 未返回有效内容]`
2. **乱码无防御**: Windows curl 默认 GBK 编码，服务端无检测直接存入 DB
3. **runDiscussion 遗漏**: BUG-1 修复给 executeSingleAgent/executeTaskBatch 加了 chunk type 过滤，但漏了 runDiscussion

## 解决方案

1. `callLLM`/`callLLMForAnalysis` 改为 `if (chunk.type === 'text' || chunk.type === 'error') result += chunk.content`
2. `POST /api/sessions` 加 `hasLoneSurrogates()` 检测，区分成对代理对（合法 emoji）和孤立代理（乱码），返回 400
3. `runDiscussion` 加相同的 chunk type 过滤

## 相关文件

- `src/lib/orchestrator/index.ts` — chunk 累加修复（3 处）
- `src/app/api/sessions/route.ts` — 乱码检测
- `tests/orchestrator-chunk-accumulation.test.ts` — 新增测试（5 个）
- `tests/garbled-text-detection.test.ts` — 新增测试（6 个）
