# Plan 075: Split the CI "Core Package" job so unit tests are not gated behind unrelated checks

> Executor: drift check `git diff --stat 66bcc1a4c..HEAD -- .github/workflows/ci.yml scripts/ci/validate-performance-gate.test.js scripts/ci/validate-native-platform-ci.test.js`.

## Status
- Priority P3 · Effort S · Risk LOW · Category: dx · Planned at `66bcc1a4c`, 2026-09-04 (Phase 2 DX-01)

## Why
`.github/workflows/ci.yml` ~:21-115, one job "Core Package", runs in order: TypeScript check, `bun run test:perf` (which is NOT core-only: it also runs the desktop ListView/TimelineView and mobile large-store budgets), locale parity, governance, README parity, store image assets, AppStream locales, workflow JSON newlines, package-lock sync, EAS CLI lock, Play listing, changelog length, App Store listing, App Intents, Apple plists, and only then "Run unit tests" (~:101). Steps stop at the first failure, so a wall-clock perf flake hides the unit-test result and the fix loop is a full re-run; cross-package budgets are attributed to "Core".

## Steps
1. Keep "TypeScript check" and "Run unit tests" in the `core` job. Move the metadata/governance steps into a new `governance` job and `test:perf` into a new `performance` job (same runner, same setup steps: copy the checkout/bun setup/install block; keep any `needs:`/concurrency the file uses). Keep every step's command identical.
2. Update `scripts/ci/validate-performance-gate.test.js` (~:20 asserts exactly one `run: bun run test:perf` line — point it at the new job) and any other governance test that pins job names (`rg -n "Core Package|core:" scripts/ci/*.test.js`).
- Verify: `bun run test:governance` exit 0; `node -e "require('js-yaml')"` is NOT available — validate YAML by `bunx yaml` or by reading the workflow governance test output; `git diff --check`.

## STOP conditions
- A step depends on an artifact produced by a previous step in the same job (then keep those together and say so); branch-protection required-check names are referenced elsewhere (search `.github` and docs for "Core Package").
