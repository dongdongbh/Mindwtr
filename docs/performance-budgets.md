# Performance Budgets

Mindwtr uses generated large-store tests to catch performance regressions before users hit them. The suite collects no user telemetry.

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

## Core Budgets

Budgets are intentionally explicit and conservative. They should only change in PRs that explain the measured reason.

| Operation | 1k tasks | 10k tasks | 50k tasks | Growth Guard |
| --- | ---: | ---: | ---: | ---: |
| Project detail lookup and sort | 25ms | 90ms | 450ms | 50k <= 12x 10k |
| Production task-derived state | 50ms | 250ms | 1200ms | 50k <= 8x 10k |
| Focus derivation | 40ms | 500ms | 2500ms | 50k <= 12x 10k |
| Search/filter/sort derivation | 30ms | 130ms | 650ms | 50k <= 12x 10k |
| Production sync-change fingerprint | 20ms | 80ms | 350ms | 50k <= 8x 10k |

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
