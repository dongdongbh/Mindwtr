# Mindwtr MCP Server

MCP server for Mindwtr. Connect MCP clients (Claude Desktop, etc.) to either your local Mindwtr SQLite database or a self-hosted Mindwtr Cloud endpoint.

By default this is a **stdio** server: MCP clients launch it as a subprocess and talk over JSON-RPC on stdin/stdout. It also has an opt-in **HTTP transport** (see [Remote access (HTTP)](#remote-access-http)) for self-hosters who want to expose it at a URL instead.

---

## App Binaries vs. MCP Helper

The desktop and mobile app binaries include the Mindwtr app, but they do **not** currently include a desktop start/stop toggle or a standalone `mindwtr-mcp` command on your `PATH`.

You do **not** need to run the whole app from source to use MCP. You can use the normal desktop app binary for your tasks, then run this separate MCP helper from the repository with Bun, or build the helper once and run it with Node. Point the helper at the desktop app's local `mindwtr.db`.

On desktop, the app shows the exact local data path in **Settings -> Sync -> Local Data**. Mobile binaries do not expose a local MCP server surface.

---

## Requirements

- Node.js 18+ (for the MCP client that spawns the server)
- npm package installs use better-sqlite3, a native SQLite addon. If no prebuilt binary is available for your platform, npm needs a working C/C++ build toolchain and Python for node-gyp.
- Bun (recommended for development in this repo)
- A local Mindwtr database (`mindwtr.db`) for local mode, or a self-hosted Mindwtr Cloud URL and bearer token for Cloud mode

Default database locations:
- Linux: `~/.local/share/mindwtr/mindwtr.db`
- macOS: `~/Library/Application Support/mindwtr/mindwtr.db`
- Windows: `%APPDATA%\mindwtr\mindwtr.db`

Additional macOS path for sandboxed builds:
- `~/Library/Containers/tech.dongdongbh.mindwtr/Data/Library/Application Support/mindwtr/mindwtr.db`

If `mindwtr.db` is missing but `data.json` exists in the same desktop data folder, the MCP server will bootstrap a fresh SQLite database from that local data snapshot on first start.
Desktop Settings → Sync → Local Data shows the exact storage location used by the app.

You can override local mode with:
- `--db /path/to/mindwtr.db`
- `MINDWTR_DB_PATH=/path/to/mindwtr.db`
- `MINDWTR_DB=/path/to/mindwtr.db`

For self-hosted Cloud mode, use:
- `--cloud-url https://mindwtr.example.com` or `MINDWTR_MCP_CLOUD_URL`
- `--cloud-token <token>` or `MINDWTR_MCP_CLOUD_TOKEN`
- optional `--cloud-allow-insecure-http=true` for trusted private HTTP deployments

---

## Start / Stop

### Run from npm

After installing the published package, run it directly:

```bash
mindwtr-mcp --db "/path/to/mindwtr.db"
```

Or let an MCP client launch it through npx:

```json
{
  "mcpServers": {
    "mindwtr": {
      "command": "npx",
      "args": [
        "-y",
        "mindwtr-mcp",
        "--db",
        "~/.local/share/mindwtr/mindwtr.db"
      ]
    }
  }
}
```

The npm package is read-only by default. Add `--write` only when you explicitly want add/update/complete/delete tools enabled.

### Self-hosted Cloud mode

Use Cloud mode when you run your own Mindwtr Cloud server and want MCP tools without pointing the helper at a local SQLite database:

```bash
npx -y mindwtr-mcp \
  --cloud-url "https://mindwtr.example.com" \
  --cloud-token "$MINDWTR_TOKEN"
```

Or pass the same values through environment variables:

```bash
MINDWTR_MCP_CLOUD_URL="https://mindwtr.example.com" \
MINDWTR_MCP_CLOUD_TOKEN="$MINDWTR_TOKEN" \
npx -y mindwtr-mcp
```

Cloud mode uses the self-hosted Cloud API. Reads come from the current `/v1/data` snapshot; with `--write`, task/project/section/area writes go through the Cloud server's per-resource REST endpoints (`POST /v1/tasks`, `PATCH /v1/tasks/:id`, and so on), so they get the same validation and revision stamping as any other client. Without `--write`, write tools return `read_only`. Person edits and restoring deleted tasks are not available in Cloud mode yet.

This does not make Mindwtr Cloud itself a hosted MCP server. It is still the same stdio helper, backed by a Cloud URL that you operate.

For private HTTP test deployments, local/private HTTP URLs are allowed by the shared Cloud client rules. Use `--cloud-allow-insecure-http=true` only for a self-hosted endpoint you intentionally trust.

### Remote access (HTTP)

By default `mindwtr-mcp` only speaks stdio. Pass `--http` to also (instead of stdio) serve a stateless streamable-HTTP MCP endpoint, so you can point a remote MCP client at a URL — the motivating case is [Gemini Spark](https://gemini.google.com) "custom apps", which take an MCP server URL. HTTP mode works with either backend (local SQLite or self-hosted Cloud).

```bash
mindwtr-mcp --http --http-token "$(openssl rand -hex 32)" --db "/path/to/mindwtr.db"
```

Flags (all have `MINDWTR_MCP_HTTP*` env var equivalents):

- `--http` / `MINDWTR_MCP_HTTP` — enable HTTP mode. Also implied by setting `--http-host`, `--http-port`, or `--http-token`.
- `--http-token <token>` / `MINDWTR_MCP_HTTP_TOKEN` — **required** whenever HTTP mode is on, at least 16 characters. Generate one with `openssl rand -hex 32`. The server refuses to start without it — there is no way to expose HTTP mode unauthenticated, even on loopback.
- `--http-host <host>` / `MINDWTR_MCP_HTTP_HOST` — bind address, default `127.0.0.1`.
- `--http-port <port>` / `MINDWTR_MCP_HTTP_PORT` — bind port, default `8722`.

The MCP endpoint is `POST /mcp` and requires `Authorization: Bearer <token>` on every request; `GET /healthz` returns `200 ok` without auth for reverse-proxy health checks. Requests without a valid token get `401`; bodies over 1 MiB get `413`. When HTTP mode is on, the server does not also connect a stdio transport — it stays alive as long as the HTTP server is listening, not stdin.

There is no built-in TLS termination or rate limiting. If you're exposing this beyond localhost, put a reverse proxy (e.g. Caddy, nginx) in front for TLS and put the resulting `https://` URL (plus your token) into the remote MCP client.

### Run directly from the repo

```bash
# from repo root (read-only by default)
bun run mindwtr:mcp -- --db "/path/to/mindwtr.db"
```

Enable writes (required for add/update/complete/delete tools):

```bash
bun run mindwtr:mcp -- --db "/path/to/mindwtr.db" --write
```

Stop:
- Press `Ctrl+C` in the terminal.

### Keep-alive behavior (why it sometimes exits)

The MCP server is **stdio‑based**. It stays alive as long as stdin is open.
If your shell/client closes stdin, the process exits.

To force an immediate exit when stdin closes (no keep-alive), pass `--nowait`:

```bash
bun run mindwtr:mcp -- --db "/path/to/mindwtr.db" --nowait
```

Note: When an MCP client launches the server, it keeps stdin open, so the server should remain connected.

### Run without the helper script

```bash
bun run --filter mindwtr-mcp dev -- --db "/path/to/mindwtr.db"
```

Stop:
- Press `Ctrl+C` in the terminal.

### Build and run the binary entry (Node)

```bash
# from repo root
bun run --filter mindwtr-mcp build
node apps/mcp-server/dist/cli.js --db "/path/to/mindwtr.db"
```

Stop:
- Press `Ctrl+C` in the terminal.

---

## Why `mindwtr-mcp` is “command not found”

`mindwtr-mcp` is the package binary. It exists after installing the npm package globally, after an MCP client launches it through `npx`, or after you build the source package and run it with Node.

Use one of these source-tree options instead:

```bash
# ✅ works immediately
bun run mindwtr:mcp -- --db "/path/to/mindwtr.db"

# ✅ build then run
bun run --filter mindwtr-mcp build
node apps/mcp-server/dist/cli.js --db "/path/to/mindwtr.db"
```

### Optional: create a global `mindwtr-mcp` command

If you want a real `mindwtr-mcp` command on your PATH, create a tiny wrapper:

```bash
cat > ~/bin/mindwtr-mcp <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
cd /absolute/path/to/Mindwtr
exec bun run mindwtr:mcp -- "$@"
EOF
chmod +x ~/bin/mindwtr-mcp
```

Then use:

```bash
mindwtr-mcp --db "/path/to/mindwtr.db"
```

### Desktop app toggle?

Not yet. Start/stop is still manual.

---

## MCP Client Configuration

MCP clients run the server as a subprocess. You point them to **the command** and pass args/env.

**Important:** Do NOT use `bun run mindwtr:mcp` for MCP clients. The `bun run` wrapper outputs shell messages to stdout (e.g., `$ bun run --filter...`) which breaks the JSON-RPC protocol. Always run bun directly on the source file.

### Example (generic MCP config)

```json
{
  "mcpServers": {
    "mindwtr": {
      "command": "bun",
      "args": [
        "/absolute/path/to/Mindwtr/apps/mcp-server/src/cli.ts",
        "--db",
        "~/.local/share/mindwtr/mindwtr.db"
      ]
    }
  }
}
```

Add `--write` to the args if you want to enable **add/update/complete/delete** tools.

If your client doesn't support Bun, build first and use Node:

```bash
# Build once
cd /path/to/Mindwtr && bun run --filter mindwtr-mcp build
```

```json
{
  "mcpServers": {
    "mindwtr": {
      "command": "node",
      "args": [
        "/absolute/path/to/Mindwtr/apps/mcp-server/dist/cli.js",
        "--db",
        "~/.local/share/mindwtr/mindwtr.db"
      ]
    }
  }
}
```

Add `--write` to the args if you want to enable **add/update/complete/delete** tools.

### Claude Desktop

Claude Desktop supports MCP (stdio). Add a server entry in its MCP configuration.

Typical config file locations:
- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

After editing, fully quit and relaunch Claude Desktop.

### Claude Code (CLI)

Add a server via the CLI:

```bash
claude mcp add mindwtr -- \
  bun /path/to/Mindwtr/apps/mcp-server/src/cli.ts --db "/path/to/mindwtr.db" --write
```

Or edit `~/.claude.json` directly:

```json
{
  "projects": {
    "/path/to/your/project": {
      "mcpServers": {
        "mindwtr": {
          "type": "stdio",
          "command": "bun",
          "args": [
            "/absolute/path/to/Mindwtr/apps/mcp-server/src/cli.ts",
            "--db",
            "~/.local/share/mindwtr/mindwtr.db",
            "--write"
          ]
        }
      }
    }
  }
}
```

Then restart the Claude Code session and run `/mcp` to verify it's connected.

### OpenAI Codex (config.toml)

Codex stores MCP config in `~/.codex/config.toml`. Add:

```toml
[mcp_servers.mindwtr]
command = "bun"
args = ["/absolute/path/to/Mindwtr/apps/mcp-server/src/cli.ts", "--db", "/path/to/mindwtr.db", "--write"]

# Optional: pass env vars to the server
[mcp_servers.mindwtr.env]
MINDWTR_DB_PATH = "/path/to/mindwtr.db"
```

Restart Codex after saving.

### Gemini CLI

Gemini CLI uses a JSON `settings.json` with `mcpServers`, either:
- User scope: `~/.gemini/settings.json`
- Project scope: `.gemini/settings.json` in your repo

You can add Mindwtr MCP two ways:

**1) CLI (recommended):**

```bash
gemini mcp add mindwtr \
  bun /absolute/path/to/Mindwtr/apps/mcp-server/src/cli.ts \
  --db "/path/to/mindwtr.db" --write
```

**2) Edit settings.json manually:**

```json
{
  "mcpServers": {
    "mindwtr": {
      "command": "bun",
      "args": ["/absolute/path/to/Mindwtr/apps/mcp-server/src/cli.ts", "--db", "/path/to/mindwtr.db", "--write"]
    }
  }
}
```

Restart the Gemini CLI session after saving.

### Other MCP clients

Any MCP-compatible client can work as long as it can launch a **stdio** server with the command + args above.

---

## Migration: tool rename (`mindwtr.*` → `mindwtr_*`)

> **Breaking change** (introduced in this release): all tool names have changed from dot-notation (`mindwtr.list_tasks`) to underscore-notation (`mindwtr_list_tasks`) to comply with MCP client validation rules (e.g. Claude Desktop).

**Old → new mapping:**

| Old name                  | New name                   |
| ------------------------- | -------------------------- |
| `mindwtr.list_tasks`      | `mindwtr_list_tasks`       |
| `mindwtr.list_projects`   | `mindwtr_list_projects`    |
| `mindwtr.get_project`     | `mindwtr_get_project`      |
| `mindwtr.get_task`        | `mindwtr_get_task`         |
| `mindwtr.list_areas`      | `mindwtr_list_areas`       |
| `mindwtr.add_task`        | `mindwtr_add_task`         |
| `mindwtr.update_task`     | `mindwtr_update_task`      |
| `mindwtr.complete_task`   | `mindwtr_complete_task`    |
| `mindwtr.delete_task`     | `mindwtr_delete_task`      |
| `mindwtr.restore_task`    | `mindwtr_restore_task`     |
| `mindwtr.add_project`     | `mindwtr_add_project`      |
| `mindwtr.update_project`  | `mindwtr_update_project`   |
| `mindwtr.delete_project`  | `mindwtr_delete_project`   |
| `mindwtr.add_area`        | `mindwtr_add_area`         |
| `mindwtr.update_area`     | `mindwtr_update_area`      |
| `mindwtr.delete_area`     | `mindwtr_delete_area`      |

**Upgrade action:** find and replace `mindwtr.` with `mindwtr_` in any MCP client configs, system prompts, scripts, or automations that reference these tool names. No other changes are required.

---

## Tools

- `mindwtr_list_tasks`
  - Input: `{ status?, projectId?, includeDeleted?, limit?, offset?, search?, dueDateFrom?, dueDateTo?, sortBy?, sortOrder? }`
- `mindwtr_list_projects`
  - Input: `{}`
- `mindwtr_get_project`
  - Input: `{ id, includeDeleted? }`
- `mindwtr_list_sections`
  - Input: `{ projectId?, includeDeleted? }`
- `mindwtr_get_section`
  - Input: `{ id, includeDeleted? }`
- `mindwtr_list_areas`
  - Input: `{}`
- `mindwtr_list_people`
  - Input: `{ includeDeleted? }`
- `mindwtr_get_person`
  - Input: `{ id, includeDeleted? }`
- `mindwtr_get_task`
  - Input: `{ id, includeDeleted? }`
- `mindwtr_add_task` **(requires `--write`)**
  - Input: `{ title? | quickAdd?, status?, projectId?, sectionId?, areaId?, dueDate?, startTime?, reviewAt?, recurrence?, contexts?, tags?, description?, priority?, energyLevel?, assignedTo?, timeEstimate?, taskMode?, relativeStartOffset?, showFutureRecurrence?, pushCount?, checklist?, textDirection?, location?, isFocusedToday?, timeSpentMinutes?, suppressMindwtrReminders?, repeatReminderMinutes?, attachments? }`
- `mindwtr_update_task` **(requires `--write`)**
  - Input: `{ id, title?, status?, projectId?, sectionId?, areaId?, dueDate?, startTime?, reviewAt?, recurrence?, contexts?, tags?, description?, priority?, energyLevel?, assignedTo?, timeEstimate?, taskMode?, relativeStartOffset?, showFutureRecurrence?, pushCount?, checklist?, textDirection?, location?, isFocusedToday?, timeSpentMinutes?, suppressMindwtrReminders?, repeatReminderMinutes?, order?, boardOrder?, focusOrder?, attachments? }`
  - `recurrence` accepts a recurrence object or an RFC 5545 RRULE string. Pass `null` to clear it.
  - `attachments` holds link attachments only (`{ id?, title?, uri }`, e.g. `obsidian://`, `file://` or `https://`). The list you pass is the complete set of links: links you leave out are removed, file attachments are never touched, and `null` clears every link.
- `mindwtr_complete_task` **(requires `--write`)**
  - Input: `{ id }`
- `mindwtr_delete_task` **(requires `--write`)**
  - Input: `{ id }`
- `mindwtr_restore_task` **(requires `--write`)**
  - Input: `{ id }`
- `mindwtr_add_project` **(requires `--write`)**
  - Input: `{ title, color?, status?, areaId?, isSequential?, isFocused?, dueDate?, reviewAt?, supportNotes?, attachments? }`
- `mindwtr_update_project` **(requires `--write`)**
  - Input: `{ id, title?, color?, status?, areaId?, isSequential?, isFocused?, dueDate?, reviewAt?, supportNotes?, attachments? }`
  - `attachments` follows the same rule as `mindwtr_update_task`: link attachments only, the list is the complete set of links, and `null` clears them.
- `mindwtr_delete_project` **(requires `--write`)**
  - Input: `{ id }`
- `mindwtr_add_section` **(requires `--write`)**
  - Input: `{ projectId, title, description?, order?, isCollapsed? }`
- `mindwtr_update_section` **(requires `--write`)**
  - Input: `{ id, title?, description?, order?, isCollapsed? }`
- `mindwtr_delete_section` **(requires `--write`)**
  - Input: `{ id }`
- `mindwtr_add_area` **(requires `--write`)**
  - Input: `{ name, color?, icon? }`
- `mindwtr_update_area` **(requires `--write`)**
  - Input: `{ id, name?, color?, icon? }`
- `mindwtr_delete_area` **(requires `--write`)**
  - Input: `{ id }`
- `mindwtr_add_person` **(requires `--write`)**
  - Input: `{ name, note?, referenceLink? }`
- `mindwtr_update_person` **(requires `--write`)**
  - Input: `{ id, name?, note?, referenceLink? }`
- `mindwtr_rename_person` **(requires `--write`)**
  - Input: `{ id, name, updateTasks? }`
- `mindwtr_delete_person` **(requires `--write`)**
  - Input: `{ id }`

All tools return JSON text payloads with the resulting task, project, section, area, person, or collection payload.

---

## Testing

### Quick smoke test (CLI)

1) Start the server (read‑only):
```bash
bun run mindwtr:mcp -- --db "~/.local/share/mindwtr/mindwtr.db"
```

