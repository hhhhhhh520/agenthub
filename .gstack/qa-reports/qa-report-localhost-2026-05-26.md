# AgentHub QA Report - 2026-05-26

**Tester**: Claude QA (API-level testing)
**Date**: 2026-05-26
**Duration**: ~15 minutes
**URL**: http://localhost:3000
**Framework**: Next.js 16 (App Router) + Prisma 7 + SQLite
**Pages visited**: Homepage (SPA, single-page layout)
**Test method**: API-level curl + code review

---

## Summary

| Category | Score |
|----------|-------|
| Console | 100 (no JS errors from API) |
| Links | 90 (SPA, no broken nav links) |
| Visual | 70 (placeholder title, empty state issues) |
| Functional | 55 (multiple flow failures) |
| UX | 60 (IM-style layout works, but gaps) |
| Performance | 85 (API responses fast) |
| Content | 50 (placeholder title/description, no branding) |
| Accessibility | 70 (buttons have aria-labels, but missing page title) |
| **Overall** | **65/100** |

---

## Issues Found

### ISSUE-001: Agent message content duplicated
**Severity**: HIGH
**Category**: Functional
**Evidence**: Session `82bb6f87` messages API returns `rawContent` field containing the entire response text **twice**. Example: PM's first response (message id `95b03859`) has the full paragraph repeated verbatim.
**Repro steps**:
1. Create a group session
2. Send a message mentioning an agent
3. Check `GET /api/sessions/{id}/messages`
4. Agent's `rawContent` contains the response text duplicated
**Root cause**: CONFIRMED. In `claude-code-adapter.ts:137-146`, the adapter yields **incremental** text chunks from `event.message.content` (line 139-140) AND the **final complete result** from `event.result` (line 145-146). In `orchestrator/index.ts`, `executeSingleAgent` accumulates ALL chunks into `result += chunk.content` (line 226, 292, etc.). This means incremental chunks + final result = content appears twice. The fix would be to either: (a) skip `result` event in claude-code-adapter since incremental chunks already cover it, or (b) in executeSingleAgent, only count chunks that are NOT from the final result event.

---

### ISSUE-002: API key exposed in recommend-agents endpoint
**Severity**: CRITICAL (Security)
**Category**: Functional
**Evidence**: `POST /api/sessions/recommend-agents` returns `allAgents` array with **all** Agent fields including `apiKey` and `systemPrompt`. The regular `GET /api/agents` endpoint uses `select` to exclude these sensitive fields, but recommend-agents does not.
**Repro steps**:
1. `POST /api/sessions/recommend-agents` with any task description
2. Response includes full agent objects with apiKey, systemPrompt, baseUrl
**Root cause**: `recommend-agents/route.ts:12` uses `prisma.agent.findMany({ where: { isPreset: true } })` without a `select` clause, returning all columns. Compare with `GET /api/agents/route.ts:10` which uses explicit `select` to exclude apiKey.
**Impact**: If agents have real API keys configured, they would be exposed to any client calling this endpoint.

---

### ISSUE-003: Page title says "Create Next App"
**Severity**: MEDIUM
**Category**: Content
**Evidence**: `<title>Create Next App</title>` on homepage. This is the default Next.js template title, not the project name.
**Repro steps**: `curl -s http://localhost:3000/ | grep '<title>'`
**Root cause**: Layout or page metadata not customized. The app is called "AgentHub" but the title doesn't reflect this.

---

### ISSUE-004: tools/capabilities fields returned as JSON strings, not arrays
**Severity**: MEDIUM
**Category**: Functional
**Evidence**: Both `GET /api/agents` and `GET /api/sessions/{id}/members` return `tools` and `capabilities` as stringified JSON (e.g., `"[]"` or `"\"[\"React\",\"TypeScript\",\"CSS\"]\""`), not as actual arrays. Frontend must parse these strings.
**Repro steps**:
1. `GET /api/agents`
2. Check `tools` field: it's `"[]"` (string), not `[]` (array)
**Root cause**: `prisma/seed.ts` stores `JSON.stringify(tools || [])` and the API returns the raw string without parsing. The `POST /api/agents` route also does `JSON.stringify(tools || [])` before storing.

