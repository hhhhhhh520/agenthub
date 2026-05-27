# AgentHub QA Report - 2026-05-26 (Round 2)

**Tester**: Claude QA (Browser + API testing)
**Date**: 2026-05-26
**Duration**: ~20 minutes
**URL**: http://localhost:3000
**Framework**: Next.js 16 (App Router) + Prisma 7 + SQLite
**Pages visited**: Homepage, session creation, group chat, agent panel, import providers
**Test method**: Browser-based (gstack browse) + API-level curl

---

## Summary

| Category | Score |
|----------|-------|
| Console | 100 (no JS errors detected) |
| Links | 90 (SPA, nav works via clicks) |
| Visual | 65 (session name truncation, garbled text in sidebar) |
| Functional | 45 (chat returns empty responses, sessions with garbled names) |
| UX | 55 (create session flow works, but chat is broken, no onboarding) |
| Performance | 85 (API responses fast, SSE streaming works) |
| Content | 50 (title still "Create Next App", description placeholder) |
| Accessibility | 70 (buttons have aria-labels, but missing page title) |
| **Overall** | **58/100** |

Score went DOWN from 65 to 58. The alignment flow redesign (using `executeSingleAgent`) works in the code but the LLM backend returns empty content, making chat useless.

---

## Issues Found

### ISSUE-R2-001: Chat returns "[Agent 未返回有效内容]" for ALL messages
**Severity**: HIGH
**Category**: Functional
**Evidence**: Both single and group session chats return `{"type":"text","content":"[Agent 未返回有效内容]"}` via SSE. The UI shows "O Orchestrator [Agent 未返回有效内容]" after every message. This is the same root cause as the original ISSUE-005: the orchestrator tries to call `executeSingleAgent` with the Agent's platform config, but when platform is "claude-code" and there's no CLI available, it falls back to LLM API which also fails or returns nothing usable.
**Repro steps**:
1. Create any session (single or group)
2. Send any message
3. SSE stream shows `[Agent 未返回有效内容]`
4. UI displays the empty placeholder text

---

### ISSUE-R2-002: Page title still "Create Next App"
**Severity**: MEDIUM
**Category**: Content
**Evidence**: `<title>Create Next App</title>` unchanged from original report (ISSUE-003).
**Repro steps**: `curl -s http://localhost:3000/ | grep "<title>"`
**Status**: NOT FIXED since Round 1

---

### ISSUE-R2-003: Session names garbled (encoding issue)
**Severity**: HIGH
**Category**: Functional + Visual
**Evidence**: Creating sessions with Chinese names via API produces garbled titles like `鏂颁細璇\udc9d` instead of readable Chinese. Example: `POST /api/sessions` with `name:"QA测试单聊"` returns `title:"鏂颁細璇\udc9d"`. This appears to be a UTF-8 encoding problem in the API request handling. Sessions created via the UI get the auto-generated name "新会话" which works fine, but any Chinese characters passed via curl get corrupted.
**Repro steps**:
1. `curl -s -X POST /api/sessions -H "Content-Type: application/json" -d '{"name":"测试会话"}'`
2. Response shows garbled title

---

### ISSUE-R2-004: tools/capabilities still returned as JSON strings, not arrays
**Severity**: MEDIUM
**Category**: Functional
**Evidence**: Same as original ISSUE-004. `GET /api/agents` returns `tools: "[]"` and `capabilities: "[\"UI设计\",\"交互设计\",\"设计系统\"]"` as string type, not array type. Frontend must parse these strings.
**Status**: NOT FIXED since Round 1

---

### ISSUE-R2-005: Messages API returns 200 for nonexistent session
**Severity**: LOW
**Category**: Functional
**Evidence**: Same as original ISSUE-006. `GET /api/sessions/nonexistent/messages` returns HTTP 200 with `[]`.
**Status**: NOT FIXED since Round 1

---

### ISSUE-R2-006: Members API returns 200 for nonexistent session
**Severity**: LOW
**Category**: Functional
**Evidence**: `GET /api/sessions/nonexistent/members` returns HTTP 200 with `[]`. Inconsistent with chat API which returns 404.
**Status**: NEW (not in Round 1)

---

