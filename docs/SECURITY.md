# Security Policy

## Supported Versions

Mindwtr currently provides security fixes for the latest stable release line.

| Version | Supported |
| ------- | --------- |
| 0.8.x   | :white_check_mark: |
| < 0.8.0 | :x: |

## Security Model

Mindwtr is local-first by default. Most users can run the desktop or mobile apps without exposing any network service at all. The main security boundaries are therefore:

- local device storage
- optional sync credentials and remote storage
- the self-hosted cloud server (`apps/cloud`)
- the local MCP server (`apps/mcp-server`)

### Local Data

- Task data is stored locally first.
- Sync is optional and user-configured.
- Secrets such as API keys or sync tokens should be treated as local machine secrets and protected accordingly.

### Cloud Server (`apps/cloud`)

The self-hosted sync server is intended for small trusted deployments and single-user or small-team hosting. Current controls include:

- bearer token authentication with explicit allowlists via `MINDWTR_CLOUD_AUTH_TOKENS`
- legacy `MINDWTR_CLOUD_TOKEN` support for backward compatibility
- strict CORS origin configuration in production
- request body and attachment size limits
- request timeout enforcement
- route-scoped rate limiting, including separate auth-failure throttling
- path traversal rejection for attachment paths
- symlink-safe attachment writes
- atomic file replacement for JSON state and uploaded attachments
- namespace isolation by hashed bearer token

Recommended deployment posture:

- run behind HTTPS
- keep the server on a private interface behind a reverse proxy
- store data on persistent storage with regular backups
- rotate tokens deliberately and treat them like passwords

### MCP Server (`apps/mcp-server`)

The MCP server is a local stdio process, not a network service. Its main controls are:

- read-only by default
- explicit `--write` flag required for mutations
- typed input validation on tool calls
- bounded list/query limits
- SQLite busy timeout to avoid indefinite lock waits

Do not expose the MCP server over an untrusted transport. It is designed to be launched locally by an MCP-capable client such as Claude Desktop, Claude Code, Codex, or Gemini CLI.

### Sync Backends

Mindwtr supports multiple backends, including file sync, WebDAV, Dropbox in supported builds, and the self-hosted cloud endpoint. Security characteristics depend partly on the provider you choose:

- file sync inherits the security model of your filesystem or sync tool
- WebDAV security depends on your provider, TLS, and credential hygiene
- self-hosted cloud security depends on token handling, HTTPS, proxy configuration, and host hardening

### Scope Notes

Mindwtr does not claim to be a multi-tenant hosted SaaS. The cloud server is intentionally simple and optimized for self-hosting rather than broad internet-facing shared hosting.

## Reporting a Vulnerability

Please report security vulnerabilities using GitHub Private Vulnerability Reporting:

- **Report here:** https://github.com/dongdongbh/Mindwtr/security/advisories/new

Please include:

- A clear description of the issue
- Reproduction steps or proof of concept
- Affected platform/version (Desktop, Mobile, Cloud, MCP)
- Potential impact

What to expect:

- Initial response target: within 7 days
- We will validate the report, assess severity, and coordinate a fix/release timeline
- If accepted, we will prepare a fix and disclose responsibly after users can update
- If declined, we will explain why (for example, out of scope or not reproducible)

Please do not open public GitHub issues for security vulnerabilities and do not disclose details publicly before a fix is available.
