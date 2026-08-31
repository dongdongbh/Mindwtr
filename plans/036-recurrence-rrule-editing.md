# Preserve RRULE metadata across recurrence edits

## Problem

Desktop and mobile each rebuild an RRULE locally when one visible recurrence control changes. Both paths carry a subset of parsed fields, but omit `WKST` and extension tokens. Editing an interval, weekday, or end condition can therefore change a biweekly schedule's week boundary or strip stable series metadata.

## Evidence

- `TaskItemFieldRenderer` and `TaskEditScheduleField` contain parallel RRULE reconstruction helpers.
- Both call `buildRRuleString` without the parsed `weekStart` value.
- `parseRRuleString` and recurrence generation already support `WKST`, and stored RRULE text can contain extension tokens not represented by editor controls.

## Desired behavior

An editor action changes only the fields it explicitly overrides. Weekly `WKST` and all unrecognized key/value tokens survive. Explicitly clearing a supported field still removes it. Desktop and mobile use one core implementation.

## Implementation

1. Add core red tests for changing one RRULE field while retaining `WKST` and extension tokens, plus explicit field clearing.
2. Add a core `editRRuleString` seam that distinguishes absent overrides from explicit `undefined`, rebuilds supported tokens canonically, and appends untouched extension tokens.
3. Use that seam from both recurrence editors and remove their duplicate parse-and-rebuild logic.
4. Ensure synthesized editor RRULEs include a top-level stored `weekStart`.
5. Extend desktop and mobile interaction tests with a weekly `WKST` and extension token.

## Verification

- Run recurrence core tests red before the helper and green afterward.
- Run the desktop and mobile recurrence field tests red before integration and green afterward.
- Run core, desktop, and mobile typechecks.

## Non-goals

- Adding a UI for choosing the first weekday.
- Supporting new recurrence frequencies or RRULE grammar.
- Reordering or interpreting unknown extension tokens.

## Risks and rollback

Canonical supported-token ordering may change after an edit, but recurrence meaning is preserved. Unknown key/value tokens keep their original text and relative order. The finding is isolated in one commit for rollback.
