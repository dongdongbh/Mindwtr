# MCP Server

Mindwtr provides an optional **MCP (Model Context Protocol)** server. This allows you to connect AI agents (like **Claude Desktop**, **Claude Code**, **OpenAI Codex**, or **Gemini CLI**) directly to your local Mindwtr database.

This is a **local stdio** server (no HTTP). MCP clients launch it as a subprocess and talk over JSON‑RPC on stdin/stdout.

---

## Requirements

- **Node.js 18+** (for the MCP client that spawns the server)
- **Bun** (recommended for running/building the server)
- A local Mindwtr database (`mindwtr.db`)

### Default Database Locations

- **Linux:** `~/.local/share/mindwtr/mindwtr.db`
- **macOS:** `~/Library/Application Support/mindwtr/mindwtr.db`
- **Windows:** `%APPDATA%\mindwtr\mindwtr.db`

You can override the database location with:

- `--db /path/to/mindwtr.db`
- Environment variable: `MINDWTR_DB_PATH` or `MINDWTR_DB`

---

## Setup & Configuration

MCP clients run the server as a subprocess. You point them to **the command** and pass arguments.

### Key Arguments

- `--db "/path/to/mindwtr.db"`: Path to your SQLite database.
- `--write`: Enable write operations (add, update, complete, delete). **Without this flag, the server is read-only.**

### 1. Claude Desktop

Add a server entry to your Claude Desktop configuration file.

- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "mindwtr": {
      "command": "bun",
      "args": [
        "/absolute/path/to/Mindwtr/apps/mcp-server/src/index.ts",
        "--db",
        "/home/dd/.local/share/mindwtr/mindwtr.db",
        "--write"
      ]
    }
  }
}
```

_Note: Replace `/absolute/path/to/Mindwtr` and the DB path with your actual paths._

### 2. Claude Code (CLI)

You can add the server via the CLI:

```bash
claude mcp add mindwtr -- \
  bun /path/to/Mindwtr/apps/mcp-server/src/index.ts --db "/path/to/mindwtr.db" --write
```

### 3. Gemini CLI

Gemini CLI uses `settings.json` (User: `~/.gemini/settings.json` or Project: `.gemini/settings.json`).

**Command Line:**

```bash
gemini mcp add mindwtr \
  bun /absolute/path/to/Mindwtr/apps/mcp-server/src/index.ts \
  --db "/path/to/mindwtr.db" --write
```

**Manual Config:**

```json
{
  "mcpServers": {
    "mindwtr": {
      "command": "bun",
      "args": [
        "/absolute/path/to/Mindwtr/apps/mcp-server/src/index.ts",
        "--db",
        "/path/to/mindwtr.db",
        "--write"
      ]
    }
  }
}
```

---

## Running Manually

You usually don't need to run this manually (the MCP client does it), but it's useful for testing.

### From Source (Bun)

```bash
# Read-only
bun run mindwtr:mcp -- --db "/path/to/mindwtr.db"

# With write access
bun run mindwtr:mcp -- --db "/path/to/mindwtr.db" --write
```

### Build & Run (Node)

```bash
# Build
bun run --filter mindwtr-mcp-server build

