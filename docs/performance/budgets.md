# Performance Budgets

Mindwtr uses generated large-store tests to catch performance regressions before users hit them. The suite collects no user telemetry.

For production startup/capture baselines, readiness instrumentation, and native profiling,
see [Performance baselines](baselines.md). These complement—not replace—the
fast algorithm/render budget gates below.

## Command

Run the current budget suite from the repository root:

```bash
bun run test:perf
```

This runs:

- `packages/core/src/performance-large-store.test.ts`
- `apps/desktop/src/components/views/ListView.performance.test.tsx`
- `apps/desktop/src/components/views/TimelineView.performance.test.tsx`
- `apps/mobile/tests/large-store-performance.test.tsx`

The core suite generates stores with 1k, 10k, and 50k tasks, many projects, many sections, mixed statuses, due dates, start dates, tags, contexts, deleted records, and a project with many selected-project tasks.

When `MINDWTR_PERF_TEST=1` (set automatically by `packages/core`'s `test:perf` script), the core suite also records every measured operation's label, dataset size, actual duration, and budget to `packages/core/.perf/measurements.json` (gitignored). CI's `performance` job prints this file as a table in the job summary and uploads it as the `core-perf-measurements` artifact, so a passing run's real timings are visible without re-running locally.

## Core Budgets

Budgets are intentionally explicit and conservative. They should only change in PRs that explain the measured reason.

| Operation | 1k tasks | 10k tasks | 50k tasks | Growth Guard |
| --- | ---: | ---: | ---: | ---: |
| Project detail lookup and sort | 25ms | 90ms | 450ms | 50k <= 12x 10k |
| Production task-derived state | 50ms | 250ms | 1200ms | 50k <= 8x 10k |
| Focus derivation | 40ms | 500ms | 2500ms | 50k <= 12x 10k |
| Focus screen derivation | 40ms | 200ms | 1200ms | 50k <= 12x 10k |
| Search/filter/sort derivation | 30ms | 130ms | 650ms | 50k <= 12x 10k |
| Production sync-change fingerprint | 20ms | 80ms | 350ms | 50k <= 8x 10k |
| Capture parser options | 25ms | 90ms | 450ms | 50k <= 8x 10k |
| Full snapshot merge | 150ms | 1500ms | 7500ms | 50k <= 8x 10k |

The "Focus derivation" row measures the Next-actions sort on its own. The "Focus screen
derivation" row measures the whole path the Focus screen runs, in the order it runs it:
narrow to actionable tasks, `buildFocusPools`, `deriveFocusTaskLists`, `buildFocusTaskSections`.
Its budgets come from measurements on a loaded workstation (3.39ms at 1k, 14.87ms at 10k,
102.81ms at 50k) with about 10x headroom, matching the other rows. See
[Focus derivation](focus-derivation-2026-09-21.md) for how those numbers were taken.

The capture-options gate exercises the production parser-options builder, including context
and tag discovery. Its broad CPU/scaling limits are not native interaction-latency targets.
A separate regression test requires name-only token collection to avoid timestamp reads
and compares it with usage-derived output across 5,000 mixed tasks.

The full-merge gate measures normalization, conflict resolution, attachment reconciliation,
and reference repair against an aligned snapshot, using fresh object identities for both
inputs on every attempt. Fixture cloning and result assertions are outside the timed region.
It takes the best of three attempts and verifies unchanged data, zero task conflicts, and
zero tombstone repairs. `bun run perf:storage` additionally reports unchanged and one-task
changed merges. These are CPU measurements, not network or end-to-end sync latency.

The suite also runs the real Zustand `updateTask` mutation and incremental persistence path at every dataset size. Its absolute budgets are 100ms at 1k, 250ms at 10k, and 1000ms at 50k, with a maximum 12x growth from 10k to 50k. Like the pure hot-path rows, this path uses the best of three measured runs to reduce runner and garbage-collection noise. Fingerprint cases assert both deterministic no-op behavior for aligned data and sensitivity to a synced revision change.

The bulk-mutation path (`batchMoveTasks` over every task in the store, what "Select all -> Move" dispatches) is budgeted at 75ms at 1k, 250ms at 10k, and 2000ms at 50k, with a maximum 15x growth from 10k to 50k, taking the best of two runs. It is the largest mutation a user can trigger in one synchronous store write.

The absolute budgets catch obvious regressions. The growth guard catches bad scaling, especially O(n^2) patterns that may still pass on small datasets. Growth comparisons use a 5ms denominator floor so very fast 10k measurements do not fail only because of runner timing noise.

## Platform Render Budgets

Platform tests exercise the production component seams with 5,000 generated tasks. Render budgets use the best of three mounts to reduce runner and garbage-collection noise, while still asserting that the real virtualization/list surface mounted successfully.

| Surface | Dataset | Budget |
| --- | ---: | ---: |
| Desktop `ListView` | 5,000 next actions | 500ms |
| Desktop `TimelineView` | 5,000 actionable tasks dated across 360 days and grouped into 50 projects | 500ms |
| Mobile `TaskList` | 5,000 mixed-status tasks | 350ms |
| Mobile `ProjectDetailModal` | 5,000 tasks in one project | 500ms |

The Timeline budget includes filtering, date-range computation, project grouping and sorting, axis construction, and the virtualized initial render. The mobile suite also retains budgets for Focus, Projects, Archived, Trash, editor open/save, completion, picker dismissal, and bulk selection. These are JavaScript render-path regression gates; use release-mode device profiling for native layout, UI-thread, and frame-timing conclusions.

## When To Add A Budget

Add or update a budget when a PR touches a hot path:

- capture open or first keystroke readiness
- project detail opening
- Focus, Inbox, or Projects derivation
- search/filter/sort logic
- project/context/tag summaries
- task mutation or persistence
- large list rendering

Prefer core tests for pure derivation and platform tests for render or native-thread behavior. This suite is the CI regression radar; use release-mode device profiling to diagnose regressions that cross native or render-thread boundaries.

## Native Android startup

`apps/android-native/scripts/check-startup-device.mjs` fails a phone run whose startup goes over these budgets. It measures the
`benchmark` build (minified, profileable, not debuggable, its own application id), so the dev app's data is never touched:

```bash
(cd apps/android-native/android && ./gradlew assembleBenchmark assembleBenchmarkSeed)
node apps/android-native/scripts/check-startup-device.mjs <adb-serial> \
  apps/android-native/android/app/build/outputs/apk/benchmarkSeed/app-benchmarkSeed.apk \
  apps/android-native/android/app/build/outputs/apk/benchmark/app-benchmark.apk
```

For each database it seeds the app, makes one first start (the recovery checkpoint, then the bytecode cache written after
first content), and measures 10 cold and 10 warm starts with ART at `verify`, as a sideload leaves it. **TTID** is
`am start -W` TotalTime (the first frame). **First content** is the system's Fully drawn time, which the app reports on
the frame that first draws the first screen's data (`ReportDrawnWhen` in `MainActivity.kt`, `firstContentReady`): Focus's on a
fresh start, as RN opens Focus (pass O2b), and the Inbox's rows (`InboxScreen.kt`) when the Inbox is the first screen. `large-5000` is core's
`scripts/performance/fixture.mjs` store with 5,000 tasks (`mixed-v1-5000`), made once by `measure-startup-device.mjs fixture`.

| Database | Cold TTID median | Cold first content median | Cold first content p90 | Warm first content median |
| --- | ---: | ---: | ---: | ---: |
| `empty` | 160ms | 360ms | 400ms | 100ms |
| `large-5000` | 160ms | 1050ms | 1150ms | 100ms |

The budgets come from 15-sample runs on the Galaxy S23 test phone (`RFCW10JBP0Y`) on 2026-10-01, at commit `perf(native): one
full read at boot instead of three`: empty 121 / 288 / 295 / 58 ms, large-5000 125 / 874 / 888 / 61 ms (same columns).
That is about 25% headroom on first content (more on TTID and warm starts, which vary more from run to run), so a run fails on
a clear regression, not on noise. Budgets hold for that phone only: measure again before using them on another device.