2) Connect via your MCP client and run:
- `mindwtr_list_tasks` (limit 5)

If you want to test writes, restart with `--write`:
```bash
bun run mindwtr:mcp -- --db "~/.local/share/mindwtr/mindwtr.db" --write
```

Then test:
- `mindwtr_add_task` (quickAdd: "Test task @home /due:tomorrow")
- `mindwtr_complete_task` (use returned task id)
- `mindwtr_update_task` (e.g. set status or dueDate)
- `mindwtr_delete_task` (use returned task id)
- `mindwtr_get_task` (use returned task id)
- `mindwtr_restore_task` (after delete, restore the task)
- `mindwtr_list_projects`
- `mindwtr_get_project` (use returned project id)
- `mindwtr_list_areas`
- `mindwtr_list_people`
- `mindwtr_add_project`
- `mindwtr_update_project`
- `mindwtr_delete_project`
- `mindwtr_add_area`
- `mindwtr_update_area`
- `mindwtr_delete_area`
- `mindwtr_add_person`
- `mindwtr_update_person`
- `mindwtr_rename_person`
- `mindwtr_get_person` (use returned person id)
- `mindwtr_delete_person`
- `mindwtr_list_tasks` with `dueDateFrom`, `dueDateTo`, `sortBy`, `sortOrder`

