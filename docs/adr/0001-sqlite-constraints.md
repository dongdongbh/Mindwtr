# ADR 0001: SQLite constraints and sync soft-deletes

Date: 2026-01-30
Status: Accepted

## Context

Mindwtr is offline-first and uses soft-delete tombstones so that deletions can be synced safely across devices. The local SQLite schema has relationships between tasks, projects, sections, and areas. We still want SQLite to protect basic referential integrity for live records, but we also need sync-aware repair logic for soft-deletes, tombstones, and legacy payloads.

## Decision

We keep SQLite foreign key constraints **on**.

- `tasks.projectId`, `tasks.sectionId`, `tasks.areaId`, and `projects.areaId` use `ON DELETE SET NULL`.
- `sections.projectId` uses `ON DELETE CASCADE`.
- Soft-delete, tombstone retention, and cross-device reference repair still live in shared application logic.

This gives us database-level protection for hard deletes while preserving sync-aware merge and repair behavior in the core layer.

## Consequences

- Hard deletes can still cascade at the SQLite layer, especially for project -> section cleanup.
- Sync merges remain responsible for tombstones, ambiguous delete-vs-live resolution, and orphan reference repair after merge/import.
- Data validation still needs to happen in the core store, sync normalization, and import paths.
