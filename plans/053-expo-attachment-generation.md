# Plan 053: Fail closed on unsafe Expo Go attachment replacement

> Drift check: git diff --stat v1.2.5-rc.2..HEAD -- apps/mobile/lib/attachment-sync-backends/common.ts apps/mobile/lib/attachment-sync.test.ts packages/core/src/attachment-transfer.ts

## Status

- Priority P1; effort S; risk HIGH; category data safety.
- Introduced in 102cdb8f7; found by the corrected v1.2.5-rc.2..HEAD audit.

## Why

Expo Go cannot atomically replace a checked generation or create a first generation without replacement. A concurrent local edit or creation can be erased by either JavaScript fallback.

## Design

1. Add failing present- and absent-generation Expo Go tests proving the target is never deleted/replaced and the staged generation remains recoverable.
2. If the native generation-bound installer is unavailable, fail closed for every expectation and return the normal conflict with the stage preserved.
3. Do not emulate atomic replacement or create-no-replace with more checks; JavaScript cannot close either race.

## Verification and stop conditions

- Mobile attachment tests, mobile typecheck/lint, core attachment-transfer tests, and git diff --check.
- Stop if any fallback can delete a present target. Make one commit only.
