# Plan 062: Preserve the AUR beta package transition

> Drift check: git diff --check v1.2.5-rc.2..HEAD

## Status

- Priority P2; effort M; risk MED; category release compatibility.
- Present in the requested `v1.2.5-rc.2..HEAD` review range.

## Why

Renaming the beta package to `mindwtr-beta-bin` stopped updates and trust audits for existing `mindwtr-bin-beta` installations. AUR helper behavior cannot be assumed to migrate those users from package metadata alone.

## Design

1. Generate, validate, audit, and publish both existing beta identities from each RC and stable release.
2. Keep the new identity canonical and mark the old recipe as a documented compatibility identity.
3. Retire the old identity only after the stated release and time gates, with explicit user notice.

## Verification and stop conditions

- AUR workflow/governance tests, live ownership audit, actionlint, and the authoritative drift check.
- Stop if either existing package is untrusted, initialized over missing history, or published without validation. Make one commit only.
