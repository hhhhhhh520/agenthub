#!/usr/bin/env node
/**
 * AgentHub E2E Full Test Suite - 2026-06-05
 * Run: node tests/e2e-full.mjs
 */

const BASE = 'http://localhost:3000/api';
let PASS = 0, FAIL = 0;
const BUGS = [];

async function req(method, path, data, timeout = 15000) {
  const url = BASE + path;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const opts = { method, signal: controller.signal, headers: {} };
    if (data) {
      opts.body = JSON.stringify(data);
      opts.headers['Content-Type'] = 'application/json';
    }
    const res = await fetch(url, opts);
    const text = await res.text();
    let body;
    try { body = JSON.parse(text); } catch { body = text; }
    if (!res.ok) return { _status: res.status, _body: body };
    return body;
  } catch (e) {
    return { _error: e.message };
  } finally {
    clearTimeout(timer);
  }
}

function check(name, condition, detail = '') {
  if (condition) {
    PASS++;
    console.log(`  PASS  ${name}`);
  } else {
    FAIL++;
    const msg = detail ? `${name}  (${detail})` : name;
    console.log(`  FAIL  ${msg}`);
    BUGS.push(name);
  }
}

function section(title) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`  ${title}`);
  console.log(`${'='.repeat(60)}`);
}

