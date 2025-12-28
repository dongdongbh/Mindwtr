# Local API Server (Automation)

Mindwtr includes an optional local REST API server for scripting and integrations. It reads and writes your local `data.json` directly.

## Start

From the repo root:

```bash
bun install
bun run mindwtr:api -- --port 4317 --host 127.0.0.1
```

Options:

- `--port <n>` (default `4317`)
- `--host <host>` (default `127.0.0.1`)
- `--data <path>` Override the `data.json` location

Environment:

- `MINDWTR_DATA` Override the `data.json` location (if `--data` is omitted)
- `MINDWTR_API_TOKEN` If set, require `Authorization: Bearer <token>`

By default, the API resolves `data.json` using Mindwtr’s platform paths (preferring XDG data on Linux).

## Auth

If `MINDWTR_API_TOKEN` is set, include:

```text
Authorization: Bearer <token>
```

## Endpoints

- `GET /health` → `{ ok: true }`
- `GET /tasks`
  - Query params:
    - `query=<string>` Search query (same operators as in-app search)
    - `status=<inbox|next|waiting|someday|done|archived>`
    - `all=1` Include `done` and `archived`
    - `deleted=1` Include soft-deleted tasks
  - Response: `{ tasks: Task[] }`
- `POST /tasks` → create a task
  - Body: `{ input?: string, title?: string, props?: Partial<Task> }`
  - If `input` is provided, it runs the quick-add parser (`parseQuickAdd`) to derive fields like `dueDate`, `tags`, `contexts`, `projectId`, etc.
  - Response: `{ task: Task }` (201)
- `GET /tasks/:id` → `{ task: Task }`
- `PATCH /tasks/:id` → update a task
  - Body: `Partial<Task>`
  - Uses core update rules (including recurring task rollover via `applyTaskUpdates`)
  - Response: `{ task: Task }`
- `DELETE /tasks/:id` → soft delete
  - Response: `{ ok: true }`
- `POST /tasks/:id/complete` → mark as `done` (handles recurring rollover)
  - Response: `{ task: Task }`
- `POST /tasks/:id/archive` → mark as `archived` (handles recurring rollover)
  - Response: `{ task: Task }`
- `GET /projects` → `{ projects: Project[] }`
- `GET /search?query=<string>` → `{ tasks: Task[], projects: Project[] }`

## Examples

List next actions:

```bash
curl -s 'http://127.0.0.1:4317/tasks?status=next' | jq .
```

Create via quick-add:

```bash
curl -s -X POST 'http://127.0.0.1:4317/tasks' \
  -H 'Content-Type: application/json' \
  -d '{"input":"Call Alice due:tomorrow @phone #errands"}' | jq .
```

Complete a task:

```bash
curl -s -X POST "http://127.0.0.1:4317/tasks/$TASK_ID/complete" | jq .
```

## Security notes

- The server is intended to run on `127.0.0.1` (localhost). Don’t expose it publicly unless you understand the risks.
- If you need remote access, set `MINDWTR_API_TOKEN` and place the server behind an authenticated reverse proxy.
