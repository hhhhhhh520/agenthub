# AgentHub Threat Model

> Scope: AgentHub 0.1.x (`main`), local single-user deployment.
> This document describes trust boundaries and known residual risk. It is not a
> claim that the system is free of vulnerabilities. Report issues through
> [SECURITY.md](../../SECURITY.md), not a public issue.

## 1. System overview

AgentHub is a Next.js application that runs on the user's machine. An
Orchestrator decomposes a task, assigns work to role agents, and runs each agent
through the Claude Code CLI or the OpenCode CLI in a project directory selected
by the user. A stdio MCP server shares task state and messages with the agents.
Provider credentials and session data are stored in a local SQLite database.

The system is single-user and local-only by design. It is not a hosted service
and has no multi-tenant isolation.

## 2. Trust boundaries

```text
Browser
  |
  | 1. HTTP (no auth; loopback only by convention)
  v
Next.js API routes
  |
  | 2. Prisma / SQLite (plaintext local database)
  v
Process registry
  |
  | 3. spawn Claude Code / OpenCode CLI (shell: true on Windows)
  v
CLI child process
  |
  | 4. filesystem / shell / network with the user's OS permissions
  v
Project directory, shell, provider endpoints

MCP server  <-- 5. stdio, session-scoped -->  CLI child process
MCP server  ---> SQLite + project files

Agent/provider config  -- 6. HTTPS/loopback HTTP -->  external model endpoint
Attachments            -- 7. multipart upload -->  local uploads + agent context
GitHub PR / CI         -- 8. npm ci / build -->  dependency supply chain
```

1. **Browser → API.** The API has no authentication. `npm run dev` binds to
   `127.0.0.1`; production `npm start` does not enforce that binding.
2. **API → SQLite.** The database is a local file. Provider keys are stored as
   plaintext columns and are not encrypted at rest.
3. **API → CLI process.** The process registry spawns the selected CLI. On
   Windows this uses `shell: true` because the CLIs are npm `.cmd` shims.
4. **CLI → machine.** Once running, an agent has the same filesystem, shell, and
   network permissions as the user. Tool allowlists and permission modes narrow
   this, but do not create an OS sandbox.
5. **MCP server.** The server runs as a child process with the selected project
   directory as its work dir. It reads and writes the same SQLite database.
6. **Provider configuration.** Each agent can be pointed at an arbitrary HTTPS
   `baseUrl`; prompts and API keys are sent there.
7. **Attachments.** Uploaded files are written under `uploads/` and can be
   passed to an agent's context.
8. **Supply chain.** Dependencies are installed with `npm ci`; CI runs on
   `windows-latest`.

## 3. Assets

- Provider API keys (`Agent.apiKey`, `Provider.apiKey`, `AppConfig`);
- the user's source code and uncommitted changes in the selected project;
- shell and file access on the user's machine;
- session messages, task results, and agent process events;
- the local SQLite database and generated CLI configuration files;
- repository integrity and CI credentials/secrets.

## 4. Attacker model

In scope:

- untrusted repository content (README, issues, source comments) that an agent
  reads and may treat as instructions;
- untrusted agent output and cross-agent messages;
- a malicious or compromised provider `baseUrl`;
- a malicious attachment or project file;
- a network attacker if the service is exposed beyond loopback;
- a malicious dependency, external pull request, or CI change.

Out of scope:

- an attacker who already controls the user's OS account or machine;
- a compromised model provider that the user explicitly configured;
- denial of service against the user's own local instance;
- incorrect model output that does not cross a security boundary.

## 5. Threats and controls

