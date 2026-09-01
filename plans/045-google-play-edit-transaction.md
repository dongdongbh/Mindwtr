# Plan 045: Centralize Google Play edit transactions

> Drift check: `git diff --stat 611d8fd3c..HEAD -- .github/workflows/release-android.yml scripts/ci package.json`

## Status

- **Priority**: P1 · **Effort**: M · **Risk**: HIGH (release publication boundary) · **Depends on**: none · **Category**: architecture and release integrity
- **Planned at**: `611d8fd3c`, 2026-08-31

## Why

The Android release workflow implements the Google Play edit lifecycle four times in inline shell. Each copy owns validation, authentication, mutation, commit, and cleanup slightly differently. That duplication makes the failure contract difficult to test and lets a later workflow edit leak an uncommitted server-side edit or partially diverge between testing, beta, and stable publication.

## Design

- Add `scripts/ci/google-play-edit.py` as the single transaction boundary. Its semantic operations are `read_max_version_code(package_name, transport)` and `publish_release(plan, transport)`; HTTP mechanics stay private.
- The CLI exposes `max-version-code --package ... --result ...` and `publish --plan ... --result ...`. Authentication is read only from `GOOGLE_PLAY_ACCESS_TOKEN`.
- Validate all package names, version codes, tracks, statuses, fractions, release names, and artifact paths before creating an edit.
- An edit transaction owns insert, all mutations, commit, and best-effort deletion after pre-commit or ambiguous commit failure. Deletion never establishes rollback. Preserve the primary failure when cleanup also fails. Treat a commit timeout or connection loss as an unknown outcome and do not retry publication automatically.
- Inject a fixed-host transport for tests; production authentication and the Android Publisher host are not caller-configurable. Production uses one direct HTTPS connection per request, does not follow redirects, bounds response reads, and redacts the access token from errors.
- Publish stable production and its beta-track cleanup in one edit and one commit. Testing and beta publication remain separate transactions because they are separate release jobs.
- Make governance reject raw Android Publisher edit URLs and inline edit-lifecycle code in the workflow.

## Implementation

1. Add red unit tests for validation-before-insert, mutation order, successful commit, pre-commit cleanup, cleanup failure preservation, and unknown commit outcomes.
2. Implement the transport, transaction boundary, semantic operations, and CLI result files without third-party Python dependencies.
3. Replace inline Android Publisher requests in `release-android.yml` with validated plan generation and CLI calls.
4. Extend release-workflow governance so future inline lifecycle duplication fails CI, and wire the new unit test into the existing governance test command.
5. Keep the workflow outputs and existing testing, beta, stable, retry, and dry-run behavior compatible.

## Verification

- New Python unit tests for `google-play-edit.py`.
- Release workflow governance tests and the full governance suite.
- `actionlint` for `.github/workflows/release-android.yml` and any changed CI workflow.
- `git diff --check` and targeted inspection of generated plans and result-file outputs.

## Non-goals and rollback

- No service-account/OAuth redesign, new dependency, track-policy change, or automatic retry after an ambiguous commit.
- No changes to Android building, signing, store metadata, or GitHub release publication.
- The commit is independently revertible and restores the prior inline workflow implementation.

## Stop conditions

- Stop if the implementation needs a caller-selected network host or exposes the token in argv, logs, plans, or result files.
- Stop if stable production and beta cleanup cannot be represented atomically without changing the intended release state.
- Stop if any local input is first validated after edit creation.
