# Security Policy

## Supported versions

| Version | Supported |
| --- | --- |
| 0.1.x | Yes |
| `main` | Yes |

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting:

https://github.com/hhhhhhh520/agenthub/security/advisories/new

Do not open a public issue with API keys, tokens, or ready-to-run exploit details.

Please include:

- affected commit or version, and operating system;
- platform and permission mode (`claude-code` / `opencode`, `default` / `auto`);
- minimal reproduction steps;
- impact and the trust boundary crossed;
- relevant logs with secrets redacted.

If you believe a credential was exposed, revoke it first; do not wait for the report to be triaged.

## Scope

In scope:

- AgentHub API routes, Orchestrator, adapters, and MCP server;
- workspace, file-write, and path-boundary handling;
- provider configuration and credential handling;
- dependency and CI supply-chain issues;
- prompt-injection paths that cross into file, shell, network, or credential access.

Out of scope:

- issues that require an already compromised local account or machine;
- incorrect model output that does not cross a security boundary;
- denial of service against your own local instance;
- social engineering;
- reports without a reproducible impact.

## Known accepted risk

AgentHub 0.1.x is a local, single-user application with no API authentication.
This is a documented design decision for the current line, not an oversight.
The service must stay bound to loopback (`127.0.0.1`). Do not expose it through
`npm start`, a LAN address, or a tunnel before adding authentication.

Reports that demonstrate exposure beyond loopback are still in scope and welcome.

## Response

This is a solo-maintained project. I aim to:

- acknowledge a report within 3 business days;
- provide an initial assessment or remediation plan within 10 business days;
- credit reporters who want attribution after a fix is available.

No bug bounty is currently offered.

## Safe harbor

Good-faith security research is welcome. Do not access, modify, or exfiltrate
data that is not yours, and do not test against other users' deployments.

See [docs/security/threat-model.md](docs/security/threat-model.md) for the
project's trust boundaries, attack surface, and accepted risks.
