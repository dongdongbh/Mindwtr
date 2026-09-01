# Plan 052: Preserve RC identity in Docker PWA builds

> Drift check: git diff --stat v1.2.5-rc.2..HEAD -- docker/app .github/workflows apps/desktop/src/components/views/settings scripts/ci

## Status

- Priority P2; effort S; risk MED; category release integrity.
- Introduced in e3679b9ee; found by the corrected v1.2.5-rc.2..HEAD audit.

## Why

The About page prefers VITE_RELEASE_VERSION, but Docker never supplies it. RC package versions remain at their stable base, so RC images identify themselves as stable.

## Design

1. Add failing governance cases for stable tag, RC tag, and non-release fallback.
2. Thread the already-validated effective release version through the reusable workflow as a build argument and into Vite. Leave arg-less local/branch builds on package-version fallback.
3. Reconcile later-RC image reuse: an image embedding a different RC tag is distinct and must be built.
4. Never accept an unvalidated arbitrary release identity.

## Verification and stop conditions

- Focused About tests, workflow governance, actionlint, RC image asset/about verification, fallback build, and git diff --check.
- Stop if trusted release and branch inputs cannot be distinguished. Make one commit only.
