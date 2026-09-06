# Plan 067: Report a deferred remote write as an outcome, not a sync failure

> Executor: follow step by step; run every verification; STOP on any listed condition. Drift check first: `git diff --stat 992113e77..HEAD -- apps/desktop/src/components/views/settings/useSyncSettings.ts apps/mobile/components/settings/use-sync-settings-transport-actions.ts packages/core/src/sync-run.ts`.

## Status
- Priority P2 · Effort S · Risk LOW · Depends on: none · Category: bug · Planned at `992113e77`, 2026-09-04 (Phase 2 finding BUG-01, review-improve loop 2026-09-04)

## Why this matters
Two devices on one WebDAV or File Sync location routinely end a cycle with a merged, locally persisted result and a deferred remote write (`remoteWriteDeferred: true` or `skipped: 'pendingRemoteWriteBackoff'`) because the other device holds the write; a retry is already scheduled. Pressing "Sync now" then shows a red failure on both platforms. Desktop's copy also claims "Your previous sync settings are still active" although no backend switch happened; mobile throws `new Error(result.error || 'Unknown error')` and shows "Unknown error" or a stale `lastSyncError`. Users retry, re-enter credentials or switch backends in response to a healthy cycle. Ledger B4 (945c11079) fixed only the post-switch branch.

## Current state
- `packages/core/src/sync-run.ts` ~:1779-1789 returns `{ success: true, remoteWriteDeferred: true, error: settings.lastSyncError }`; ~:1682-1687 returns `skipped: 'pendingRemoteWriteBackoff'`.
- `apps/desktop/src/components/views/settings/useSyncSettings.ts` ~:1347-1352: the success branch requires `!result.remoteWriteDeferred && result.skipped !== 'pendingRemoteWriteBackoff'`; both shapes fall to the `else` (~:1386-1404) that toasts `settings.sync.incomplete` unless `committedNewSyncConfiguration`.
- `apps/mobile/components/settings/use-sync-settings-transport-actions.ts` ~:1127-1131 mirrors the exclusions; ~:1167-1168 throws; `sync-settings-screen.tsx` ~:253-257 appends the raw message.
- Existing string: `settings.sync.incompleteAfterSwitch` ("The new sync settings are active, but this sync did not finish. Mindwtr will retry on its own.") added by B4.

## Steps
1. Add one key to `packages/core/src/i18n/locales/en.ts` (e.g. `settings.sync.remoteWriteDeferred`: "Your changes are saved on this device. Another device is writing to the sync location right now; Mindwtr will upload them on its own shortly.") and translate it into zh-Hans, zh-Hant, ja, fa, sv (full parity required; `locale-parity.test.ts` and the new slot/residue guards must stay green).
2. Desktop: before the generic failure `else`, add `else if (result.success && (result.remoteWriteDeferred || result.skipped === 'pendingRemoteWriteBackoff'))` that toasts the new key with tone `info`. Keep the B4 branch and the `{ success: false }` branch unchanged.
3. Mobile: same branch in `use-sync-settings-transport-actions.ts` showing an info toast (the helper the success branch uses) and returning without throwing; `throw new Error(result.error || 'Unknown error')` stays only for `success: false`.
4. Tests: desktop `useSyncSettings.test.ts` — a Sync-now press whose `performSync` resolves `{ success: true, remoteWriteDeferred: true }` shows the new info toast, never `settings.sync.incomplete`; the existing `{ success: false }` case (~:1214) still shows the old copy. Mobile: the nearest test for `use-sync-settings-transport-actions` gets the same two cases. Each must fail before the fix (scratch copy, never git stash).
- Verify: `cd apps/desktop && bun run test -- src/components/views/settings/useSyncSettings.test.ts`; `cd apps/mobile && bun run test -- <mobile test file>`; `bun run --filter @mindwtr/core test -- src/i18n/locale-parity.test.ts`; `bun run i18n:check`; `bun run typecheck:desktop && bun run typecheck:mobile && bun run typecheck:core`.

## Scope
In: the two hooks, their tests, en.ts + five locales. Out: sync-run.ts, the toast helpers, any other settings copy.

## Done criteria
- [ ] both new tests red-then-green; listed commands exit 0; `git diff --check` clean; one commit; unreleased.md note rides the commit (coordinator).

## STOP conditions
- The deferred shapes carry a different flag than described; a sibling toast already fires for deferral (would double-toast); a full-parity locale cannot be translated confidently.
