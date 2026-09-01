# Plan 060: Fail closed on ambiguous Google Play commits

> Drift check: git diff --check v1.2.5-rc.2..HEAD

## Status

- Priority P1; effort S; risk HIGH; category release safety.
- Present in the requested `v1.2.5-rc.2..HEAD` review range.

## Why

A successful commit response that is empty, truncated, oversized, has the wrong JSON shape, or does not identify the requested edit can mean publication succeeded even though the client cannot prove it. Treating that as an ordinary API rejection makes an automatic retry unsafe.

## Design

1. Classify verified non-2xx responses as definite API rejection.
2. Require the 2xx response to identify the exact committed edit; classify every unusable or mismatched response as outcome unknown with an explicit no-retry warning.
3. Cover both branches at the fixed-origin transport boundary.

## Verification and stop conditions

- `python3 scripts/ci/google-play-edit.test.py` and the authoritative drift check.
- Stop if a verified non-2xx rejection becomes ambiguous. Make one commit only.
