# AgentHub QA Report - 2026-05-26 (Round 3)

**Tester**: Claude QA (Browser + API testing)
**Date**: 2026-05-26
**Duration**: ~15 minutes
**URL**: http://localhost:3000
**Framework**: Next.js 16 (App Router) + Prisma 7 + SQLite
**Pages visited**: Homepage, session list, group chat, agent panel, create session
**Test method**: Browser-based (browse) + API-level curl
**Previous round score**: 58/100

---

## Summary

| Category | Score | Delta |
|----------|-------|-------|
| Console | 100 | 0 |
| Links | 90 | 0 |
| Visual | 70 | +5 |
| Functional | 50 | +5 |
| UX | 55 | 0 |
| Performance | 85 | 0 |
| Content | 50 | 0 |
| Accessibility | 70 | 0 |
| **Overall** | **62/100** | **+4** |

Score improved from 58 to 62. Three fixes applied since Round 2:
1. `callLLM`/`callLLMForAnalysis` now accumulate error chunks (Bug 1)
2. `hasLoneSurrogates()` rejects GBK-encoded titles with 400 (Bug 2)
3. `runDiscussion` now filters chunk types (Bug 3)

These fixes are **correctly implemented and verified** in code. The remaining score drag is from unfixed issues and the fundamental limitation that no LLM API key is configured.

---

## Issues Found

### ISSUE-R3-001: Chat returns "[Agent 未返回有效内容]" (ROOT CAUSE: No API key configured)
**Severity**: HIGH
**Category**: Functional
**Evidence**: Same symptom as R2-001, but the underlying cause is now clear. The Bug 1 fix correctly accumulates error chunks in `callLLM`/`callLLMForAnalysis`. However, the error message (e.g. "AuthenticationError: invalid x-api-key") is not valid JSON, so `parseJSON` throws, the orchestrator falls back to `executeSingleAgent`, which also fails, and the result is `EMPTY_RESPONSE`. The error chunk fix works at the adapter layer but the orchestrator's JSON parsing and fallback chain still produces the same user-visible symptom.
**Root cause chain**: No API key → LLM adapter yields error chunk → `callLLM` accumulates error text → `parseJSON` fails on non-JSON error → orchestrator fallback → `executeSingleAgent` with same config → same failure → `EMPTY_RESPONSE`
**Repro steps**:
1. Create any session
2. Send any message
3. SSE returns `[Agent 未返回有效内容]`
**Change from R2**: Bug 1 fix is working (error chunks are now accumulated), but the deeper architectural issue (JSON parse failure on error messages + fallback to same broken config) still produces the same symptom. The fix is necessary but not sufficient without an API key or better error propagation.
**Recommendation**: Either (a) configure an API key, or (b) add error propagation in the orchestrator that surfaces the actual error message to the user instead of swallowing it in `parseJSON`.

---

### ISSUE-R3-002: Page title still "Create Next App"
**Severity**: MEDIUM
**Category**: Content
**Evidence**: `<title>Create Next App</title>` unchanged since Round 1.
**Status**: NOT FIXED since Round 1

---

### ISSUE-R3-003: tools/capabilities still returned as JSON strings, not arrays
**Severity**: MEDIUM
**Category**: Functional
**Evidence**: `GET /api/agents` returns `tools: "[]"` (string) and `capabilities: "[\"UI设计\",\"交互设计\",\"设计系统\"]"` (string). Frontend must `JSON.parse()` these fields.
**Status**: NOT FIXED since Round 1

---

### ISSUE-R3-004: Messages API returns 200 for nonexistent session
**Severity**: LOW
**Category**: Functional
**Evidence**: `GET /api/sessions/nonexistent/messages` returns HTTP 200 with `[]`.
**Status**: NOT FIXED since Round 1

---

### ISSUE-R3-005: Members API returns 200 for nonexistent session
**Severity**: LOW
**Category**: Functional
**Evidence**: `GET /api/sessions/nonexistent/members` returns HTTP 200 with `[]`.
**Status**: NOT FIXED since Round 1

