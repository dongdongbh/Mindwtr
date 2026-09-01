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
6. Give recording startup its own synchronous owner token tied to the current capture session before configuration, permission, model, or recorder acquisition begins. Serialize shared audio-mode and backend operations across sheet unmounts, recheck ownership after every await, and release an acquired stale session-owned recorder before the next session may start.
7. Invalidating or reopening a capture drops only the old start owner's continuations. Stale success, error, `finally`, and auto-stop setup must not record, report into, clear busy state for, or save through the newer capture.
8. Keep acquired and active recorder ownership explicit through handoff and teardown. If ownership changes after acquisition, or the owning component unmounts, enqueue stop/release cleanup before a later capture can acquire the shared device.
9. Delete temporary Expo audio only on stale, canceled, or unmounted ownership paths; a valid current session that adopts and saves the recording keeps its verified file for attachment/transcription handling.
10. Keep the stopped submission's exact raw and managed-cache files under its lease until a task adopts them. Give app-authored capture files UUID-qualified names so a same-second reopened session cannot reuse the stale path. A stale save deletes only that abandoned set, and every Whisper model resolution uses its capture/effect lease before persisting speech settings.

## Verification

- Desktop Quick Add and core capture-session regressions for busy dismissal and stale A / reopened B ownership.
- Mobile audio-hook and quick-capture-sheet regressions with deferred audio preparation and a reopened capture.
- Desktop and mobile deferred-start A / dismiss / B regressions covering stale success, error, busy-finally ownership, recorder cleanup ordering, and desktop auto-save timeout installation.
- Desktop and mobile stopped-save A / reopened B regressions covering exact raw/cache cleanup, preservation of adopted captures, and stale speech-setting writes.
- Desktop and mobile typechecks plus changed-file lint.
- `git diff --check v1.2.5-rc.2..HEAD` and a clean worktree after the single finding commit.

## Non-goals and stop conditions

- Do not alter speech-to-text parsing, provider selection, attachment retention settings, or recording backends.
- Do not make background transcription hold the capture sheet open after its task is safely created.
- Stop if normal text capture, active-recording cancel, or Add another semantics regress.