If the list returns tasks and add/complete works, the server is healthy.

### Stdio JSON-RPC E2E (transport validation)

Use any MCP client or a small script to send:
- `initialize`
- `notifications/initialized`
- `tools/list`
- `tools/call` (e.g. `mindwtr_list_projects` or `mindwtr_list_tasks`)

If these succeed, the stdio transport is working end-to-end.

### Claude Code sanity check

1) Add the server:
```bash
claude mcp add mindwtr -- \
  bun /path/to/Mindwtr/apps/mcp-server/src/cli.ts --db "/path/to/mindwtr.db" --write
```
2) Restart Claude Code, run `/mcp`, and verify **mindwtr** is connected.
3) Ask the model to call:
   - `mindwtr_list_tasks` (limit 5)
   - `mindwtr_add_task` (quickAdd: "Test MCP @home /due:tomorrow")
   - `mindwtr_complete_task` (use returned id)

---

## Safety & Concurrency

- The server uses **SQLite WAL mode**. Read-only tools can run while the desktop app is open.
- Write tools fail fast on SQLite writer locks, then retry the whole Mindwtr write operation. Each retry reloads current data before applying the requested change, so a delayed MCP write does not keep working from a stale pre-lock snapshot.
- Writes are **disabled by default**. Use `--write` to enable edits.
- Write operations go through the shared **@mindwtr/core** store to enforce business rules (both Bun and Node).
- SQL is reserved for read-heavy paths (list/search) where performance matters.
- Do not point a separate container/server deployment at the same local storage or sync data while the desktop app is also writing. That creates independent writers outside the local SQLite coordination path and is unsupported.

---

## Notes

- This MCP server targets the SQLite database used by the desktop app, with mutations routed through `@mindwtr/core`.
- Keep an eye on schema changes across app versions (update queries if needed).