### ISSUE-R2-007: Deploy API returns 500 (was stub returning fake URL)
**Severity**: MEDIUM
**Category**: Functional
**Evidence**: `POST /api/deploy` now returns HTTP 500 (not the fake URL from Round 1's ISSUE-008). The stub may have been broken during refactoring.
**Status**: REGRESSION from Round 1 (was 200 with fake URL, now 500)

---

### ISSUE-R2-008: recommend-agents always recommends all agents
**Severity**: MEDIUM
**Category**: Functional
**Evidence**: Same as original ISSUE-009. The LLM analysis for recommend-agents fails (no API key configured), fallback returns all 6 preset agent IDs.
**Status**: NOT FIXED since Round 1

---

### ISSUE-R2-009: Agent status always "idle" despite code having working/idle updates
**Severity**: LOW
**Category**: Functional
**Evidence**: Same as original ISSUE-010. The `executeSingleAgent` code updates status to "working" and back to "idle", but since agents never actually work (empty responses), the status always remains "idle". This is a consequence of ISSUE-R2-001.
**Status**: Partially fixed (code exists, but no working sessions trigger it)

---

### ISSUE-R2-010: XSS agent name stored in database
**Severity**: MEDIUM (Security)
**Category**: Functional
**Evidence**: Same as original ISSUE-011. Agent with name `<script>alert(1)</script>` still exists in the database. No sanitization on agent creation.
**Status**: NOT FIXED since Round 1. Test agent still present.

---

### ISSUE-R2-011: apiKey exposed in GET /api/agents
**Severity**: HIGH (Security)
**Category**: Functional
**Evidence**: While ISSUE-002 (recommend-agents) was FIXED, the main `GET /api/agents` endpoint still returns `systemPrompt` for all agents. The API shows full systemPrompt text for preset agents. While apiKey is excluded, systemPrompt leaking means anyone can read the internal prompt instructions.
**Note**: apiKey is NOT returned by GET /api/agents (verified: field absent). ISSUE-002 fix is confirmed working for recommend-agents. But systemPrompt is still exposed in GET /api/agents AND in session members API.

---

### ISSUE-R2-012: Session sidebar shows truncated names with no tooltip
**Severity**: LOW
**Category**: UX
**Evidence**: The session sidebar truncates names to "QA Test Group Sessio..." but doesn't provide a tooltip or any way to see the full name. This is a UX issue for long session names.

---

### ISSUE-R2-013: No onboarding or welcome content in empty state
**Severity**: LOW
**Category**: UX
**Evidence**: Same as original ISSUE-012. The center area shows "选择或创建一个会话" static text with no explanation of what AgentHub does.
**Status**: NOT FIXED since Round 1

---

### ISSUE-R2-014: Chat history truncation (take: 20)
**Severity**: MEDIUM
**Category**: Functional
**Evidence**: Same as original ISSUE-013. Chat route uses `take: 20` for message history.
**Status**: NOT FIXED since Round 1

---

### ISSUE-R2-015: apiKey stored in plaintext (no encryption)
**Severity**: HIGH (Security)
**Category**: Functional
**Evidence**: Same as original ISSUE-014. API keys stored as plain text in SQLite.
**Status**: NOT FIXED since Round 1

---

## Verified Fixes from Round 1

| Issue | Status |
|-------|--------|
| ISSUE-001 (message duplication) | FIXED. `result` event in claude-code-adapter now emits `type: 'status'` only. Accumulation logic uses `chunk.type === 'text' || chunk.type === 'error'` |
| ISSUE-002 (apiKey in recommend-agents) | FIXED. `select` clause excludes apiKey and systemPrompt from response |
| Q2 (result event duplication) | FIXED. Verified in adapter code |
| Q3 (empty response guard) | FIXED. EMPTY_RESPONSE constant and guard logic in place |

## New Regressions

| Issue | Description |
|-------|-------------|
| ISSUE-R2-007 | Deploy API changed from 200+fake URL to 500 error |

---

## Top 3 Things to Fix

1. **ISSUE-R2-001 (HIGH)**: Fix the empty orchestrator/agent response. Chat is the core feature and it returns "[Agent 未返回有效内容]" for every message. The LLM fallback must work or produce clear error messages.

2. **ISSUE-R2-003 (HIGH)**: Fix UTF-8 encoding in session name handling. Chinese characters get garbled when passed through the API.

3. **ISSUE-R2-002 (MEDIUM)**: Change page title from "Create Next App" to "AgentHub". Quick fix, high impact on brand identity.

---

## Console Health

No JavaScript errors detected during browser testing.

---

## Baseline Data

```json
{
  "date": "2026-05-26",
  "url": "http://localhost:3000",
  "healthScore": 58,
  "issues": [
    {"id": "ISSUE-R2-001", "title": "Chat returns empty agent response", "severity": "high", "category": "functional"},
    {"id": "ISSUE-R2-002", "title": "Page title Create Next App", "severity": "medium", "category": "content"},
    {"id": "ISSUE-R2-003", "title": "Session names garbled encoding", "severity": "high", "category": "functional"},
    {"id": "ISSUE-R2-004", "title": "tools/capabilities as JSON strings", "severity": "medium", "category": "functional"},
    {"id": "ISSUE-R2-005", "title": "Messages 200 for nonexistent session", "severity": "low", "category": "functional"},
    {"id": "ISSUE-R2-006", "title": "Members 200 for nonexistent session", "severity": "low", "category": "functional"},
    {"id": "ISSUE-R2-007", "title": "Deploy API 500 regression", "severity": "medium", "category": "functional"},
    {"id": "ISSUE-R2-008", "title": "Recommend-agents always all agents", "severity": "medium", "category": "functional"},
    {"id": "ISSUE-R2-009", "title": "Agent status always idle", "severity": "low", "category": "functional"},
    {"id": "ISSUE-R2-010", "title": "XSS agent name in database", "severity": "medium", "category": "security"},
    {"id": "ISSUE-R2-011", "title": "systemPrompt exposed in agents API", "severity": "high", "category": "security"},
    {"id": "ISSUE-R2-012", "title": "Session name truncation no tooltip", "severity": "low", "category": "ux"},
    {"id": "ISSUE-R2-013", "title": "No onboarding guidance", "severity": "low", "category": "ux"},
    {"id": "ISSUE-R2-014", "title": "Chat history truncation take:20", "severity": "medium", "category": "functional"},
    {"id": "ISSUE-R2-015", "title": "apiKey plaintext storage", "severity": "high", "category": "security"}
  ],
  "categoryScores": {
    "console": 100,
    "links": 90,
    "visual": 65,
    "functional": 45,
    "ux": 55,
    "performance": 85,
    "content": 50,
    "accessibility": 70
  }
}
```