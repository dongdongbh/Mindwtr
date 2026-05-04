# ADR 0012: Area Soft-Delete Cascade

Date: 2026-05-04
Status: Accepted

## Context

Areas can own projects, sections, and tasks. A hard delete or UI-only filter is not enough for local-first sync: another device may still hold children that reference the deleted area, or it may restore an area from an older snapshot.

Without a sync-level cascade, restored children can keep dangling `areaId` or stale `areaTitle` values. That creates confusing restores and can repeatedly trigger repair revisions.

## Decision

Mindwtr treats area deletion as a soft-delete cascade:

1. Deleting an area stamps tombstones on the area and its child projects, sections, and tasks.
2. Restoring an area restores children only when their tombstone belongs to the same cascade timestamp.
3. Children deleted independently keep their own tombstones and are not restored by the area restore.
4. Sync reference repair also runs on tombstones, so stale `areaId` and `areaTitle` values are cleaned before any later restore.

## Consequences

- Area deletes converge across devices without hard-deleting user data immediately.
- Restores are safer because children do not reappear with dangling area references.
- Sync repair may stamp tombstoned children with `revBy: "sync-repair"`; this is intentional local-first metadata, not visible user content.
- Future hierarchy changes should preserve cascade timestamps or introduce an equivalent restore discriminator.
