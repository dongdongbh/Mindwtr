# Local API Server

Mindwtr includes an optional local REST API server for scripting and integrations. On desktop-compatible paths it keeps `mindwtr.db` and `data.json` in sync so automation changes are visible both before and after the app starts.

---

## Quick Start

From the repo root:

```bash
bun install
bun run mindwtr:api -- --port 4317 --host 127.0.0.1
```

### Options

| Option          | Default          | Description                 |
| --------------- | ---------------- | --------------------------- |
| `--port <n>`    | `4317`           | Server port                 |
| `--host <host>` | `127.0.0.1`      | Bind address                |
| `--data <path>` | Platform default | Override data.json location |
| `--db <path>`   | Platform default | Override mindwtr.db location |

### Environment Variables

| Variable            | Description                                          |
| ------------------- | ---------------------------------------------------- |
| `MINDWTR_DATA`      | Override data.json location (if `--data` is omitted) |
| `MINDWTR_DB_PATH`   | Override mindwtr.db location (if `--db` is omitted)  |
| `MINDWTR_API_TOKEN` | If set, require `Authorization: Bearer <token>`      |

By default, the API resolves both `data.json` and `mindwtr.db` using Mindwtr's platform paths (preferring XDG data on Linux).

---

## Authentication

If `MINDWTR_API_TOKEN` is set, include:

```
Authorization: Bearer <token>
```

---

## Endpoints

| Method   | Endpoint              | Description                   |
| -------- | --------------------- | ----------------------------- |
| `GET`    | `/health`             | Health check → `{ ok: true }` |
| `GET`    | `/tasks`              | List tasks                    |
| `GET`    | `/tasks?status=next`  | Filter by status              |
| `GET`    | `/tasks?query=@work`  | Search tasks                  |
| `GET`    | `/tasks?all=1`        | Include done/archived         |
| `GET`    | `/tasks?deleted=1`    | Include soft-deleted          |
| `POST`   | `/tasks`              | Create task                   |
| `GET`    | `/tasks/:id`          | Get single task               |
| `PATCH`  | `/tasks/:id`          | Update task                   |
| `DELETE` | `/tasks/:id`          | Soft delete task              |
| `POST`   | `/tasks/:id/complete` | Mark as done                  |
| `POST`   | `/tasks/:id/archive`  | Mark as archived              |
| `POST`   | `/tasks/:id/restore`  | Restore a soft-deleted task   |
| `GET`    | `/projects`           | List projects                 |
| `GET`    | `/areas`              | List areas                    |
| `GET`    | `/v1/areas`           | Compatibility alias for areas |
| `GET`    | `/search?query=...`   | Search tasks + projects       |

### Response Shapes

**Task (partial)**
```json
{
  "id": "uuid",
  "title": "Task title",
  "status": "inbox",
  "projectId": "uuid",
  "dueDate": "2026-01-25T12:00:00.000Z",
  "tags": ["#work"],
  "contexts": ["@email"],
  "createdAt": "2026-01-25T10:00:00.000Z",
  "updatedAt": "2026-01-25T10:00:00.000Z",
  "deletedAt": null
}
```

**Project (partial)**
```json
{
  "id": "uuid",
  "title": "Project name",
  "status": "active",
  "color": "#94a3b8",
  "createdAt": "2026-01-25T10:00:00.000Z",
  "updatedAt": "2026-01-25T10:00:00.000Z",
  "deletedAt": null
}
```

**Area**
```json
{
  "id": "uuid",
  "name": "Area name",
  "color": "#94a3b8",
  "icon": "briefcase",
  "order": 0,
  "createdAt": "2026-01-25T10:00:00.000Z",
  "updatedAt": "2026-01-25T10:00:00.000Z"
}
```

### Create Task Body

```json
{
  "input": "Call Alice due:tomorrow @phone #errands",
  "title": "Alternative title",
  "props": { "status": "next" }
}
```

If `input` is provided, it runs the quick-add parser (`parseQuickAdd`) to derive fields like `dueDate`, `tags`, `contexts`, `projectId`, etc.

---

## Examples

**List next actions:**

```bash
curl -s 'http://127.0.0.1:4317/tasks?status=next' | jq .
```

**Create via quick-add:**

```bash
curl -s -X POST 'http://127.0.0.1:4317/tasks' \
  -H 'Content-Type: application/json' \
  -d '{"input":"Call Alice due:tomorrow @phone #errands"}' | jq .
```

**Complete a task:**

```bash
curl -s -X POST "http://127.0.0.1:4317/tasks/$TASK_ID/complete" | jq .
```

---

## CLI Tool

A simpler command-line interface is also available:

```bash
# Add a task
bun mindwtr:cli -- add "Call mom @phone #family"

# List active tasks
bun mindwtr:cli -- list

# List with filters
bun mindwtr:cli -- list --status next --query "due:<=7d"

# Read or update a task
bun mindwtr:cli -- get <taskId>
bun mindwtr:cli -- update <taskId> '{"status":"next"}'

# Complete a task
bun mindwtr:cli -- complete <taskId>

# Archive, delete, or restore
bun mindwtr:cli -- archive <taskId>
bun mindwtr:cli -- delete <taskId>
bun mindwtr:cli -- restore <taskId>

# Search
bun mindwtr:cli -- search "@work"

# List projects
bun mindwtr:cli -- projects
```

### CLI Reference

| Command      | Example                                      | Notes                                |
| ------------ | -------------------------------------------- | ------------------------------------ |
| `add`        | `mindwtr:cli -- add "Call mom @phone"`       | Uses quick-add parsing               |
| `list`       | `mindwtr:cli -- list --status next`          | Supports `--all`, `--deleted`, `--query` |
| `get`        | `mindwtr:cli -- get <taskId>`                | Prints full task JSON                |
| `update`     | `mindwtr:cli -- update <taskId> '{"status":"next"}'` | Applies a JSON patch         |
| `search`     | `mindwtr:cli -- search "@work due:<=7d"`     | Searches tasks/projects              |
| `complete`   | `mindwtr:cli -- complete <taskId>`           | Marks task as done                   |
| `archive`    | `mindwtr:cli -- archive <taskId>`            | Marks task as archived               |
| `delete`     | `mindwtr:cli -- delete <taskId>`             | Soft-deletes task                    |
| `restore`    | `mindwtr:cli -- restore <taskId>`            | Restores a deleted task              |
| `projects`   | `mindwtr:cli -- projects`                    | Lists active projects                |

---

## Security Notes

- The server is intended to run on `127.0.0.1` (localhost). Don't expose it publicly unless you understand the risks.
- If you need remote access, set `MINDWTR_API_TOKEN` and place the server behind an authenticated reverse proxy.

---

## See Also

- [[Developer Guide]]
- [[Cloud Sync]]