# Run
node apps/mcp-server/dist/index.js --db "/path/to/mindwtr.db"
```

---

## Migration: tool rename (`mindwtr.*` → `mindwtr_*`)

> **Breaking change** (introduced in this release): all tool names have changed from dot-notation (`mindwtr.list_tasks`) to underscore-notation (`mindwtr_list_tasks`) to comply with MCP client validation rules (e.g. Claude Desktop).

**Old → new mapping:**

| Old name                  | New name                   |
| ------------------------- | -------------------------- |
| `mindwtr.list_tasks`      | `mindwtr_list_tasks`       |
| `mindwtr.list_projects`   | `mindwtr_list_projects`    |
| `mindwtr.get_task`        | `mindwtr_get_task`         |
| `mindwtr.add_task`        | `mindwtr_add_task`         |
| `mindwtr.update_task`     | `mindwtr_update_task`      |
| `mindwtr.complete_task`   | `mindwtr_complete_task`    |
| `mindwtr.delete_task`     | `mindwtr_delete_task`      |
| `mindwtr.restore_task`    | `mindwtr_restore_task`     |

**Upgrade action:** find and replace `mindwtr.` with `mindwtr_` in any MCP client configs, system prompts, scripts, or automations that reference these tool names. No other changes are required.

---

## Available Tools

When connected, the AI agent has access to these tools. By default the server is **read-only**; pass `--write` to enable any write tool.
Only `--write` is supported for write access (no alternate aliases).

| Tool                    | Operation            | Requires `--write` |
| ----------------------- | -------------------- | ------------------ |
| `mindwtr_list_tasks`    | List tasks           | No                 |
| `mindwtr_list_projects` | List projects        | No                 |
| `mindwtr_get_task`      | Fetch one task by ID | No                 |
| `mindwtr_add_task`      | Create task          | Yes                |
| `mindwtr_update_task`   | Update task          | Yes                |
| `mindwtr_complete_task` | Mark done            | Yes                |
| `mindwtr_delete_task`   | Soft-delete task     | Yes                |
| `mindwtr_restore_task`  | Restore task         | Yes                |

### Read Tools

- **`mindwtr_list_tasks`**: List tasks with filters (status, project, date range, search).
- **`mindwtr_list_projects`**: List all projects.
- **`mindwtr_get_task`**: Get details of a specific task by ID.

### Write Tools (Requires `--write`)

- **`mindwtr_add_task`**: Create a new task. Supports natural language `quickAdd` (e.g., "Buy milk @errands /due:tomorrow").
- **`mindwtr_update_task`**: Update an existing task (supports clearing fields with `null`).
- **`mindwtr_complete_task`**: Mark a task as done.
- **`mindwtr_delete_task`**: Soft-delete a task.
- **`mindwtr_restore_task`**: Restore a soft-deleted task.

## Permission Matrix

Use this matrix when deciding whether to run the server in read-only mode or with `--write`.

| Tool                    | Data Access          | Mutation Type       | Read-only Mode | `--write` Mode |
| ----------------------- | -------------------- | ------------------- | -------------- | -------------- |
| `mindwtr_list_tasks`    | Task rows (filtered) | None                | Allowed        | Allowed        |
| `mindwtr_list_projects` | Project rows         | None                | Allowed        | Allowed        |
| `mindwtr_get_task`      | Single task by ID    | None                | Allowed        | Allowed        |
| `mindwtr_add_task`      | Task table           | Insert              | Denied         | Allowed        |
| `mindwtr_update_task`   | Task table           | Update              | Denied         | Allowed        |
| `mindwtr_complete_task` | Task table           | Update status       | Denied         | Allowed        |
| `mindwtr_delete_task`   | Task table           | Soft-delete         | Denied         | Allowed        |
| `mindwtr_restore_task`  | Task table           | Restore soft-delete | Denied         | Allowed        |

Practical guidance:

- Default to read-only for exploration and reporting.
- Enable `--write` only in trusted local environments.
- For agent workflows, prefer explicit confirmation before delete/complete operations.

## Advanced Usage Examples

### 1) Guided Weekly Review

1. `mindwtr_list_tasks` with `status: "waiting"` and `status: "someday"`.
2. Summarize stalled items by project.
3. For selected items, call `mindwtr_update_task` to set `reviewAt`.

### 2) Inbox Triage Session

1. `mindwtr_list_tasks` with `status: "inbox"` and `sortBy: "createdAt"`.
2. For each task, classify with `mindwtr_update_task` (`next`, `waiting`, `reference`, etc.).
3. Add missing metadata (project, contexts, tags) in a second pass.

### 3) Safe Bulk Close Pattern

For potentially destructive automation:

1. Run read phase: list candidate IDs only.
2. Present confirmation summary (count + titles).
3. Execute writes (`complete_task` / `delete_task`) only after explicit user approval.
4. Keep IDs for rollback via `restore_task`.

### 4) Quick Capture with Natural Language

Use `mindwtr_add_task` + `quickAdd`:

```json
{
  "quickAdd": "Follow up with Alex +Hiring @work #ops /due:tomorrow 10am"
}
```

Use this for rapid capture flows where parsing commands is more efficient than setting each field manually.

---

## Tool Reference

All tools return JSON in the `content.text` field. Parse the JSON to get the actual payload.

### `mindwtr_list_tasks`

**Input fields**

- `status`: `inbox | next | waiting | someday | done | archived`
- `projectId`: string
- `includeDeleted`: boolean
- `limit`: number
- `offset`: number
- `search`: string
- `dueDateFrom`: ISO string
- `dueDateTo`: ISO string
- `sortBy`: `updatedAt | createdAt | dueDate | title | priority`
- `sortOrder`: `asc | desc`

**Example**

```json
{
  "status": "next",
  "limit": 20,
  "offset": 0,
  "sortBy": "updatedAt",
  "sortOrder": "desc"
}
```

**Response**

```json
{
  "tasks": [
    {
      "id": "task-uuid",
      "title": "Follow up with design",
      "status": "next",
      "updatedAt": "2026-01-25T03:45:57.246Z"
    }
  ]
}
```

### `mindwtr_list_projects`

**Input fields**

- none

**Response**

```json
{
  "projects": [
    {
      "id": "project-uuid",
      "title": "Mindwtr",
      "status": "active"
    }
  ]
}
```

### `mindwtr_get_task`

**Input fields**

- `id`: string (task UUID)
- `includeDeleted`: boolean (optional)

**Example**

```json
{ "id": "task-uuid" }
```

### `mindwtr_add_task` (write)

**Input fields**

- `title`: string (required if `quickAdd` omitted)
- `quickAdd`: string (required if `title` omitted)
- `status`: `inbox | next | waiting | someday | done | archived`
- `projectId`: string
- `dueDate`: ISO string
- `startTime`: ISO string
- `contexts`: string[]
- `tags`: string[]
- `description`: string
- `priority`: string
- `timeEstimate`: string (e.g. `30m`, `2h`)

**Example**

```json
{
  "quickAdd": "Send invoice +Acme /due:tomorrow 9am #finance"
}
```

### `mindwtr_update_task` (write)

**Input fields**

- `id`: string (task UUID)
- `title`, `status`, `projectId`, `dueDate`, `startTime`, `contexts`, `tags`, `description`, `priority`, `timeEstimate`, `reviewAt`, `isFocusedToday`

**Notes**

- Use `null` to clear fields like `projectId`, `dueDate`, `startTime`, `contexts`, and `tags`.

**Example**

```json
{
  "id": "task-uuid",
  "status": "waiting",
  "reviewAt": "2026-01-27T09:00:00.000Z"
}
```

### `mindwtr_complete_task` (write)

**Input fields**

- `id`: string (task UUID)

### `mindwtr_delete_task` (write)

**Input fields**

- `id`: string (task UUID)

### `mindwtr_restore_task` (write)

**Input fields**

- `id`: string (task UUID)

---

## Output Format Notes

- Tool outputs are JSON strings, not structured MCP values. Your client should parse `content[0].text`.
- Task/project IDs are UUIDs from the local SQLite database.
- Dates are ISO 8601 strings (UTC).

---

## Safety & Notes

- **Concurrency:** The server uses SQLite WAL mode. Writes may fail if the DB is locked; clients are expected to retry.
- **Shared Logic:** Write operations use the shared `@mindwtr/core` library to ensure business rules are enforced.
- **Keep-Alive:** The server stays alive as long as `stdin` is open.

## Troubleshooting

- **"Command not found"**: `mindwtr-mcp` is not a global command. Use `bun run mindwtr:mcp` or the full path to the built script.
- **Client Connection Issues**: Ensure you are NOT using `bun run` as the command in your MCP client config, as it may output extra text. Run `bun` directly on the source file or `node` on the built file.
