# Plan 051: Make Compose secret-file authentication executable

> Drift check: git diff --stat v1.2.5-rc.2..HEAD -- docker apps/cloud scripts/ci

## Status

- Priority P2; effort S; risk MED; category self-hosting.
- Introduced in 4669cba2; found by the corrected v1.2.5-rc.2..HEAD audit.

## Why

Compose advertises MINDWTR_CLOUD_AUTH_TOKENS_FILE but neither mounts nor passes it and still requires an inline token during interpolation.

## Design

1. Add failing config tests for inline and file-backed secrets; rendered config must not expose secret contents.
2. Keep inline mode supported while making interpolation optional; runtime validation still fails closed if neither source exists.
3. Add a small secret overlay for both HTTP and HTTPS that requires a host path and mounts it read-only under /run/secrets.
4. Copy the owner-only bind mount to a mode-0400 bun-owned runtime file, then immediately drop startup privileges before Cloud runs.
5. Document the exact two-file command and permissions. Do not weaken authentication or the host file mode.

## Verification and stop conditions

- Validate inline and both overlay Compose configurations, a mismatched-UID runtime handoff, missing-all rejection, cloud tests, governance, and git diff --check.
- Stop if token bytes enter rendered config or the mount scope is ambiguous. Make one commit only.
