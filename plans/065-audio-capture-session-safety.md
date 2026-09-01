# Plan 065: Make audio capture submissions session-safe

> Drift check: `git diff --check v1.2.5-rc.2..HEAD`

## Status

- Priority P1; effort M; risk HIGH; category product integrity.
- Closure finding after text quick capture gained session ownership while desktop and mobile audio saves kept an independent async lifecycle.

## Why

Stopping audio starts a chain of recorder shutdown, attachment preparation, task creation, and optional transcription. Today that chain can outlive its capture surface: capture A can be dismissed, capture B can open, and A can then create a task and close or clear B.

## Design

1. Acquire the existing `CaptureSessionCoordinator` submission lease before an audio save begins, just as text capture does.
2. Recheck ownership after async preparation and before task creation, notifications, close, and error UI. A stale completion must not mutate a newer capture session.
3. Treat audio processing as the capture surface's busy state. Disable close, backdrop, save, and editable controls while the current audio submission is non-abortable, with an announced processing status.
4. Reset visual busy state when a new capture session opens, while a stale completion is forbidden from clearing the newer session's state.
5. Keep explicit cancellation available while actively recording; once save/processing starts, block dismissal because recorder and persistence work are not safely abortable.

## Verification

- Desktop Quick Add and core capture-session regressions for busy dismissal and stale A / reopened B ownership.
- Mobile audio-hook and quick-capture-sheet regressions with deferred audio preparation and a reopened capture.
- Desktop and mobile typechecks plus changed-file lint.
- `git diff --check v1.2.5-rc.2..HEAD` and a clean worktree after the single finding commit.

## Non-goals and stop conditions

- Do not alter speech-to-text parsing, provider selection, attachment retention settings, or recording backends.
- Do not make background transcription hold the capture sheet open after its task is safely created.
- Stop if normal text capture, active-recording cancel, or Add another semantics regress.
