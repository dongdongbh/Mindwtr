# Plan 050: Reset the unreleased release-notes boundary

> Drift check: git diff --stat v1.2.5-rc.2..HEAD -- docs/release-notes scripts/ci/validate-release-notes-index.test.js

## Status

- Priority P2; effort S; risk LOW; category release integrity.
- Introduced in 99939daf1; found by the corrected v1.2.5-rc.2..HEAD audit.

## Why

The unreleased accumulator still names v1.2.1 and retains stable 1.2.5 material, so the next release can duplicate or misclassify published notes.

## Design

1. Add a failing governance test deriving the latest stable version from indexed release-note files and requiring the unreleased introduction to name it.
2. Rebuild the accumulator with only entries introduced after v1.2.5, preserving their wording and sections; update the introduction to v1.2.5.
3. Do not edit published notes or manufacture claims.

## Verification and stop conditions

- Focused and full governance; history inspection for every retained bullet; git diff --check.
- Stop rather than guess if release ownership cannot be established. Make one commit only.
