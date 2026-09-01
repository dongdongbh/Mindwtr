# Plan 058: Restore RC.2 range diff hygiene

> Drift check: git diff --check v1.2.5-rc.2..HEAD

## Status

- Priority P3; effort XS; risk LOW; category repository hygiene.
- Present in the requested `v1.2.5-rc.2..HEAD` review range.

## Why

One trailing space in the mobile Inbox flow makes the authoritative range fail `git diff --check`, obscuring later patch-quality regressions.

## Design

1. Remove only the trailing space; do not change rendered text or behavior.
2. Re-run the exact RC.2 range check and the changed-file lint.

## Verification and stop conditions

- `git diff --check v1.2.5-rc.2..HEAD` and changed-file lint.
- Stop if the edit changes JSX structure or visible copy. Make one commit only.
