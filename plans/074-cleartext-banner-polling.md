# Plan 074: Stop polling the persisted sync configuration for the cleartext-sync banner

> Executor: drift check `git diff --stat 66bcc1a4c..HEAD -- apps/desktop/src/components/Layout.tsx apps/desktop/src/components/Layout.test.tsx apps/desktop/src/lib/sync-service.ts`.

## Status
- Priority P2 · Effort S · Risk LOW · Category: perf · Planned at `66bcc1a4c`, 2026-09-04 (Phase 2 PERF-02)

## Why
`apps/desktop/src/components/Layout.tsx` ~:701-716 refreshes the cleartext-sync warning on mount, on every `storage` and `focus` event, and on a bare 30-second `setInterval` with no in-flight guard. Each call awaits `SyncService.getPersistedSyncConfigurationSnapshot()` (`Layout.tsx` ~:674), which runs inside `runSyncRestoreExclusive` — the same serialized queue whole sync cycles hold (`sync-service.ts` ~:1716-1727 says so: "waits behind whole sync cycles (tens of seconds on WebDAV)") — and the Rust command takes the one outer config read-modify-write lock and re-reads both secrets (`config.rs` ~:2667-2674). On a slow backend the ticks stack behind a cycle and drain as a burst of lock acquisitions and secret reads. The banner's only input is the URL scheme of a setting that changes only through a configuration commit (`rememberConfigurationSnapshot`, ~:1721).

## Steps
1. Drop the interval. Seed the banner synchronously from `SyncService.getLastKnownSyncSelection()` (or the equivalent last-known snapshot getter — read sync-service.ts for the one that does not enqueue), keep the `focus` and `storage` listeners, and refresh where a configuration actually commits (find the existing event/callback used after `commitProvenSyncConfiguration`/`rememberConfigurationSnapshot`; if none is exposed to Layout, add an in-flight guard and raise the period to ≥5 minutes instead — say which you chose).
2. Test: `Layout.test.tsx` ~:837 already stubs the getter; add a case asserting no timer-driven call happens over a simulated 2 minutes with fake timers, and that a `focus` event still refreshes.
- Verify: `cd apps/desktop && bun run test -- src/components/Layout.test.tsx`; `bun run typecheck:desktop`; `git diff --check`.

## STOP conditions
- No synchronous last-known getter exists and adding one would require touching the Rust config lock path.
