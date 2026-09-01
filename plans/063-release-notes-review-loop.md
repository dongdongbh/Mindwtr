# Plan 063: Capture review-loop fixes in release notes

> Drift check: git diff --check v1.2.5-rc.2..HEAD

## Status

- Priority P2; effort XS; risk LOW; category release communication.
- Present in the requested `v1.2.5-rc.2..HEAD` review range.

## Why

The unreleased notes omit material sync, archive, self-hosting, AUR transition, review, recurrence, Timeline, capture, and distribution fixes added after v1.2.5.

## Design

1. Lead with the data-safety, read-only archive, Cloud, and AUR outcomes users need to know.
2. Describe the remaining product and release fixes briefly in user-facing language.
3. State that the AUR identity change is manual and keep the documented release boundary intact.

## Verification and stop conditions

- Release-notes governance test, prose checks, and the authoritative drift check.
- Stop if the notes promise automatic migration or expose implementation-only detail without a user outcome. Make one commit only.