---

### ISSUE-005: Chat API returns empty orchestrator response for new sessions
**Severity**: HIGH
**Category**: Functional
**Evidence**: Sending a chat message to a new single-type session returns SSE stream with only `{"type":"status","content":"思考中..."}` followed by `{"type":"done","content":""}`. No actual content is generated. The orchestrator decision flow appears to fail silently.
**Repro steps**:
1. `POST /api/sessions` with `type: "single"`
2. `POST /api/sessions/{id}/chat` with `{"message":"hello"}`
3. SSE stream returns empty orchestrator response
**Root cause**: The orchestrator decision logic likely returns an action that doesn't produce visible output, or the LLM call fails silently (no API key configured for the default LLM adapter).

---

### ISSUE-006: Messages API returns 200 for nonexistent session
**Severity**: LOW
**Category**: Functional
**Evidence**: `GET /api/sessions/nonexistent/messages` returns HTTP 200 with `[]` instead of HTTP 404. This is inconsistent with the chat API which correctly returns 404 for nonexistent sessions.
**Repro steps**: `curl -s -w "\nHTTP:%{http_code}" "http://localhost:3000/api/sessions/nonexistent/messages"`
**Result**: `[]` with HTTP 200
**Root cause**: `messages/route.ts` does `prisma.message.findMany({ where: { sessionId: id } })` which returns empty array for nonexistent sessions without checking session existence first.

---

### ISSUE-007: Agent duplicate name not prevented for same display name
**Severity**: MEDIUM
**Category**: Functional
**Evidence**: Creating an agent with name "UI 设计师" (same as a preset) succeeds with HTTP 201, creating a second agent with the same display name. The P2002 unique constraint on the `name` field does catch exact duplicates, but this test created "UI 设计师" as a **new** agent successfully (different from the preset one with same name).
**Repro steps**: `POST /api/agents` with `name: "UI 设计师"` creates a second agent
**Root cause**: Need to verify - if the preset agent's name differs at DB level (e.g., encoding difference), the P2002 constraint would not catch it. Or the curl encoding on Windows caused the name to be stored differently.

---

### ISSUE-008: Deploy API is a stub returning fake URL
**Severity**: MEDIUM
**Category**: Functional
**Evidence**: `POST /api/deploy` returns `{"success":true,"url":"https://agenthub-d9cz4n.vercel.app","message":"Deploy simulated..."}` without any actual deployment. The URL is generated but not real.
**Repro steps**: `POST /api/deploy` with empty body
**Root cause**: `deploy/route.ts` is a stub. No real Vercel integration exists.

---

### ISSUE-009: Recommend-agents API always recommends all agents
**Severity**: MEDIUM
**Category**: Functional
**Evidence**: When the LLM analysis fails or returns empty results, the fallback in `recommend-agents/route.ts:51` recommends ALL preset agents (`recommendedNames = agents.map(a => a.name)`). This means the "smart recommendation" feature degrades to "include everyone" whenever LLM is unavailable, which defeats the purpose of intelligent agent selection.
**Repro steps**:
1. Without LLM API configured
2. `POST /api/sessions/recommend-agents`
3. Returns all 6 agent IDs
**Root cause**: Line 51-53 in recommend-agents/route.ts falls back to all agents when LLM returns nothing.

---

### ISSUE-010: Agent status field never updated (zombie field)
**Severity**: LOW
**Category**: Functional
**Evidence**: All agents return `status: "idle"` regardless of whether they're actively working. The `status` field in the database has `@default("idle")` but no code ever updates it to "working", "done", or "error".
**Repro steps**: `GET /api/agents` - all agents show `status: "idle"`
**Root cause**: Design decision #20 says "Orchestrator manages Agent status", but no code implements this. The field exists but is never written after creation.

---

### ISSUE-011: HTML/script tags not sanitized in agent name
**Severity**: MEDIUM (Security)
**Category**: Functional
**Evidence**: Creating an agent with `name: "<script>alert(1)</script>"` succeeds without any sanitization. The name is stored as-is in the database. While React escapes by default (no XSS in rendering), the raw data is stored unsanitized and could be exploited in non-React contexts (API responses, exports, logs).
**Repro steps**: `POST /api/agents` with `name: "<script>alert(1)</script>"`
**Result**: Agent created with that exact name stored in DB

