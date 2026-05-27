# QA Report: AgentHub
> Date: 2026-05-27 | Duration: ~25 min | Pages visited: 8 | Framework: Next.js 16

## Health Score: 72/100

| Category | Score | Weight | Weighted |
|----------|-------|--------|----------|
| Console | 100 | 15% | 15.0 |
| Links | 100 | 10% | 10.0 |
| Visual | 85 | 10% | 8.5 |
| Functional | 50 | 20% | 10.0 |
| UX | 65 | 15% | 9.75 |
| Performance | 90 | 10% | 9.0 |
| Content | 90 | 5% | 4.5 |
| Accessibility | 70 | 15% | 10.5 |
| **Total** | | | **77.25** |

## Summary

| Severity | Count |
|----------|-------|
| Critical | 0 |
| High | 3 |
| Medium | 3 |
| Low | 2 |

## Top 3 Things to Fix

1. **Agent count not updating after wizard** - Sidebar shows "Agents (0)" even after setup wizard creates 6 agents. API confirms agents exist but UI doesn't reflect this.
2. **Dashboard data mismatch** - Dashboard shows only 3 agents (Atlas, 测试工程师, 代码审查) while API returns 6 agents. Different data sources or filtering logic.
3. **Session deletion without confirmation** - Clicking delete button immediately removes the session with no confirmation dialog. Risk of accidental data loss.

---

## Issues

### ISSUE-001: Agent count not updating after wizard
**Severity:** High | **Category:** Functional
**Location:** Homepage sidebar
**Description:** After completing the setup wizard which creates 6 preset agents, the sidebar still shows "Agents (0)". The API endpoint `/api/agents` correctly returns 6 agents, but the UI doesn't update.
**Repro steps:**
1. Complete the setup wizard (检测平台配置 → 预设 Agent 平台设置 → 完成配置)
2. Observe sidebar shows "Agents (0)"
3. Call `/api/agents` API - returns 6 agents
**Expected:** Sidebar should show "Agents (6)" after wizard completion.

### ISSUE-002: Dashboard agents list doesn't match API
**Severity:** High | **Category:** Functional
**Location:** `/dashboard/agents`
**Description:** The agents dashboard page shows only 3 agents (Atlas, 测试工程师, 代码审查), but the API returns 6 agents including 架构师, 前端工程师, 后端工程师, 产品经理, UI 设计师. The dashboard appears to use a different data source or has filtering logic that excludes wizard-created agents.
**Repro steps:**
1. Navigate to `/dashboard/agents`
2. Observe only 3 agents listed
3. Call `/api/agents` API - returns 6 agents
**Expected:** Dashboard should show all agents from the API.

### ISSUE-003: Session deletion without confirmation
**Severity:** High | **Category:** UX
**Location:** Homepage sidebar
**Description:** Clicking the delete button (x) on a session immediately removes it without any confirmation dialog. This is a destructive action that could lead to accidental data loss.
**Repro steps:**
1. Create a session with messages
2. Click the "x" button on the session in the sidebar
3. Session is immediately deleted with no confirmation
**Expected:** A confirmation dialog should appear before deleting a session.

### ISSUE-004: Search doesn't filter agent list
**Severity:** Medium | **Category:** Functional
**Location:** `/dashboard/agents` search box
**Description:** Typing in the search box doesn't filter the agent list. All agents remain visible regardless of search input.
**Repro steps:**
1. Navigate to `/dashboard/agents`
2. Type "Atlas" in the search box
3. All 3 agents remain visible (should filter to just Atlas)
**Expected:** Search should filter agents by name or description.

### ISSUE-005: Dashboard "创建智能体" button doesn't work
**Severity:** Medium | **Category:** Functional
**Location:** `/dashboard/agents`
**Description:** The "创建智能体" (Create Agent) button on the dashboard agents page has no visible effect when clicked. No dialog opens, no navigation occurs.
**Repro steps:**
1. Navigate to `/dashboard/agents`
2. Click "创建智能体" button
3. Nothing happens
**Expected:** Should open an agent creation dialog or navigate to a creation form.

### ISSUE-006: Workspace shows wrong agent count
**Severity:** Medium | **Category:** Content
**Location:** `/dashboard` workspace page
**Description:** The workspace page shows "3 智能体" but the API returns 6 agents. This is inconsistent with the actual data.
**Repro steps:**
1. Navigate to `/dashboard`
2. Observe "3 智能体" stat card
3. Call `/api/agents` API - returns 6 agents
**Expected:** Should show accurate agent count from API.

### ISSUE-007: Orchestrator execution hangs
**Severity:** Low | **Category:** UX
**Location:** Homepage chat
**Description:** When the Orchestrator delegates to an agent (e.g., backend engineer), the execution can hang indefinitely. The "停止" (Stop) button works, but there's no timeout or progress indicator.
**Repro steps:**
1. Create a group chat
2. Send a task like "设计数据库结构"
3. Orchestrator delegates to backend engineer
4. Execution continues indefinitely without completion
**Expected:** Should have a timeout mechanism or clearer progress indicators.

### ISSUE-008: Mobile viewport sidebar overlap
**Severity:** Low | **Category:** Visual
**Location:** Homepage on mobile (375x812)
**Description:** On mobile viewport, the sidebar and main content area overlap slightly, making the UI feel cramped.
**Repro steps:**
1. Set viewport to 375x812
2. Observe sidebar and main content overlap
**Expected:** Better responsive layout for mobile viewports.

---

## Console Health Summary

**0 errors across all pages tested.** Console is clean.

## Pages Tested

| Page | Status | Notes |
|------|--------|-------|
| `/` (Homepage) | ✅ | Setup wizard, session creation, chat working |
| `/dashboard` (Workspace) | ✅ | Overview stats, recent sessions |
| `/dashboard/agents` | ⚠️ | Data mismatch with API, search broken |
| `/dashboard/agents/[id]` | ✅ | Agent detail page works well |
| `/dashboard/projects` | ✅ | Project list with status |
| `/dashboard/projects/[id]` | ✅ | Project detail with conversation history |
| `/dashboard/skills` | ✅ | Skill list with tools |
| `/dashboard/skills/[id]` | ✅ | Skill detail with prompt editing |

## Features Working Well

1. **Setup Wizard** - 3-step flow with CLI detection and connection test
2. **Group Chat Creation** - Agent recommendation based on task description
3. **@Agent Mention** - Routes messages to specific agents correctly
4. **Private Chat** - Creates 1:1 sessions with individual agents
5. **Agent Editing** - Full form with name, expertise, system prompt, platform, theme color
6. **Import Provider** - CC-Switch integration with multiple providers
7. **Project Detail** - Conversation history with code blocks and task progress
8. **Agent Detail** - Shows skills, recent activity, editable fields
9. **Skill Detail** - Tool management and prompt editing

## Test Environment

- **URL:** http://localhost:3000
- **Browser:** Chromium (via gstack browse)
- **OS:** Windows 11
- **Node.js:** Next.js 16.2.6 (Turbopack)