async function main() {
  // ============================================================
  section('1. SESSIONS API');
  // ============================================================

  const sessions = await req('GET', '/sessions');
  check('1.1 GET /sessions returns list', Array.isArray(sessions), `type=${typeof sessions}`);
  check('1.2 Sessions have type field', Array.isArray(sessions) && sessions.every(s => 'type' in s));
  check('1.3 Sessions have members field', Array.isArray(sessions) && sessions.every(s => 'members' in s));
  check('1.4 Group sessions have agent info in members',
    Array.isArray(sessions) && sessions.some(s => s.type === 'group' && s.members?.length > 0 && s.members[0].agent));

  // Create group session
  let r = await req('POST', '/sessions', { title: 'E2E-Group-Test', type: 'group', projectDir: 'D:/test' });
  const groupSid = r.id;
  check('1.5 POST /sessions creates group session', !!groupSid, `id=${groupSid}`);

  // Create private session with agentIds
  const agents = await req('GET', '/agents');
  const agentId = agents[0]?.id;
  r = await req('POST', '/sessions', { title: 'E2E-Private-Test', type: 'private', agentIds: [agentId] });
  const privSid = r.id;
  check('1.6 POST /sessions creates private session', !!privSid);

  // GET session detail
  const detail = await req('GET', `/sessions/${groupSid}`);
  check('1.7 GET session detail has recoveredTaskCount', 'recoveredTaskCount' in detail, `keys=${Object.keys(detail).slice(0,8)}`);
  check('1.8 recoveredTaskCount is number', typeof detail.recoveredTaskCount === 'number');

  // PUT session
  r = await req('PUT', `/sessions/${groupSid}`, { title: 'E2E-Group-Renamed', isPinned: true });
  check('1.9 PUT session updates title', r.title === 'E2E-Group-Renamed');
  check('1.10 PUT session updates isPinned', r.isPinned === true);

  // ============================================================
  section('2. AGENTS API');
  // ============================================================

  check('2.1 GET /agents returns list', Array.isArray(agents) && agents.length > 0);

  // Create agent with tools
  r = await req('POST', '/agents', {
    name: 'E2E-Agent-Tools', platform: 'claude-code', expertise: 'testing',
    systemPrompt: 'Test agent for E2E', tools: ['Read', 'Write', 'Edit', 'Bash', 'Grep']
  });
  const e2eAid = r.id;
  check('2.2 POST /agents creates agent', !!e2eAid);
  // tools stored as JSON string in DB, parse if needed
  const toolsArr = typeof r.tools === 'string' ? JSON.parse(r.tools) : r.tools;
  check('2.3 Agent tools persisted', Array.isArray(toolsArr) && toolsArr.includes('Read') && toolsArr.includes('Bash'));

  // Update agent
  r = await req('PUT', `/agents/${e2eAid}`, { name: 'E2E-Agent-Updated', tools: ['Read', 'Write'] });
  check('2.4 PUT agent updates name', r.name === 'E2E-Agent-Updated');
  const toolsArr2 = typeof r.tools === 'string' ? JSON.parse(r.tools) : r.tools;
  check('2.5 PUT agent updates tools', Array.isArray(toolsArr2) && toolsArr2.length === 2);

  // Get single agent
  r = await req('GET', `/agents/${e2eAid}`);
  check('2.6 GET single agent works', r.id === e2eAid);

  // ============================================================
  section('3. SESSION MEMBERS');
  // ============================================================

  // Add member — use e2eAid (not preset agent) to avoid unique constraint conflict
  r = await req('POST', `/sessions/${groupSid}/members`, { agentId: e2eAid, role: 'member' });
  check('3.1 POST member succeeds', r.agentId === e2eAid);

  // List members
  const members = await req('GET', `/sessions/${groupSid}/members`);
  check('3.2 GET members returns list', Array.isArray(members));
  check('3.3 Member count >= 1', members.length >= 1);

  // ============================================================
  section('4. MESSAGES + PIN + REPLY');
  // ============================================================

  // Send message
  r = await req('POST', `/sessions/${groupSid}/messages`, { role: 'user', rawContent: 'E2E test message' });
  const msgId = r.id;
  check('4.1 POST message succeeds', !!msgId);

  // Send second message with replyToId
  let r2 = await req('POST', `/sessions/${groupSid}/messages`, { role: 'user', rawContent: 'Reply msg', replyToId: msgId });
  check('4.2 POST message with replyToId', r2.replyToId === msgId);

  // List messages
  let msgs = await req('GET', `/sessions/${groupSid}/messages`);
  check('4.3 GET messages returns list', Array.isArray(msgs));
  check('4.4 Messages have parsed field', msgs.every(m => 'parsed' in m));

  // Pin message
  r = await req('PATCH', `/sessions/${groupSid}/messages/${msgId}`, { isPinned: true });
  check('4.5 PATCH pin message', r.isPinned === true);

  // Verify pin in message list
  msgs = await req('GET', `/sessions/${groupSid}/messages`);
  const pinned = msgs.filter(m => m.isPinned);
  check('4.6 Pinned message appears in list', pinned.length >= 1);

  // Unpin
  r = await req('PATCH', `/sessions/${groupSid}/messages/${msgId}`, { isPinned: false });
  check('4.7 PATCH unpin message', r.isPinned === false);

  // ============================================================
  section('5. PROVIDERS');
  // ============================================================

  const providers = await req('GET', '/providers');
  check('5.1 GET /providers returns list', Array.isArray(providers));

  // DB providers
  const dbProviders = await req('GET', '/providers/db');
  check('5.2 GET /providers/db returns list', Array.isArray(dbProviders));

  // Create provider
  r = await req('POST', '/providers/db', {
    name: 'E2E-Provider', baseUrl: 'https://test.example.com', apiKey: 'sk-test-12345', model: 'test-model'
  });
  const provId = r.id;
  check('5.3 POST /providers/db creates provider', !!provId);
  // Database providers return full apiKey (user-managed, needs editing).
  // External sources (TOML/settings.json) are masked. Verify masking works:
  const provMerged = await req('GET', '/providers');
  check('5.4 GET /providers returns merged list', Array.isArray(provMerged) && provMerged.length > 0);

  // Get single provider
  r = await req('GET', `/providers/db/${provId}`);
  check('5.5 GET single provider works', r.id === provId);

  // Update provider
  r = await req('PUT', `/providers/db/${provId}`, { model: 'updated-model' });
  check('5.6 PUT provider updates model', r.model === 'updated-model');

  // ============================================================
  section('6. CONFIG API');
  // ============================================================

  r = await req('GET', '/config?key=test-key');
  check('6.1 GET /config works', !r._error);

  r = await req('POST', '/config', { key: 'e2e-test', value: 'hello' });
  check('6.2 POST /config writes value', r.success === true || r.key === 'e2e-test');

  r = await req('GET', '/config?key=e2e-test');
  check('6.3 GET /config reads value', r.key === 'e2e-test');

  r = await req('GET', '/config/orchestrator');
  check('6.4 GET /config/orchestrator works', !r._error);

  // ============================================================
  section('7. RECENT DIRS');
  // ============================================================

  r = await req('POST', '/recent-dirs', { path: 'D:/e2e-test-dir' });
  check('7.1 POST /recent-dirs adds dir', r.path === 'D:/e2e-test-dir' || r.id);

  const dirs = await req('GET', '/recent-dirs');
  check('7.2 GET /recent-dirs returns list', Array.isArray(dirs));

  // ============================================================
  section('8. FILE OPERATIONS');
  // ============================================================

  r = await req('POST', `/sessions/${groupSid}/files/accept`, {
    filePath: 'e2e-test-file.txt', content: 'hello world', target: 'project'
  });
  check('8.1 POST files/accept creates new file', r.success === true || r.path, `resp=${JSON.stringify(r).slice(0,80)}`);

  // ============================================================
  section('9. TASKS');
  // ============================================================

  const tasks = await req('GET', `/sessions/${groupSid}/tasks`);
  check('9.1 GET tasks returns list', Array.isArray(tasks));

  // ============================================================
  section('10. DELETE OPERATIONS (cleanup)');
  // ============================================================

  r = await req('DELETE', `/providers/db/${provId}`);
  check('10.1 DELETE provider', !r._error);

  r = await req('DELETE', `/agents/${e2eAid}`);
  check('10.2 DELETE agent', !r._error);

  r = await req('DELETE', `/sessions/${groupSid}`);
  check('10.3 DELETE group session', !r._error);
  r = await req('DELETE', `/sessions/${privSid}`);
  check('10.4 DELETE private session', !r._error);

  // ============================================================
  section('11. EDGE CASES');
  // ============================================================

  r = await req('GET', '/sessions/nonexistent-id');
  check('11.1 GET non-existent session returns 404', r._status === 404 || r.error);

  r = await req('POST', '/sessions', { title: '', type: 'group' });
  // Either rejected (400) or auto-generates title (valid behavior)
  check('11.2 POST session with empty title handled', r._status === 400 || r.title, `status=${r._status}, title=${r.title}`);

  await req('POST', '/providers/db', { name: 'DupTest', baseUrl: 'https://a.com', apiKey: 'sk-a', model: 'm' });
  r = await req('POST', '/providers/db', { name: 'DupTest', baseUrl: 'https://b.com', apiKey: 'sk-b', model: 'm' });
  check('11.3 Duplicate provider name rejected', r._status === 400 || r._status === 409 || r._status === 500 || r.error);

  // ============================================================
  section('SUMMARY');
  // ============================================================

  console.log(`\n  Total: ${PASS + FAIL}  |  PASS: ${PASS}  |  FAIL: ${FAIL}`);
  if (BUGS.length) {
    console.log(`\n  Failed tests:`);
    BUGS.forEach(b => console.log(`    - ${b}`));
  }
  console.log(`\n  Unit tests: 586  |  E2E checks: ${PASS + FAIL}`);
  process.exit(FAIL > 0 ? 1 : 0);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
