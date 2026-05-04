# ADR 0014: Shared Sync Orchestration Ports

Date: 2026-05-04
Status: Proposed

## Context

Desktop and mobile both run the same sync orchestration shape: read local state, dispatch to file/WebDAV/cloud/Dropbox backends, reconcile warnings, update status, and surface notifications. Today those flows live in app-specific services, so fixes often need to be applied twice.

The merge algorithm is already shared in `@mindwtr/core`; the remaining duplication is the orchestration state machine around backend IO and UI notification.

## Decision

Plan a follow-up refactor that moves the platform-independent sync orchestration state machine into `@mindwtr/core`.

The core package should own:

1. sync cycle state transitions
2. retry and pending-write policy
3. conflict diagnostics shaping
4. backend dispatch contracts

Apps should provide ports:

1. `BackendIO` for file/WebDAV/cloud/Dropbox/iCloud transport calls
2. `Storage` for reading and writing local snapshots
3. `Notifier` for toasts, badges, and platform logs
4. `Clock` or test-time hooks where deterministic timing is needed

## Consequences

- Sync behavior can be covered once with core unit tests.
- Desktop and mobile keep platform-specific backends without duplicating policy.
- The refactor should be done as its own change set because it touches high-risk sync lifecycle code.
- Until this is implemented, sync bug fixes must keep checking both app orchestrators.
