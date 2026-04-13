# Cloud Deployment

This page is an operations-focused companion to [[Cloud Sync]]. It covers how to run the `apps/cloud` server reliably in production-like self-hosted environments.

## Scope

- Mindwtr Cloud is a lightweight self-hosted backend for JSON sync and token-authenticated task automation endpoints, not a full hosted app UI.
- It is best for single-tenant or small trusted deployments.
- You should run it behind HTTPS reverse proxying and standard server hardening controls.

Client compatibility note:

- Mindwtr Cloud clients require **HTTPS** for normal device URLs.
- `http://localhost` is allowed for development, but `http://192.168.x.x` or other private-LAN HTTP URLs are not accepted by the Cloud sync client.
- If you want LAN-only deployment, add TLS at the reverse proxy layer. If you need plain HTTP on a private LAN, use WebDAV instead.

## Deployment Topology

Recommended layout:

1. Reverse proxy (`nginx`, `caddy`, `traefik`) terminates TLS.
2. Cloud server container/process listens on private interface.
3. Persistent volume stores `MINDWTR_CLOUD_DATA_DIR`.
4. Regular backups snapshot the data directory.

The same cloud service handles both:

- Sync traffic under `/v1/data`
- Task automation endpoints such as `/v1/tasks`, `/v1/projects`, and `/v1/search`

## Environment Baseline

Minimum production baseline:

- `MINDWTR_CLOUD_AUTH_TOKENS` set to one or more strong tokens.
- `MINDWTR_CLOUD_CORS_ORIGIN` set to your exact client origin.
- `MINDWTR_CLOUD_DATA_DIR` mounted to persistent storage.
- `MINDWTR_CLOUD_MAX_BODY_BYTES` and `MINDWTR_CLOUD_MAX_ATTACHMENT_BYTES` tuned for your usage.

Optional but useful:

- `MINDWTR_CLOUD_RATE_WINDOW_MS`
- `MINDWTR_CLOUD_RATE_MAX`
- `MINDWTR_CLOUD_ATTACHMENT_RATE_MAX`

## Environment Variables

### Authentication

| Variable | Purpose | Notes |
| --- | --- | --- |
| `MINDWTR_CLOUD_AUTH_TOKENS` | Comma-separated allowlist of bearer tokens. | Recommended setting for production. |
| `MINDWTR_CLOUD_TOKEN` | Legacy single-token alias. | Still supported for backward compatibility, but deprecated. |
| `MINDWTR_CLOUD_ALLOW_ANY_TOKEN` | Allows any syntactically valid bearer token. | Explicit opt-in only. Best avoided outside controlled environments. |

### Networking and storage

| Variable | Purpose | Default |
| --- | --- | --- |
| `MINDWTR_CLOUD_CORS_ORIGIN` | Allowed browser origin for CORS. | `http://localhost:5173` in non-production |
| `MINDWTR_CLOUD_DATA_DIR` | Directory for JSON namespaces, attachments, and locks. | `./data` |
| `MINDWTR_CLOUD_TRUST_PROXY_HEADERS` | Trust `X-Forwarded-For`/proxy IP headers for auth-failure rate limiting. | `false` |

### Request limits

| Variable | Purpose | Default |
| --- | --- | --- |
| `MINDWTR_CLOUD_MAX_BODY_BYTES` | Max JSON request size. | `2000000` |
| `MINDWTR_CLOUD_MAX_ATTACHMENT_BYTES` | Max attachment upload size. | `50000000` |
| `MINDWTR_CLOUD_REQUEST_TIMEOUT_MS` | Per-request timeout for cloud handlers. | `30000` |
| `MINDWTR_CLOUD_MAX_TASK_TITLE_LENGTH` | Max task title length accepted by cloud task endpoints. | `500` |
| `MINDWTR_CLOUD_MAX_TASK_QUICK_ADD_LENGTH` | Max quick-add input length accepted by cloud task creation. | `2000` |
| `MINDWTR_CLOUD_MAX_ITEMS_PER_COLLECTION` | Max tasks/projects/sections/areas per uploaded collection. | `50000` |

### Pagination and list shaping

| Variable | Purpose | Default |
| --- | --- | --- |
| `MINDWTR_CLOUD_LIST_DEFAULT_LIMIT` | Default page size for list endpoints. | `200` |
| `MINDWTR_CLOUD_LIST_MAX_LIMIT` | Hard cap for list endpoint page size. | `1000` |

### Rate limiting

