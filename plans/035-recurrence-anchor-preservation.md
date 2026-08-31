# Preserve recurrence anchors through task-draft saves

## Problem

`taskDraftToUpdatePatch` rebuilds a recurrence value from the editor-facing rule, strategy, and RRULE fields. A save that changes only an unrelated field therefore omits the stored `anchorDay`, `startAnchorDay`, `dueAnchorDay`, and `reviewAnchorDay` values. Monthly and yearly series use those internal anchors to recover from shortened months, so the next occurrence can drift after an ordinary edit.

## Evidence

- `packages/core/src/task-draft.ts` constructs a new recurrence object instead of carrying forward the existing series anchors.
- The task draft intentionally exposes only user-editable recurrence fields, so the anchor values cannot round-trip through `TaskDraft` itself.
- Core recurrence generation reads the stored anchors when advancing monthly and yearly dates.

## Desired behavior

When the draft keeps the stored recurrence rule, serializing it preserves every existing date-anchor field. Intentionally removing recurrence still removes the recurrence value, and changing to a different rule does not attach stale anchors to the new schedule.

## Implementation

1. Add a focused core regression test covering a title-only save of a recurrence with legacy and field-specific anchors.
2. At the shared task-draft serialization seam, copy anchor fields from the stored recurrence only when the draft and stored rule match.
3. Keep recurrence removal and rule changes unchanged.

## Verification

- Run `packages/core/src/task-draft.test.ts` red before the fix and green after it.
- Run the core typecheck and the full core test suite.

## Non-goals

- Changing occurrence generation or month-end clamping.
- Exposing internal anchors in either editor UI.
- Preserving anchors when the user changes the recurrence rule.

## Risks and rollback

The change is limited to recurrence serialization. A rollback is the single finding commit; existing stored series are untouched until a user saves them.
