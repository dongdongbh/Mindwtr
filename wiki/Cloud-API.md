# Cloud API

Mindwtr Cloud exposes a small bearer-token API for sync, task automation, and attachment transfer. It is designed for self-hosted deployments and uses the same token namespace as Cloud Sync.

## Authentication

Send a bearer token on every `/v1/*` request:

```http
Authorization: Bearer <token>
```

Use `MINDWTR_CLOUD_AUTH_TOKENS` or `MINDWTR_CLOUD_AUTH_TOKENS_FILE` in production. `MINDWTR_CLOUD_ALLOW_ANY_TOKEN=true` is only for controlled automation and caps new namespaces with `MINDWTR_CLOUD_ANY_TOKEN_MAX_NAMESPACES`.

## Health

```text
GET /health
```

Returns server health without authentication.

## Snapshot Sync

```text
GET /v1/data
PUT /v1/data
```

`GET /v1/data` returns the authenticated namespace snapshot. If the namespace does not exist and writes are allowed, the server creates an empty snapshot.

`PUT /v1/data` validates the uploaded `AppData`, merges it with the existing namespace using the core sync algorithm, validates the merged result, and writes it back. It is not a forced overwrite.

## Tasks

```text
GET /v1/tasks
POST /v1/tasks
GET /v1/tasks/:id
PATCH /v1/tasks/:id
DELETE /v1/tasks/:id
POST /v1/tasks/:id/complete
POST /v1/tasks/:id/archive
```

List query parameters:

| Parameter | Purpose |
| --- | --- |
| `query` | Case-insensitive text search across task title and metadata. |
| `status` | One task status: `inbox`, `next`, `waiting`, `someday`, `reference`, `done`, or `archived`. |
| `all=1` | Include completed tasks. |
| `deleted=1` | Include soft-deleted tasks. |
| `limit`, `offset` | Page size and start offset. |

Create accepts either `title` or quick-add `input`, plus optional `props`. Patch accepts task fields supported by the cloud validation layer and bumps sync revision metadata.

## Projects, Areas, and Sections

```text
GET /v1/projects
POST /v1/projects
GET /v1/projects/:id
PATCH /v1/projects/:id
DELETE /v1/projects/:id

GET /v1/areas
POST /v1/areas
GET /v1/areas/:id
PATCH /v1/areas/:id
DELETE /v1/areas/:id

GET /v1/sections
POST /v1/sections
GET /v1/sections/:id
PATCH /v1/sections/:id
DELETE /v1/sections/:id
```

All list endpoints accept `limit`, `offset`, and `deleted=1`. Sections also accept `projectId`.

Reference fields must point to live records. A project `areaId` must reference a live area. Use `areaId: null` to clear a project area; `areaId: ""` is invalid. A section `projectId` must reference a live project.

Deleting areas, projects, and sections uses tombstones and server-side repair to keep the snapshot valid for sync.

## Search

```text
GET /v1/search?query=<text>
```

Search returns live tasks and projects in separate arrays. It supports the shared `limit` and `offset` parameters, plus independent cursors:

| Parameter | Purpose |
| --- | --- |
| `taskLimit`, `taskOffset` | Page the task result set. |
| `projectLimit`, `projectOffset` | Page the project result set. |

The response includes `taskTotal`, `projectTotal`, and the effective cursor values.

## Attachments

```text
GET /v1/attachments/:path
PUT /v1/attachments/:path
DELETE /v1/attachments/:path

POST /v1/attachments/orphans
DELETE /v1/attachments/orphans
```

Attachment paths are resolved inside the authenticated token namespace. Uploads enforce the configured byte limit and the core attachment validation rules.

The orphan cleanup endpoint scans the namespace for files no longer referenced by `data.json`. It skips files modified in the last five minutes so an upload racing with a later snapshot write is not removed.

## Related Pages

- [[Cloud Deployment]]
- [[Cloud Sync]]
- [[Sync Algorithm]]
