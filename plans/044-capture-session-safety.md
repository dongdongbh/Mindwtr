# Plan 044: Make quick-capture submission session-safe

> Drift check: `git diff --stat 243827b93..HEAD -- packages/core/src/capture-session.ts apps/desktop/src/components/QuickAddModal.tsx apps/mobile/components/quick-capture-sheet.tsx`

## Status

- **Priority**: P1 · **Effort**: M · **Risk**: MED (capture/write and modal lifecycle boundary) · **Depends on**: none · **Category**: integrity and accessibility
- **Planned at**: `243827b93`, 2026-08-31

## Why

Desktop quick capture has no single-flight guard, so two save gestures can create the same task twice. On both platforms, an asynchronous save can resolve after its sheet was closed and reopened, then close or clear the newer draft. Mobile's ref-only guard prevents a duplicate write but is neither session-aware nor reflected in button or dismissal state.

## Design

- Add a small core `CaptureSessionCoordinator` that owns session generations, one in-flight submission per generation, explicit invalidation, and stale-result checks. It must not know about React or navigation.
- Begin a new generation on every open request. Capture the generation before awaiting a write. Only a result from the current generation may clear, close, highlight, or navigate.
- Keep the existing capture transaction as the write boundary. Platform adapters own reactive busy state and disable save and dismissal controls while the current session is submitting.
- Apply the same policy to single and bulk text capture. Audio capture retains its existing lifecycle, but user dismissal still uses the current session guard.

## Implementation

1. Add red core tests for single-flight, invalidation, reopening, and stale completion.
2. Add a deferred desktop test proving double-submit writes once and the active modal cannot dismiss during that write.
3. Add mobile tests proving a stale result cannot close/reset a reopened draft and that busy/disabled state is accessible.
4. Implement the core coordinator and export it through the core barrel.
5. Integrate desktop and mobile adapters, including bulk paths, while preserving add-another and save-and-edit behavior.

## Verification

- Core `capture-session` tests.
- Desktop `QuickAddModal.test.tsx`.
- Mobile `quick-capture-sheet.save.test.tsx` and body modal tests.
- Core, desktop, and mobile typecheck gates.

## Non-goals and rollback

- No cancellation of a store write already handed to persistence.
- No change to quick-add parsing, capture defaults, or navigation destinations.
- The commit is independently revertible; rollback restores the former platform-local guards.

## Stop conditions

- Stop if the coordinator would need to own UI state or store writes instead of session identity.
- Stop if disabling dismissal would strand a failed request; all completion paths must release the current busy state.