| ID | Threat | Impact | Current controls | Residual risk |
| --- | --- | --- | --- | --- |
| TM-01 | Unauthenticated API exposed beyond loopback | Full control of sessions, agents, files, and CLI processes | `dev` binds `127.0.0.1`; README warning; security policy | `next start` binding is not enforced by the app. Accepted for the local-only line; do not expose without an authenticating proxy. |
| TM-02 | Shell / argument injection in CLI spawn | Command execution as the user | `arg-safety.ts` fail-closed denylist; tool allowlists; permission modes | Denylist approach; new adapter arguments need review. |
| TM-03 | Provider keys at rest | Credential theft by another local process or backup leak | API responses mask keys; generated config files use `0o600` and dirs `0o700`; config sweep | SQLite is plaintext; Windows ACLs, not POSIX modes, are the effective boundary. Rotate keys if a backup or history is exposed. |
| TM-04 | MCP reads sensitive files | Prompt-injected agent reads `.env` or credentials and sends them to a provider | MCP tools are scoped to the selected work dir by `isPathSafe` | No sensitive-file denylist on MCP reads. Treat the selected project as trusted; hardening is planned. |
| TM-05 | Prompt injection from repo content or agent messages | Agent performs unintended file/shell/network actions | Contract v1 (`authoritative_input`, `declaredFiles`, `outputSchema`); tool allowlists; default approval mode | LLM trust boundary remains; `auto` mode bypasses approvals; cross-agent messages have no provenance. |
| TM-06 | Path traversal, symlink, or junction escape | Read/write outside the workspace | `isPathSafe` / `isPathRootSafe`; UUID and ownership checks; sensitive-path blocklist; `list_files` skips symlinks | TOCTOU between check and write; Windows junction/reparse-point edge cases. |
| TM-07 | SSRF or credential egress through `baseUrl` | Keys and prompts sent to an attacker-controlled endpoint | Scheme check: HTTPS or loopback HTTP only | No host allowlist. A malicious provider config is a credential-exfiltration path. |
| TM-08 | Inherited environment variables | Child CLI receives credentials from the parent shell | Claude path scrubs inherited provider env and uses a managed config dir | Other paths/adapters still inherit `process.env`; review before adding new spawn paths. |
| TM-09 | Supply-chain compromise | Malicious code in dependencies or CI | Lockfile; `npm ci`; Vitest/build/lint CI; architecture guards | Dependabot/CodeQL/branch protection are not enabled yet; external PRs need review. |
| TM-10 | Destructive file operations | User files deleted by cleanup logic | Production execution only warns on undeclared files; destructive cleanup is limited to isolated workspaces | Audit/classification bugs could still cause data loss; no trash/undo. |
| TM-11 | Artifact XSS | Script execution in the app origin | DOMPurify; iframe sandbox without `allow-same-origin`; CSP inside preview | No global CSP header; new render paths need review. |
| TM-12 | Malicious attachment | Parser abuse or unintended file handling | Per-file size limit; request-body byte limit; MIME allowlist; UUID filenames; cleanup | No antivirus/content inspection; parser vulnerabilities remain. |

## 6. Accepted risks

- **No API authentication** for the local single-user line. The app must stay on
  loopback. This is documented in `docs/design/roadmap-to-excellence.md` §8#1.
- **Agents have real file and command access** by design. Tool allowlists and
  permission modes reduce, but do not eliminate, this risk. Use `default` mode
  and trusted repositories.
- **Windows ACLs** are the effective permission boundary for generated config
  files. POSIX modes are only a hint on Windows.
- **Provider trust**: a provider configured by the user receives prompts and
  keys by design. Use only providers you trust.

## 7. Review triggers

Re-review this model when a change touches:

- API authentication, host binding, or CORS;
- `src/lib/adapter/**` (spawn, args, env, config files);
- `src/mcp-server/**` (tools, path checks, database access);
- `src/lib/path-safety.ts`, `src/lib/services/sensitive-paths.ts`, or workspace
  write paths;
- provider configuration, `baseUrl` handling, or credential storage;
- attachments, uploads, or body-size limits;
- `.github/workflows/**`, dependency policy, or release process.

## 8. References

- [SECURITY.md](../../SECURITY.md) — reporting and scope
- [Workspace and permissions](https://github.com/hhhhhhh520/agenthub/blob/main/docs/design/workspace-and-permissions.md)
- [Contract v1](https://github.com/hhhhhhh520/agenthub/blob/main/docs/discussions/agenthub-contract-v1.md)
- [Roadmap and accepted risk record](https://github.com/hhhhhhh520/agenthub/blob/main/docs/design/roadmap-to-excellence.md)
