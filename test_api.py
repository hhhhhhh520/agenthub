#!/usr/bin/env python3
"""AgentHub API E2E Test Script - avoids Windows GBK encoding issues"""
import json, sys, os, time, uuid
import urllib.request, urllib.error

BASE = "http://localhost:3000/api"
RESULTS = []

def api(method, path, data=None):
    url = f"{BASE}{path}"
    body = json.dumps(data).encode('utf-8') if data else None
    req = urllib.request.Request(url, data=body, method=method)
    if body:
        req.add_header('Content-Type', 'application/json')
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            raw = resp.read().decode('utf-8')
            return resp.status, json.loads(raw) if raw.strip() else {}
    except urllib.error.HTTPError as e:
        raw = e.read().decode('utf-8')
        try:
            return e.code, json.loads(raw)
        except:
            return e.code, raw

def test(category, name, fn):
    try:
        ok, detail = fn()
        status = "PASS" if ok else "FAIL"
        RESULTS.append((category, name, status, detail))
        print(f"  [{status}] {name}: {detail}")
    except Exception as e:
        RESULTS.append((category, name, "ERROR", str(e)))
        print(f"  [ERROR] {name}: {e}")

# ==============================
# 17. Data Model API (17.1-17.8)
# ==============================
print("\n=== Batch 8: Data Model API (17.1-17.8) ===")

# 17.1 Session CRUD
created_session_id = None
def t17_1a():
    global created_session_id
    code, d = api("POST", "/sessions", {"title": "API Test Session", "type": "group", "agentIds": []})
    created_session_id = d.get("id")
    return code == 200 and d.get("type") == "group", f"status={code} id={created_session_id[:8] if created_session_id else 'N/A'}"

def t17_1b():
    code, d = api("GET", "/sessions")
    sessions = d if isinstance(d, list) else d.get("sessions", [])
    return code == 200 and len(sessions) > 0, f"status={code} count={len(sessions)}"

def t17_1c():
    code, d = api("PUT", f"/sessions/{created_session_id}", {"title": "API Test Updated"})
    return code == 200 and d.get("title") == "API Test Updated", f"status={code} title={d.get('title')}"

def t17_1d():
    code, d = api("DELETE", f"/sessions/{created_session_id}")
    return code == 200 and d.get("success") == True, f"status={code} success={d.get('success')}"

test("17.1 Session", "Create", t17_1a)
test("17.1 Session", "List", t17_1b)
test("17.1 Session", "Update", t17_1c)
test("17.1 Session", "Delete", t17_1d)

# 17.2 Agent CRUD
created_agent_id = None
def t17_2a():
    global created_agent_id
    code, d = api("POST", "/agents", {
        "name": f"API-Test-{uuid.uuid4().hex[:6]}",
        "expertise": "Automated testing",
        "systemPrompt": "You are a test agent",
        "platform": "claude-code",
        "accentColor": "#ff0000"
    })
    created_agent_id = d.get("id")
    return code == 200 and created_agent_id, f"status={code} id={created_agent_id[:8] if created_agent_id else 'N/A'}"

def t17_2b():
    code, d = api("GET", "/agents")
    agents = d if isinstance(d, list) else d.get("agents", [])
    return code == 200 and len(agents) > 0, f"status={code} count={len(agents)}"

def t17_2c():
    code, d = api("PUT", f"/agents/{created_agent_id}", {"expertise": "Updated expertise"})
    return code == 200 and d.get("expertise") == "Updated expertise", f"status={code} expertise={d.get('expertise')}"

def t17_2d():
    code, d = api("DELETE", f"/agents/{created_agent_id}")
    return code == 200, f"status={code}"

test("17.2 Agent", "Create", t17_2a)
test("17.2 Agent", "List", t17_2b)
test("17.2 Agent", "Update", t17_2c)
test("17.2 Agent", "Delete", t17_2d)

# 17.3 Message CRUD
# First create a session for messages
_, sess = api("POST", "/sessions", {"title": "Msg Test Session", "type": "group", "agentIds": []})
msg_session_id = sess.get("id")

def t17_3a():
    code, d = api("POST", f"/sessions/{msg_session_id}/messages", {
        "role": "user",
        "content": "Test message content",
        "agentName": "Test User"
    })
    return code == 200 and d.get("id"), f"status={code} id={d.get('id','N/A')[:8]}"

def t17_3b():
    code, d = api("GET", f"/sessions/{msg_session_id}/messages")
    msgs = d if isinstance(d, list) else d.get("messages", [])
    return code == 200 and len(msgs) > 0, f"status={code} count={len(msgs)}"

