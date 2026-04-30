# Mindwtr Architecture

Mindwtr is a local-first GTD system built as a Bun workspace monorepo. The shared `@mindwtr/core` package owns the data model, persistence behavior, and sync rules; desktop, mobile, cloud, and MCP layers stay thin around that core.

## System shape

- `packages/core`
  Shared domain model, Zustand store, quick-add parsing, recurrence, sync/merge, storage adapters, and shared tests.
- `apps/desktop`
  Tauri + React shell. Uses the shared core store with desktop-specific UI state, native dialogs, filesystem access, and SQLite-backed persistence.
- `apps/mobile`
  Expo + React Native shell. Reuses the core store and sync logic with mobile-specific storage, navigation, notifications, and calendar integrations.
- `apps/cloud`
  Self-hosted sync endpoint. Stores one JSON namespace plus attachments per bearer token and merges incoming app data using the same shared sync semantics.
- `apps/mcp-server`
  Local stdio server for AI tools. Reads and optionally mutates the local SQLite database with explicit `--write` opt-in.

## Data flow

1. UI actions update the shared Zustand store in `packages/core`.
2. The store sanitizes and persists the full app snapshot through a platform storage adapter.
3. Optional sync services read remote state, merge in memory, then write back local and remote snapshots.
4. Derived views are recomputed from canonical store data plus view filters instead of mutating persisted records for presentation.

The design goal is that GTD behavior, merge logic, and validation live once in core, while platform apps handle input, rendering, and OS integration.

## Persistence model

- Desktop and mobile use SQLite as the primary structured store.
- JSON snapshots remain part of the durability and sync story, but as a derived sync/backup representation rather than a second equal local source of truth.
- Attachments are treated separately from structured task/project data.
- Deletes are soft by default using `deletedAt` tombstones so sync can converge safely across devices.

The SQLite<->JSON bridge contract is recorded in [ADR 0009](./adr/0009-sqlite-json-sync-bridge.md).

Mindwtr prefers explicit repair and merge logic in the app layer over hard database-only assumptions. That is why sync-sensitive relationships are normalized and repaired by shared code instead of depending purely on foreign-key enforcement.

## Sync model

Sync is optional and backend-agnostic. Supported backends include file sync, WebDAV, Dropbox in supported builds, and the self-hosted cloud server.

Important properties:

- Merge is item-based, not whole-file overwrite.
- Revisions and timestamps are both used for conflict resolution.
- Tombstones prevent deleted records from being silently resurrected.
- Attachments are merged and transferred separately from the main JSON payload.

The detailed algorithm, edge cases, and tie-break rules are documented in the wiki:

- [Wiki: Architecture](https://github.com/dongdongbh/Mindwtr/wiki/Architecture)
- [Wiki: Sync Algorithm](https://github.com/dongdongbh/Mindwtr/wiki/Sync-Algorithm)
- [Wiki: Data and Sync](https://github.com/dongdongbh/Mindwtr/wiki/Data-and-Sync)
- [Wiki: Performance Guide](https://github.com/dongdongbh/Mindwtr/wiki/Performance-Guide)

## Boundaries and responsibilities

- Core decides what data means.
- Desktop/mobile decide how users interact with that data.
- Cloud decides how remote snapshots are stored and validated.
- MCP decides how external AI tools can safely read or write local data.

That separation keeps product behavior consistent across platforms and makes most regression tests possible in shared code instead of duplicating logic per app.
