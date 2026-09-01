# Plan 057: Expose desktop priority without relying on color

> Drift check: git diff --stat v1.2.5-rc.2..HEAD -- apps/desktop/src/components/Task/TaskItemDisplay.tsx apps/desktop/src/components/Task/TaskItemDisplay.test.tsx

## Status

- Priority P2; effort S; risk LOW; category accessibility.
- Introduced in 3ab7cca9d; found by the corrected v1.2.5-rc.2..HEAD audit.

## Why

With compact metadata disabled, the text badge disappears while the strip is aria-hidden and the collapsed row name omits priority. Priority becomes color-only.

## Design

1. Add failing tests with compactMetaEnabled false for an enabled priority and the feature-disabled path.
2. Include localized priority text in the collapsed row accessible name or an associated screen-reader-only description exactly when priority is present/enabled. Avoid duplicate announcements when visible metadata is on.
3. Keep the decorative strip aria-hidden and preserve title/toggle wording and mobile behavior.

## Verification and stop conditions

- Focused TaskItemDisplay tests, desktop typecheck/lint, no priority term when disabled/unset, and git diff --check.
- Stop if priority is announced twice or untranslated enum values reach the name. Make one commit only.
