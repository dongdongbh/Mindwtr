# Plan 055: Make task-to-section conversion atomic

> Drift check: git diff --stat v1.2.5-rc.2..HEAD -- packages/core/src/store-tasks.ts packages/core/src/store.test.ts packages/core/src/store-helpers.ts

## Status

- Priority P2; effort M; risk HIGH; category store integrity.
- Introduced in 25070f12f; found by the corrected v1.2.5-rc.2..HEAD audit.

## Why

Conversion currently persists section creation, checklist tasks, and source deletion separately. Failure or interleaving leaves partial artifacts; retry can duplicate them.

## Design

1. Add failing tests proving one complete persisted snapshot/notification and no collection change on rejected validation.
2. Validate the live source/project first. In one store mutation construct the section and checklist tasks using authoritative normalization, device revisions, ordering, and timestamps; soft-delete the source in that same snapshot.
3. Call the full-document persistence helper once with complete task/section collections and update derived state through the normal store path.
4. Preserve action results, completed checklist semantics, recoverable source notes/attachments, and UI behavior.

## Verification and stop conditions

- Focused and full core tests, typecheck/lint, exactly one section/task set/tombstone, idempotent repeat, and git diff --check.
- Stop if any entity becomes visible before the complete snapshot or persistence splits. Make one commit only.