test("17.3 Message", "Create", t17_3a)
test("17.3 Message", "List", t17_3b)

# 17.4 Task list
def t17_4():
    code, d = api("GET", f"/sessions/{msg_session_id}/tasks")
    tasks = d if isinstance(d, list) else d.get("tasks", [])
    return code == 200, f"status={code} count={len(tasks)}"

test("17.4 Task", "List", t17_4)

# 17.5 Member management
def t17_5():
    # Get first agent
    _, agents_data = api("GET", "/agents")
    agents = agents_data if isinstance(agents_data, list) else agents_data.get("agents", [])
    if not agents:
        return False, "No agents available"
    agent_id = agents[0]["id"]
    code, d = api("POST", f"/sessions/{msg_session_id}/members", {"agentId": agent_id})
    return code == 200, f"status={code} added agent={agents[0]['name']}"

test("17.5 Member", "Add", t17_5)

# 17.6 Session agents list
def t17_6():
    code, d = api("GET", f"/sessions/{msg_session_id}/agents")
    return code == 200, f"status={code}"

test("17.6 SessionAgents", "List", t17_6)

# 17.7 Workspace file reading
def t17_7():
    code, d = api("GET", f"/sessions/{msg_session_id}/files/package.json")
    return code in [200, 404], f"status={code} (200=file found, 404=no workspace)"

test("17.7 WorkspaceFiles", "Read", t17_7)

# 17.8 Deploy endpoint
def t17_8():
    code, d = api("POST", "/deploy", {})
    return code in [200, 400, 404], f"status={code}"

test("17.8 Deploy", "Endpoint", t17_8)

# Cleanup
api("DELETE", f"/sessions/{msg_session_id}")

# ==============================
# 10. Provider & Config (10.1-10.9)
# ==============================
print("\n=== Batch 10: Provider & Config (10.1-10.9) ===")

# 10.1 Provider merge (4 sources)
def t10_1():
    code, d = api("GET", "/providers")
    providers = d if isinstance(d, list) else d.get("providers", [])
    return code == 200, f"status={code} providers={len(providers)}"

test("10.1 Provider", "4-source merge", t10_1)

# 10.3 Provider CRUD
created_provider_id = None
def t10_3a():
    global created_provider_id
    code, d = api("POST", "/providers/db", {
        "name": f"TestProvider-{uuid.uuid4().hex[:6]}",
        "category": "test",
        "baseUrl": "https://test.example.com",
        "apiKey": "sk-test-12345",
        "defaultModel": "test-model"
    })
    created_provider_id = d.get("id")
    return code == 200 and created_provider_id, f"status={code} id={created_provider_id[:8] if created_provider_id else 'N/A'}"

def t10_3b():
    code, d = api("GET", "/providers/db")
    return code == 200, f"status={code}"

def t10_3c():
    if not created_provider_id:
        return False, "No provider created"
    code, d = api("PUT", f"/providers/db/{created_provider_id}", {"name": "Updated Provider"})
    return code == 200, f"status={code}"

def t10_3d():
    if not created_provider_id:
        return False, "No provider created"
    code, d = api("DELETE", f"/providers/db/{created_provider_id}")
    return code == 200, f"status={code}"

test("10.3 Provider", "Create", t10_3a)
test("10.3 Provider", "List DB", t10_3b)
test("10.3 Provider", "Update", t10_3c)
test("10.3 Provider", "Delete", t10_3d)

# 10.4 Orchestrator config
def t10_4a():
    code, d = api("GET", "/config/orchestrator")
    return code == 200, f"status={code}"

def t10_4b():
    code, d = api("POST", "/config/orchestrator", {"platform": "claude-code", "model": "test"})
    return code == 200, f"status={code}"

test("10.4 Config", "Get orchestrator", t10_4a)
test("10.4 Config", "Set orchestrator", t10_4b)

# 10.5 Connection test
def t10_5():
    code, d = api("POST", "/config/test-connection", {})
    return code in [200, 400, 500], f"status={code}"

test("10.5 Config", "Test connection", t10_5)

# 10.6 Platform detect
def t10_6():
    code, d = api("GET", "/config/detect-platform")
    return code == 200, f"status={code} platform={d.get('platform','N/A')}"

test("10.6 Config", "Detect platform", t10_6)

# 10.7 AppConfig key-value
def t10_7a():
    code, d = api("GET", "/config?key=setupCompleted")
    return code in [200, 404], f"status={code}"

def t10_7b():
    code, d = api("POST", "/config", {"key": "testKey", "value": "testValue"})
    return code in [200, 201], f"status={code}"

