# Plan 061: Make Cloud readiness non-mutating

> Drift check: git diff --check v1.2.5-rc.2..HEAD

## Status

- Priority P1; effort S; risk HIGH; category storage reliability.
- Present in the requested `v1.2.5-rc.2..HEAD` review range.

## Why

The readiness probe can recreate a missing configured data directory, masking a lost mount and allowing reads or writes to continue against the wrong storage. A replacement directory at the same path must not become ready or serve normal routes in the running process.

## Design

1. Keep creation and durability checks in startup only.
2. Probe an existing directory without creating it, retain the startup directory identity, and gate every storage route before authentication, admission, locking, or path creation.
3. Recheck the pinned identity inside serialized operations, and never let data, attachment, or lock helpers recreate the configured root.
4. Return 503 after the directory disappears, changes identity, or becomes unsafe; keep `/health` as liveness only.
5. Reserve each attachment PUT stage under the verified original root before receiving its body, then require both the startup-pinned root identity and the exact staged inode immediately before atomic publication. GET and DELETE recheck storage authority at their operation boundaries as well.
6. Reserve `/v1/data` publication under the verified root before a serialized merge, then recheck the startup root and exact root, parent, and staged-file identities before replacement. Serialized reads recheck authority after their callback so replacement-root bytes cannot be returned.

## Verification and stop conditions

- Focused and full Cloud tests, Cloud typecheck/lint, and the authoritative drift check.
- Integration coverage pauses an attachment upload after its stage is open, replaces the configured root, finishes the body, and requires a retryable non-success without a target in the replacement root.
- A 50,000-task integration merge replaces the root only after the namespace lock and data stage are live, then requires 503 with no data or lock artifact in the replacement root.
- Stop if readiness or a normal route creates the configured directory, serves a replacement root, publishes an upload across a root-identity change, or startup stops creating it. Make one commit only.
