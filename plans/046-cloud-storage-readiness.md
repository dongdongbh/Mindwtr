# Plan 046: Separate cloud liveness from storage readiness

> Drift check: `git diff --stat 611d8fd3c..HEAD -- apps/cloud/src docker`

## Status

- **Priority**: P2 · **Effort**: S · **Risk**: MED (deployment health and persisted-data boundary) · **Depends on**: none · **Category**: reliability and operations
- **Planned at**: `611d8fd3c`, 2026-08-31

## Why

`GET /health` always reports success after the process starts. The cloud server validates its data directory only at startup, so a later lost, replaced, or read-only mount remains "healthy" while every write fails. Container health checks therefore cannot distinguish a live HTTP process from a storage-ready sync service.

## Design

- Keep `/health` as a cheap liveness endpoint.
- Add unauthenticated `GET /ready` as a fail-closed storage readiness endpoint. It returns 200 only when the configured data directory passes the existing safe writable-directory probe, and 503 otherwise. Do not expose paths or filesystem error details.
- Make the probe safe under repeated or concurrent health checks by using a unique temporary filename and cleaning it in every reachable path. Never touch namespace data or attachment trees.
- Route canonicalization and request-completion records must identify `/ready` without retaining sensitive data.
- Point Dockerfile and both Compose health checks at `/ready`; document the liveness/readiness distinction.

## Implementation

1. Add red storage tests for unique probe files, cleanup, and a failed unsafe/unwritable path.
2. Add server tests for `/health` remaining live while `/ready` returns 200 or 503 according to the storage probe.
3. Implement the narrow readiness route using the storage helper, preserving startup fail-fast validation.
4. Update Docker health checks and documentation, with a governance-style assertion if a suitable Docker test already exists.

## Verification

- Focused cloud storage and server tests.
- Full cloud test suite and cloud typecheck.
- Docker/Compose config validation where available.
- `git diff --check`.

## Non-goals and rollback

- No deep namespace validation, repair, database migration, external dependency check, or authenticated data read.
- No change to `/health` response semantics.
- The commit is independently revertible; rollback returns container probes to liveness-only behavior.

## Stop conditions

- Stop if readiness would read, rewrite, or delete user namespace or attachment data.
- Stop if a filesystem failure would be reported as ready, or if the response leaks the configured path.
- Stop if concurrent probes can delete one another's files or leave probe files behind.