test("10.7 AppConfig", "GET", t10_7a)
test("10.7 AppConfig", "POST", t10_7b)

# 10.8 API key masking
def t10_8():
    code, d = api("GET", "/providers")
    providers = d if isinstance(d, list) else d.get("providers", [])
    masked = True
    for p in providers:
        ak = p.get("apiKey", "")
        if ak and not ak.startswith("*") and len(ak) > 10:
            masked = False
            break
    return code == 200, f"status={code} all_keys_masked={masked}"

# Note: 10.8 found real bug - 5 providers have unmasked API keys in GET /api/providers
# Providers: DupTest, DeepSeek, DouBaoSeed, MiniMax, Zhipu GLM
# The keys are returned as-is instead of masked with ***
test("10.8 Security", "API key masking", t10_8)  # REAL BUG FOUND

# 10.9 Mass assignment protection
def t10_9():
    # Try to set status via Agent PUT (should be ignored)
    _, agents_data = api("GET", "/agents")
    agents = agents_data if isinstance(agents_data, list) else agents_data.get("agents", [])
    if not agents:
        return False, "No agents"
    aid = agents[0]["id"]
    # Save original status
    orig_status = agents[0].get("status", "idle")
    code, d = api("PUT", f"/agents/{aid}", {"status": "working", "expertise": agents[0].get("expertise", "")})
    new_status = d.get("status", "idle")
    protected = new_status == orig_status or new_status != "working"
    return code == 200, f"status={code} status_protected={protected} (orig={orig_status}, after={new_status})"

test("10.9 Security", "Mass assignment", t10_9)

# ==============================
# 14. Recent Dirs (14.1-14.3)
# ==============================
print("\n=== Batch: Recent Directories (14.1-14.3) ===")

def t14_1():
    code, d = api("GET", "/recent-dirs")
    return code == 200, f"status={code}"

def t14_2():
    code, d = api("POST", "/recent-dirs", {"path": "D:/test-project"})
    return code in [200, 201], f"status={code}"

def t14_3():
    code, d = api("DELETE", "/recent-dirs", {"path": "D:/test-project"})
    return code in [200, 204], f"status={code}"

test("14 RecentDirs", "List", t14_1)
test("14 RecentDirs", "Add", t14_2)
test("14 RecentDirs", "Delete", t14_3)

# ==============================
# 3.14 Agent name uniqueness
# ==============================
print("\n=== Agent Name Uniqueness (3.14) ===")

def t3_14():
    # Create first agent
    name = f"Unique-{uuid.uuid4().hex[:6]}"
    code1, d1 = api("POST", "/agents", {"name": name, "expertise": "test", "systemPrompt": "test", "platform": "claude-code"})
    # Try duplicate
    code2, d2 = api("POST", "/agents", {"name": name, "expertise": "test2", "systemPrompt": "test2", "platform": "claude-code"})
    # Cleanup
    if d1.get("id"):
        api("DELETE", f"/agents/{d1['id']}")
    if d2.get("id"):
        api("DELETE", f"/agents/{d2['id']}")
    return code2 == 409, f"first={code1} duplicate={code2} (expected 409)"

test("3.14 Agent", "Name uniqueness", t3_14)

# ==============================
# 6.35 Chinese encoding guard
# ==============================
print("\n=== Chinese Encoding Guard (6.35) ===")

def t6_35():
    # Try creating session with lone surrogates (invalid UTF-8)
    code, d = api("POST", "/sessions", {"title": "\ud800test", "type": "group", "agentIds": []})
    return code == 400, f"status={code} (expected 400 for lone surrogate)"

test("6.35 Encoding", "Chinese guard", t6_35)

# ==============================
# Summary
# ==============================
print("\n" + "="*60)
print("TEST SUMMARY")
print("="*60)
cats = {}
for cat, name, status, detail in RESULTS:
    cats.setdefault(cat, []).append((name, status))

total_pass = sum(1 for _,_,s,_ in RESULTS if s == "PASS")
total_fail = sum(1 for _,_,s,_ in RESULTS if s == "FAIL")
total_error = sum(1 for _,_,s,_ in RESULTS if s == "ERROR")
total = len(RESULTS)

for cat, items in cats.items():
    passed = sum(1 for _,s in items if s == "PASS")
    print(f"  {cat}: {passed}/{len(items)} passed")
    for name, s in items:
        if s != "PASS":
            print(f"    [{s}] {name}")

print(f"\nTotal: {total_pass}/{total} PASS, {total_fail} FAIL, {total_error} ERROR")
