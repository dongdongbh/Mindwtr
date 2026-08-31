# Submit only changed task-draft fields

## Problem

The desktop editor serializes every field in its opening draft when saving. If sync, another task surface, or an automation updates a different field while the editor remains open, the full draft patch writes the stale opening value back over that newer change. Mobile already narrows its patch, but the logic and value comparison live in a mobile adapter instead of the shared draft module.

## Evidence

- `useTaskItemSubmit` calls the full `taskDraftToUpdatePatch` serializer.
- `useTaskItemEditState` resets a draft when editing starts but does not retain that opening task as the conflict baseline.
- `task-edit-draft-adapter.ts` independently builds a normalized baseline patch and deletes unchanged keys.

## Desired behavior

Saving writes only fields changed from the task snapshot that opened the edit session. Concurrent changes to untouched fields remain absent from the patch. Explicit clears, status overrides, attachment edits, and container exclusivity still serialize correctly. Desktop and mobile share one core narrowing implementation.

## Implementation

1. Add core red tests for a one-field draft edit, explicit clears, and unchanged normalized fields.
2. Add `taskDraftToChangedUpdatePatch` beside the full serializer. It compares a serialized draft with a serialized baseline and retains explicit container clears.
3. Replace the mobile adapter's local narrowing loop with the core function.
4. Capture the desktop task snapshot whenever editing resets, pass it to submit, and use the changed-only serializer.
5. Add a desktop hook test where the live task changes after the draft opens and assert that only the user's field is submitted.

## Verification

- Run core task-draft tests red before implementation and green afterward.
- Run mobile adapter and desktop submit-hook tests.
- Run core, desktop, and mobile typechecks and the affected lint gates.

## Non-goals

- Automatically merging two edits to the same field.
- Adding conflict UI or changing sync conflict resolution.
- Moving checklist or attachment lifecycle ownership into `TaskDraft`.

## Risks and rollback

The main risk is accidentally dropping an intentional clear because `undefined` also represents absence. Tests assert key presence for clears and overrides. The finding is isolated in one commit for rollback.
