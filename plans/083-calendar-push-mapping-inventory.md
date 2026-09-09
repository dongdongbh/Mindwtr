# 083: Batch full calendar mapping lookups

Status: TODO. Priority P2. Confidence HIGH. Effort S-M. Risk MED (calendar event/mapping cleanup). Selected automatically by the v1.2.8 review-improve loop, against app HEAD 57b257812c1054fa47c0bb8b95cd4115a564a277. This is both PERF-01 and architecture candidate A, one finding and one implementation commit.

## Problem and evidence
`runCalendarPushFullSync` in packages/core/src/calendar-push-run.ts:157 expands the full task inventory, then syncCalendarPushTask/removeCalendarTask call getSyncEntry for each task before a final getAllSyncEntries stale sweep. Both production adapters pass _allTasks (desktop-calendar-push-sync.ts:408, mobile calendar-push-sync.ts:735). Desktop getSyncEntry crosses Tauri and opens SQLite per lookup (storage.rs:3730); mobile makes a point SELECT.

A direct production-function probe with 5,000 synthetic undated Next tasks and no mappings made 5,000 point reads + 1 inventory read, zero event writes. 5,000 archived tasks gave the same result. This is operation-count evidence, not a claim of measured native latency.

Current ownership shape:
```ts
const results = await runLimitedSettled(
  calendarTasks, concurrency,
  task => syncCalendarPushTask(task, options.target, options.ports),
);
const staleEntries = (await options.ports.getAllSyncEntries())
  .filter(entry => !activeTaskIds.has(entry.taskId));
```

## Settled design
Deepen the existing full-run module without changing its public interface. Before event work, read getAllSyncEntries once and construct a private Map by taskId. Bind a run-local ports object whose getSyncEntry resolves from that Map; preserve all mutation/event ports. Use it only for this full invocation. Retain the existing fresh ending inventory read and stale sweep so cleanup/counters see successful/failed persistent mapping mutations exactly as before. At most two full reads and zero per-task reads in the demonstrated full-run cases.

Keep the snapshot immutable if each task is only looked up once, as in the existing production unique-task contract. Do not create a general mutable cache or new exported module. If implementation genuinely needs mirror writes, update the map only after persistent mutation succeeds. Do not change partial sync point lookups or scheduler serialization.

The shared module is the correct owner: moving inventory lifetime into both adapters duplicates the same decisions. Deleting this ownership restores N native calls; adding a new caching interface offers no further leverage. Consistent with ADR0002 shared core behavior and ADR0024 SQLite ownership. No schema, engine, connection-pool, or snapshot-sync redesign.

Initial inventory read failure must reject before event side effects, preserving the durable mappings. This fail-early behavior is an intentional acceptance decision; do not silently fall back to an unbounded point-read loop. Keep the final read fresh; its existing rejection semantics remain.

## Invariants and non-goals
- Keep create-event then mapping-upsert, delete-event then mapping-delete ordering. Failed writes/deletes keep existing retry semantics; never claim failed writes succeeded.
- Mapped undated, done, archived/cancelled, reference, and deleted tasks must still remove events/mappings. Missing tasks and stale/disabled projected occurrences still get final cleanup.
- Keep result counters total/failed/stale/staleFailed and existing concurrency. A failed first deletion can still be retried by the existing fresh ending sweep.
- Expand recurrence before calendar eligibility. Opted-in undated monthly recurrence can acquire a date during expansion; do not filter original tasks based only on dates.
- Partial runs remain per-ID reads, with no full inventory load merely for lookup.
- No global/persistent cache, new settings, exported options, native-storage edit, permissions/provisioning changes, UI redesign or runtime timing threshold.

## Owned files and conventions
Implementation: packages/core/src/calendar-push-run.ts and calendar-push-run.test.ts. Existing integration tests: apps/desktop/src/lib/desktop-calendar-push-sync.test.ts and apps/mobile/tests/calendar-push-sync.test.ts. Diagnostics only in the existing full-run completion logs of apps/desktop/src/lib/desktop-calendar-push-sync.ts and apps/mobile/lib/calendar-push-sync.ts; root integrates docs/release-notes/diagnostics-ledger.md. No other production paths without coordinator approval.
Match existing async ports, runLimitedSettled, vi.fn mocks, and behavior-visible result/event assertions. Do not test private implementation shape; verify call counts through public full/partial run functions. Adapter mocks must model real persisted inventory, not return [] forever after upsert.

## Execution and acceptance
1. Add red regression cases for 5,000 undated and 5,000 archived tasks with empty mappings. Assert zero getSyncEntry calls, at most two getAllSyncEntries calls, no event writes, unchanged success counters. Before the fix, each fails with 5,000 point reads.
2. Implement the private full-run inventory and keep the fresh final sweep. Verify mixed active/mapped-undated/terminal/deleted/missing cases, target-calendar move, missing event recreation, mapping-upsert/delete failure behavior, and projected recurrence. Extend the existing shared suite where cases are missing rather than duplicating all established cases.
3. Add explicit initial inventory failure test with no event or mapping mutations; prove partial one-task sync does not acquire full inventory.
4. Run core: `bun run --filter @mindwtr/core test -- src/calendar-push-run.test.ts src/calendar-push-scheduler.test.ts`. Expected all pass.
5. Run desktop: `bun --cwd apps/desktop test src/lib/desktop-calendar-push-sync.test.ts`; mobile: `bun --cwd apps/mobile test tests/calendar-push-sync.test.ts`. Expected all pass; adjust inaccurate inventory mocks only as necessary.
6. Add releaseCheck `v1.3.0/calendar-push-inventory` to existing post-full-run diagnostic logs in both adapters. It proves the bounded-lookup run returned, not that every calendar write succeeded; existing failure counters remain visible. Log no task text, calendar account data, URLs or credentials. Root adds ledger entry.
7. Run relevant core/desktop/mobile typechecks, scoped eslint, and git diff --check. Root runs diagnostic governance and final verify/test:perf after integration. Never weaken timing budgets.

## Maintenance and stop conditions
Full-run inventory is an invocation snapshot, not an authority across runs. Future concurrent writers or duplicate task identities must be handled at their existing owner before expanding this private cache. Preserve a fresh cleanup inventory until a separately proved change removes it.
Stop and report if batching requires a new public interface, changes scheduler/event ownership, or exposes actual concurrent mapping writes invalidating this snapshot. Do not improvise a generic cache or change product behavior.

## Worktree handoff rules
Use /home/dd/worktrees/Mindwtr/review-20260909-calendar-inventory. Dependencies and build output stay under /home/dd; set TMPDIR/BUN_TMPDIR=/home/dd/.cache/mindwtr-review-tmp. RTK prefix all shell commands. CodeGraph before structural discovery. Read AGENTS, CONTEXT, guardrails and TDD skills. You are not alone: preserve others edits. No crash-log/secret reads, no delegation, commits, push or issue messages. Root owns integration, plan status, ledger and independent Astra review.
