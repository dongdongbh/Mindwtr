# Plan 059: Preserve restored attachment content authority

> Drift check: git diff --check v1.2.5-rc.2..HEAD

## Status

- Priority P1; effort XS; risk HIGH; category data safety and sync.
- Validated in the requested `v1.2.5-rc.2..HEAD` review range.

## Why

Backup restore refreshed attachment timestamps but kept an older `contentRev`. Even after raising that revision, metadata could converge without replacing the remote blob unless every restored file generation remained pending until its local bytes were proved and uploaded.

## Design

1. Stamp each restored file attachment one content revision above both the backup child and the previous same-id child.
2. Mark every live restored file pending; snapshot legacy hashless bytes before merge, preserve an unresolved pending generation without inheriting the previous hash, and block remote metadata publication while bytes are missing or unreadable.
3. Apply the same immutable hash proof and verified post-merge upload contract to the mobile Cloud and Dropbox loops; missing or unreadable bytes retain the pending generation and perform no remote transfer.
4. Preserve links and tombstones, and cover both merge directions plus transfer cycles that verify the exact remote blob/hash and a no-op second cycle.

## Verification and stop conditions

- Focused backup-transfer tests including prepare/merge/post-merge transfer lifecycles and remote blob verification; focused mobile Cloud/Dropbox production-loop parity tests; full relevant core/mobile suites; core/mobile typecheck and lint; and `git diff --check v1.2.5-rc.2..HEAD`.
- Stop if links, tombstones, missing/unreadable bytes, or unrelated restore fields gain remote mutations. Keep one finding commit after autosquash.
