# Plan 054: Preserve default-on GTD settings through RC.2 peers

> Drift check: git diff --stat v1.2.5-rc.2..HEAD -- packages/core/src/settings-options.ts packages/core/src/sync-helpers.ts packages/core/src/*settings*test.ts

## Status

- Priority P2; effort S; risk HIGH; category mixed-fleet sync.
- Introduced in 48fb3f179; found by the corrected v1.2.5-rc.2..HEAD audit.

## Why

Current clients treat absent syncPreferences.gtd as enabled but upload an empty preference object. Materializing true without advancing its whole-map preference timestamp still loses to a newer RC.2 preference edit, so current to RC.2 to current can silently discard customized GTD values.

## Design

1. Add the exact failing mixed-version round trip through RC.2's whole-map preference merge and sanitizer, and cover explicit false.
2. When a remote snapshot has GTD effectively enabled by the current default, serialize syncPreferences.gtd true and advance its wire-only preference timestamp one millisecond past the latest preference/GTD generation, with a deterministic epoch tick when both are absent. Do not mutate the local document merely to materialize the default.
3. Keep explicit false authoritative, upload no GTD fields in that case, and leave every other opt-in group/timestamp unchanged.

## Verification and stop conditions

- Focused sanitizer/merge tests, full core suite, two-round RC.2 convergence of a non-default value, no-timestamp compatibility, and git diff --check.
- Stop if explicit false changes, local state mutates, or another group broadens. Make one commit only.