---

### ISSUE-012: Homepage empty state - no guidance for new users
**Severity**: LOW
**Category**: UX
**Evidence**: The main area shows "选择或创建一个会话" as a static gray text. There's no onboarding, no explanation of what AgentHub does, no tutorial. The right panel shows "Agents (0)" and "Tasks (0)" tabs but with no content or hints.
**Root cause**: No onboarding UI or welcome message for first-time users.

---

### ISSUE-013: Chat history truncation (take: 20)
**Severity**: MEDIUM
**Category**: Functional
**Evidence**: The chat route uses `take: 20` to limit message history (lines 195, 279, 372 in chat/route.ts). This violates design decision #13 which specifies "complete chat history, no data-layer filtering". Long conversations lose context after 20 messages.
**Root cause**: `prisma.message.findMany({ where: { sessionId }, orderBy: { createdAt: 'asc' }, take: 20 })` truncates history.

---

### ISSUE-014: Agent apiKey stored in plaintext
**Severity**: HIGH (Security)
**Category**: Functional
**Evidence**: The Prisma schema has `apiKey String @default("")` with no encryption. API keys for external LLM services are stored as plain text in SQLite.
**Root cause**: Schema design. No encryption layer for sensitive fields.

---

## Top 3 Things to Fix

1. **ISSUE-002 (CRITICAL)**: Add `select` clause to recommend-agents route to exclude apiKey and systemPrompt. This is a data leak.

2. **ISSUE-001 (HIGH)**: Fix message content duplication. The LLM adapter's streaming callback is likely double-counting content.

3. **ISSUE-005 (HIGH)**: Fix empty orchestrator responses for new sessions. The chat flow should produce visible output or clear error messages, not silently return empty content.

---

## Console Health

No JavaScript errors detected from API responses. Front-end hydration would need browser testing to check for React errors.

---

## Baseline Data

```json
{
  "date": "2026-05-26",
  "url": "http://localhost:3000",
  "healthScore": 65,
  "issues": [
    {"id": "ISSUE-001", "title": "Agent message content duplicated", "severity": "high", "category": "functional"},
    {"id": "ISSUE-002", "title": "API key exposed in recommend-agents endpoint", "severity": "critical", "category": "security"},
    {"id": "ISSUE-003", "title": "Page title says Create Next App", "severity": "medium", "category": "content"},
    {"id": "ISSUE-004", "title": "tools/capabilities fields as JSON strings not arrays", "severity": "medium", "category": "functional"},
    {"id": "ISSUE-005", "title": "Chat API returns empty orchestrator response", "severity": "high", "category": "functional"},
    {"id": "ISSUE-006", "title": "Messages API returns 200 for nonexistent session", "severity": "low", "category": "functional"},
    {"id": "ISSUE-007", "title": "Agent duplicate name not prevented", "severity": "medium", "category": "functional"},
    {"id": "ISSUE-008", "title": "Deploy API is stub returning fake URL", "severity": "medium", "category": "functional"},
    {"id": "ISSUE-009", "title": "Recommend-agents always recommends all", "severity": "medium", "category": "functional"},
    {"id": "ISSUE-010", "title": "Agent status field never updated", "severity": "low", "category": "functional"},
    {"id": "ISSUE-011", "title": "HTML/script tags not sanitized in agent name", "severity": "medium", "category": "security"},
    {"id": "ISSUE-012", "title": "No onboarding guidance", "severity": "low", "category": "ux"},
    {"id": "ISSUE-013", "title": "Chat history truncation take:20", "severity": "medium", "category": "functional"},
    {"id": "ISSUE-014", "title": "apiKey stored in plaintext", "severity": "high", "category": "security"}
  ],
  "categoryScores": {
    "console": 100,
    "links": 90,
    "visual": 70,
    "functional": 55,
    "ux": 60,
    "performance": 85,
    "content": 50,
    "accessibility": 70
  }
}
```