| Variable | Purpose | Default |
| --- | --- | --- |
| `MINDWTR_CLOUD_RATE_WINDOW_MS` | Main rate-limit window length. | `60000` |
| `MINDWTR_CLOUD_RATE_MAX` | Max non-attachment requests per window. | `120` |
| `MINDWTR_CLOUD_ATTACHMENT_RATE_MAX` | Max attachment requests per window. | same as `MINDWTR_CLOUD_RATE_MAX` |
| `MINDWTR_CLOUD_RATE_CLEANUP_MS` | Interval for pruning expired in-memory rate-limit entries. | `60000` |
| `MINDWTR_CLOUD_RATE_MAX_KEYS` | Max distinct in-memory rate-limit keys to keep before LRU-style eviction. | `10000` |
| `MINDWTR_CLOUD_AUTH_FAILURE_RATE_MAX` | Max unauthorized attempts per client IP/window before throttling. | `30` |

Operational guidance:

- Keep proxy body limits aligned with `MINDWTR_CLOUD_MAX_BODY_BYTES` and `MINDWTR_CLOUD_MAX_ATTACHMENT_BYTES`.
- If you enable `MINDWTR_CLOUD_TRUST_PROXY_HEADERS`, do so only behind a proxy that overwrites forwarded IP headers.
- If you rotate from `MINDWTR_CLOUD_TOKEN` to `MINDWTR_CLOUD_AUTH_TOKENS`, remember that token changes also change the namespace key.

## Docker Runbook

Example `docker-compose.yml` service:

```yaml
services:
  mindwtr-cloud:
    image: oven/bun:1.3
    working_dir: /app
    command: ["bun", "run", "--filter", "mindwtr-cloud", "start", "--", "--host", "0.0.0.0", "--port", "8787"]
    environment:
      MINDWTR_CLOUD_DATA_DIR: /data
      MINDWTR_CLOUD_AUTH_TOKENS: ${MINDWTR_CLOUD_AUTH_TOKENS}
      MINDWTR_CLOUD_CORS_ORIGIN: https://mindwtr.example.com
      MINDWTR_CLOUD_RATE_MAX: "120"
      MINDWTR_CLOUD_ATTACHMENT_RATE_MAX: "120"
    volumes:
      - ./apps/cloud:/app
      - ./mindwtr-cloud-data:/data
    restart: unless-stopped
```

Operational notes:

- Pin the Bun image tag instead of floating latest for stable upgrades.
- Mount `/data` on durable disk, not ephemeral container FS.
- Keep tokens in secrets manager or `.env` outside git.
- The same deployed container serves both sync and REST API traffic on the same host/port.

## Reverse Proxy Checklist

At proxy layer:

- Enforce HTTPS.
- Limit request body size to match cloud limits.
- Forward `Authorization` header unchanged.
- Set request timeout high enough for large attachment uploads.
- Restrict access by IP/VPN if possible.

Example nginx snippets:

```nginx
client_max_body_size 50m;
proxy_read_timeout 120s;
proxy_send_timeout 120s;
proxy_set_header Authorization $http_authorization;
```

## Backups and Restore

Data format is file-per-token JSON plus attachment files.

Backup:

1. Snapshot or archive `MINDWTR_CLOUD_DATA_DIR`.
2. Keep point-in-time backups (daily + weekly retention).
3. Verify restore periodically.

Restore:

1. Stop server.
2. Restore directory contents to `MINDWTR_CLOUD_DATA_DIR`.
3. Start server.
4. Check `GET /health` and run a client sync validation.

## Upgrade Procedure

Safe rolling procedure:

1. Take backup.
2. Deploy new version in staging or canary first.
3. Run smoke checks:
   - `GET /health`
   - authenticated `GET /v1/data`
   - authenticated `GET /v1/tasks`
   - small and large attachment upload/download
4. Deploy to production.
5. Monitor logs for `rate limit`, `invalid payload`, and `permission denied` errors.

## Token Rotation

Recommended rotation flow:

1. Add new token to `MINDWTR_CLOUD_AUTH_TOKENS` alongside old token.
2. Update clients to new token.
3. Remove old token after migration window.

Because token hash maps namespace/file, changing token changes storage namespace. If you require continuity under a new token, migrate corresponding data file/attachment directory deliberately.

## Observability

The cloud server writes structured JSON logs to stdout/stderr.

Minimum log alerts:

- Repeated `Unauthorized`
- Frequent `Rate limit exceeded`
- `Cloud data directory is not writable`
- `Invalid remote sync payload`

Add host/container metrics:

- CPU and memory
- disk free space on data volume
- p95 request latency
- non-2xx response rate

## Failure Modes

- Permission errors: volume ownership/permissions mismatch.
- CORS failures: wrong `MINDWTR_CLOUD_CORS_ORIGIN`.
- Token mismatch: client token not in allowlist.
- Large payload failures: body limits exceeded at proxy or app layer.

## Related Pages

- [[Cloud Sync]]
- [[Data and Sync]]
- [[Docker Deployment]]
