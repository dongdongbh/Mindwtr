# Plan 064: Finish the archived-project read-only surface

> Drift check: `git diff --check v1.2.5-rc.2..HEAD`

## Status

- Priority P1; effort M; risk HIGH; category product integrity.
- Closure finding after Plan 056 made task rows read-only but left project-detail writers active.
- Residual closure pass preserves section history and closes delayed mobile transcription, desktop quick-area, and task-row prompt writers.

## Why

An archived project is a historical view until the user explicitly reactivates it. Desktop and mobile still expose project title, metadata, notes, attachments, dates, sorting, and section writers. A delayed blur, picker, or attachment import can also settle after the project becomes archived.

## Design

1. Use the existing desktop `ProjectWorkspace` and mobile `ProjectDetailModal` plus their notes/attachment hooks as the behavior-visible test seams.
2. Derive one archived-project guard at each workspace boundary. Disable project-content controls with a Reactivate recovery hint while preserving navigation, inspection, attachment opening, duplication, and Reactivate.
3. Guard callbacks as well as controls so stale blur, picker, confirmation, and attachment-import completions cannot write after an active-to-archived transition.
4. Keep section collapse and notes inspection local in an archived view; never persist those view-only actions. Continue to gate every task-row, bulk, drag, and section mutation.
5. Discard uncommitted project-detail drafts when the project becomes read-only rather than presenting them as saved history.
6. Resolve task routes and capture returns from the live all-task set. Archived task rows remain pressable for full notes, checklist, and attachment inspection; the shared task editor switches in place to a clearly labeled read-only View surface, and both its save adapter and nested actions recheck current ownership before writing.
7. Resolve mobile area/tag picker callbacks against the live all-project set at selection, clear, and creation boundaries. A picker opened while active must dismiss without writing if sync archives or deletes the project before its delayed native callback returns.
8. Keep normal active-project section selectors unchanged. Archived workspaces alone may read project-archive section tombstones from the authoritative all-section collection, and only when the archive provenance proves the section was visible when the project was archived.
9. Treat mobile Retry transcription as an owned async session. Recheck the current modal, task, mutation capability, and live project after every await and immediately before any task/draft update; a reused modal must not receive the prior task's result.
10. Capture the desktop quick-area target before creation, then resolve it from the live all-project collection after the await and immediately before assignment. The new area may remain, but an archived/deleted target project must not change.
11. On a desktop task's transition to archived/read-only, close Waiting, completion-time, and project-next-action prompts. Independently revalidate the current task/project and prompt owner inside every confirm path and after async boundaries so stale callbacks cannot write or close a newer prompt.

## Verification

- Focused desktop ProjectWorkspace/project-detail tests and mobile ProjectDetail/notes/attachment tests.
- Mobile regressions for direct archived task routes, capture-return inspection, active-to-archived editor transitions, delayed save callbacks, read-only row inspection, and delayed area/tag picker callbacks with zero writes.
- Real archive fixtures for core, desktop, and mobile section-title/notes/grouping resolution without tombstone mutation or resurrection.
- Mobile Retry transcription races (archive during transcription and modal reuse) plus desktop quick-area and all three task-row prompt races, asserting zero task/project writes or new tasks after ownership is lost.
- Desktop and mobile typechecks plus changed-file lint.
- `git diff --check v1.2.5-rc.2..HEAD` and a clean worktree after the single finding commit.

## Non-goals and stop conditions

- Do not change archive/reactivate persistence semantics or attachment download bookkeeping needed to view a file.
- Do not add a new synced field, setting, or confirmation.
- Stop if Reactivate, navigation, content inspection, or duplication becomes unavailable.