---

### ISSUE-R3-006: Deploy API returns 500
**Severity**: MEDIUM
**Category**: Functional
**Evidence**: `POST /api/deploy` returns HTTP 500. Was a stub returning a fake URL in Round 1, now broken.
**Status**: NOT FIXED since Round 2 (regression)

---

### ISSUE-R3-007: recommend-agents always recommends all agents
**Severity**: MEDIUM
**Category**: Functional
**Evidence**: LLM analysis for recommend-agents fails (no API key), fallback returns all 6 preset agent IDs.
**Status**: NOT FIXED since Round 1

---

### ISSUE-R3-008: Agent status always "idle"
**Severity**: LOW
**Category**: Functional
**Evidence**: The `executeSingleAgent` code correctly updates status to "working" and back to "idle", but since agents never actually complete work (empty responses), the status always remains "idle". Consequence of R3-001.
**Status**: NOT FIXED since Round 1

---

### ISSUE-R3-009: XSS agent name stored in database
**Severity**: MEDIUM (Security)
**Category**: Functional
**Evidence**: Agent with name `<script>alert(1)</script>` from Round 1 testing was deleted, but the API still accepts unsanitized HTML in agent names. New test with `<img src=x onerror=alert(2)>` was successfully created. No sanitization on agent creation.
**Status**: NOT FIXED since Round 1

---

### ISSUE-R3-010: systemPrompt exposed in GET /api/agents and session agents API
**Severity**: HIGH (Security)
**Category**: Functional
**Evidence**: `GET /api/agents` returns full `systemPrompt` text for all agents. `GET /api/sessions/{id}/agents` also returns `systemPrompt`. While apiKey is excluded from `GET /api/agents`, systemPrompt leaking reveals internal prompt instructions.
**Status**: NOT FIXED since Round 2

---

### ISSUE-R3-011: Session sidebar truncates names with no tooltip
**Severity**: LOW
**Category**: UX
**Evidence**: Long session names truncated to "QA Round3 Test Ses..." with no tooltip.
**Status**: NOT FIXED since Round 2

---

### ISSUE-R3-012: No onboarding or welcome content in empty state
**Severity**: LOW
**Category**: UX
**Evidence**: Center area shows "选择或创建一个会话" static text. No explanation of what AgentHub does.
**Status**: NOT FIXED since Round 1

---

### ISSUE-R3-013: Chat history truncation (take: 20)
**Severity**: MEDIUM
**Category**: Functional
**Evidence**: Chat route uses `take: 20` for message history. Sessions with more than 20 messages will lose older context.
**Status**: NOT FIXED since Round 1

---

### ISSUE-R3-014: apiKey stored in plaintext (no encryption)
**Severity**: HIGH (Security)
**Category**: Functional
**Evidence**: API keys stored as plain text in SQLite. No encryption/decryption layer found in source code.
**Status**: NOT FIXED since Round 1

---

### ISSUE-R3-015: Chinese session names work correctly via API with proper UTF-8
**Severity**: N/A (VERIFIED FIX)
**Category**: Functional
**Evidence**: Creating sessions with Chinese titles via `--data-raw` (proper UTF-8) produces correct titles: "QA第三轮中文测试". The `hasLoneSurrogates()` guard correctly rejects GBK-encoded requests with HTTP 400 and error message "标题包含无效编码，请使用 UTF-8 编码发送请求". This is a **verified fix** for R2-003.
**Status**: FIXED

---

## Verified Fixes from Round 2

