# Plan 073: Stop the always-mounted desktop overlays forcing a derived-state rebuild on every write, and read task lookups from the store map

> Executor: drift check `git diff --stat 66bcc1a4c..HEAD -- apps/desktop/src/components/GlobalSearch.tsx apps/desktop/src/components/QuickAddModal.tsx apps/mobile/app/global-search.tsx apps/desktop/src/App.tsx`. Deliver as TWO commits: PERF-01 then PERF-03.

## Status
- Priority P2 · Effort S · Risk LOW · Category: perf · Planned at `66bcc1a4c`, 2026-09-04 (Phase 2 PERF-01, PERF-03)

## Why
`<GlobalSearch />` and `<QuickAddModal />` are mounted unconditionally at the app root (`apps/desktop/src/App.tsx` ~:1635-1639). `GlobalSearch.tsx:97` calls `getDerivedState()` in the render body, ungated, and returns `null` only at ~:392 when closed; `QuickAddModal.tsx:173` does the same (that file already gates one field away at ~:238 with `isOpen ? useTaskStore.getState() : {}`). `getDerivedState()` misses its cache on every task write (`store-settings.ts` ~:581 gives `tasks`/`_tasksById` new identities), so every write pays the full `computeTaskDerivedState` (measured 12.25 ms at 5k tasks) for two invisible components, on every view. `GlobalSearch.tsx:102` and `apps/mobile/app/global-search.tsx:219` additionally rebuild `new Map(_allTasks.map(...))` (1.22 ms, 5k allocations) although the store already maintains `_tasksById` over the same array (`packages/core/src/store.ts` ~:296). Sibling of ledger C1 (a1bdd7766).

## Steps
1. PERF-01: in both overlays, gate the derived read on `isOpen` (`const derived = isOpen ? getDerivedState() : EMPTY_DERIVED` with a module-level frozen empty shape, or move the read below the `isOpen` check if hooks order allows — do NOT call hooks conditionally). Keep rendered output identical when open. Guard test in the shape of `apps/desktop/src/test/focused-count-selector.test.ts`: mount the closed overlay (or subscribe its selector), perform one `updateTask` on a ~7k-task store, assert `derivedRebuildCount` stays 0; assert the old shape rebuilds (red first).
2. PERF-03: at the two `_allTasks` sites (desktop GlobalSearch ~:102, mobile global-search ~:219) select `state._tasksById` instead of building a map; leave the visible-`tasks` sites (`ProjectWorkspace.tsx` ~:772, `WeeklyReviewModal.tsx` ~:142, mobile `useReviewModalController.ts` ~:343) alone but add a one-line comment where the exclusion of hidden tasks is deliberate. Existing tests for both search screens must stay green.
- Verify: `cd apps/desktop && bun run test -- src/components/GlobalSearch.test.tsx src/components/QuickAddModal.test.tsx src/test/focused-count-selector.test.ts <new guard>`; `cd apps/mobile && bun run test -- app/global-search.test.tsx` (or the nearest); `bun run typecheck:desktop && bun run typecheck:mobile`; `git diff --check`.

## STOP conditions
- Gating changes what the open overlay renders; a hook-order violation would be needed; a visible-tasks site turns out to rely on `_allTasks` semantics.