| Issue | Status | Evidence |
|-------|--------|----------|
| BUG-1: `callLLM`/`callLLMForAnalysis` error chunk accumulation | FIXED | Verified all 6 `result += chunk.content` instances have `chunk.type === 'text' \|\| chunk.type === 'error'` filter (lines 23, 40, 207, 224, 296, 363 of orchestrator/index.ts) |
| BUG-2: GBK encoding garbling | FIXED | `hasLoneSurrogates()` in sessions/route.ts correctly rejects lone surrogates with 400. Chinese titles work when sent with proper UTF-8. |
| BUG-3: `runDiscussion` missing chunk filter | FIXED | Line 363 now has `if (chunk.type === 'text' \|\| chunk.type === 'error')` filter |
| R1-001: message duplication | STILL FIXED | `result` event emits `type: 'status'` only |
| R1-002: apiKey in recommend-agents | STILL FIXED | `select` clause excludes apiKey |
| R2-Q2: result event duplication | STILL FIXED | Verified in adapter code |
| R2-Q3: empty response guard | STILL FIXED | `EMPTY_RESPONSE` constant in place |

## Test Suite

- 160 tests pass, 0 fail
- 0 TypeScript errors
- All chunk accumulation points verified consistent

---

## Top 3 Things to Fix

1. **ISSUE-R3-001 (HIGH)**: The chat core is still broken for users. The Bug 1 fix is architecturally correct but insufficient without either (a) a working LLM API key, or (b) error message propagation that surfaces the actual failure reason to the user instead of the generic `[Agent 未返回有效内容]`. The orchestrator should detect when `parseJSON` fails on an error message and surface that error text directly to the SSE stream.

2. **ISSUE-R3-002 (MEDIUM)**: Page title "Create Next App". Quick fix, high brand impact. Change `layout.tsx` metadata.

3. **ISSUE-R3-010 (HIGH/Security)**: systemPrompt exposed in agents API and session agents API. Should be excluded from public-facing endpoints like apiKey was.

---

## Console Health

No JavaScript errors detected during browser testing.

---

## Baseline Data

```json
{
  "date": "2026-05-26",
  "url": "http://localhost:3000",
  "healthScore": 62,
  "previousScore": 58,
  "delta": "+4",
  "issues": [
    {"id": "ISSUE-R3-001", "title": "Chat returns empty agent response (no API key)", "severity": "high", "category": "functional"},
    {"id": "ISSUE-R3-002", "title": "Page title Create Next App", "severity": "medium", "category": "content"},
    {"id": "ISSUE-R3-003", "title": "tools/capabilities as JSON strings", "severity": "medium", "category": "functional"},
    {"id": "ISSUE-R3-004", "title": "Messages 200 for nonexistent session", "severity": "low", "category": "functional"},
    {"id": "ISSUE-R3-005", "title": "Members 200 for nonexistent session", "severity": "low", "category": "functional"},
    {"id": "ISSUE-R3-006", "title": "Deploy API 500 regression", "severity": "medium", "category": "functional"},
    {"id": "ISSUE-R3-007", "title": "Recommend-agents always all agents", "severity": "medium", "category": "functional"},
    {"id": "ISSUE-R3-008", "title": "Agent status always idle", "severity": "low", "category": "functional"},
    {"id": "ISSUE-R3-009", "title": "XSS agent name in database", "severity": "medium", "category": "security"},
    {"id": "ISSUE-R3-010", "title": "systemPrompt exposed in agents API", "severity": "high", "category": "security"},
    {"id": "ISSUE-R3-011", "title": "Session name truncation no tooltip", "severity": "low", "category": "ux"},
    {"id": "ISSUE-R3-012", "title": "No onboarding guidance", "severity": "low", "category": "ux"},
    {"id": "ISSUE-R3-013", "title": "Chat history truncation take:20", "severity": "medium", "category": "functional"},
    {"id": "ISSUE-R3-014", "title": "apiKey plaintext storage", "severity": "high", "category": "security"}
  ],
  "verifiedFixes": [
    "BUG-1: callLLM error chunk accumulation",
    "BUG-2: hasLoneSurrogates() encoding guard",
    "BUG-3: runDiscussion chunk type filter"
  ],
  "categoryScores": {
    "console": 100,
    "links": 90,
    "visual": 70,
    "functional": 50,
    "ux": 55,
    "performance": 85,
    "content": 50,
    "accessibility": 70
  }
}
```
