# Performance Guide

This page documents practical performance patterns for Mindwtr (desktop, mobile, and core).

## High-Impact Areas

- Large list filtering and sorting
- Project/task ordering updates
- Sync merge and attachment reconciliation
- Re-render churn from broad store subscriptions
- SQLite query patterns (search, date filters, project/status views)

## UI Rendering Guidance

1. Prefer narrow store selectors and avoid selecting whole store objects.
2. Group related selectors and memoize derived collections.
3. Keep item components pure; push expensive transforms up to list-level memoization.
4. Use virtualization for large lists and avoid dynamic height recalculation in hot paths.
5. Avoid creating new inline callbacks/objects in large mapped lists.

Current desktop list rows rely on memoized `TaskItem` rendering, so keep task row props stable when changing list, project, agenda, calendar, or review views. If a view needs extra per-row metadata, derive it once at the list level instead of building new objects inside every row render.

### Rendering Optimization Playbook

When a screen feels slow, use this order:

1. Verify list item render count first (React DevTools profiler).
2. Hoist static constants/styles out of render functions.
3. Memoize heavy child components (`React.memo`) with explicit prop equality where needed.
4. Split large components by concern (header/form/list/modals) so state updates stay localized.
5. Replace broad dependency arrays with smaller memoized selectors/helpers.

### FlatList / Virtualization Tuning (Mobile)

- Set `initialNumToRender`, `maxToRenderPerBatch`, `windowSize` intentionally by screen.
- Provide `getItemLayout` where practical (fixed or measured fallback).
- Enable `removeClippedSubviews` for larger lists.
- Keep `keyExtractor` stable and avoid index keys.
- Avoid inline anonymous renderers in deeply nested item trees.

## Sync Performance Guidance

1. Validate payload shape before merge to fail fast.
2. Keep merge deterministic and O(n) over entity count (map by ID, avoid nested scans).
3. Reconcile attachment metadata first; defer file IO/network to separate sync phase.
4. Bound retries with backoff and classify retryable vs terminal errors.
5. Cache backend config reads during a sync cycle to reduce repeated storage access.

The sync engine maintains indexed conflict/revision lookups during merge. When adding new synced entity types or conflict reporting, preserve that indexed shape rather than reintroducing per-entity scans across full collections.

### Sync Tuning Tips

1. Keep attachment upload/download concurrency conservative on mobile networks.
2. Tune timeout and retry windows separately for metadata vs attachments.
3. Abort quickly on offline transitions; avoid long retry chains after connectivity loss.
4. Use progress instrumentation for long-running attachment phases.
5. Track conflict count, max clock skew, and timestamp adjustments per sync run.
6. Treat sync-conflict samples as bounded diagnostics. Keep sample count and diff-key limits small so conflict reporting does not dominate large merges.

### Sync Debug Checklist

If sync latency regresses:

1. Compare local read, merge, remote write, and attachment phases separately.
2. Verify rate-limit responses (`429`) are not causing cascaded retries.
3. Check attachment hash validation/retries for repeated failures.
4. Confirm remote payload size and collection counts are within configured limits.
5. Capture log samples with timestamps and request IDs around slow windows.

## Database Guidance

1. Use FTS indexes for free-text search where available.
2. Keep common status/project/date filters indexed.
3. Batch writes inside transactions for large imports/sync save paths.
4. Keep JSON columns normalized at read boundaries and avoid repeated parse/stringify loops.

## Profiling Checklist

1. Reproduce with a realistic dataset (thousands of tasks, large projects).
2. Measure before/after (render counts, query timings, sync duration).
3. Check memory growth during long sessions.
4. Verify no regressions in low-end devices/simulators.

## Performance Budget Suggestions

- List interactions should remain responsive (<16ms frame budget where feasible).
- Search requests should be sub-100ms on typical local datasets.
- Sync merge should scale linearly with entity count.
- Avoid blocking UI threads with file/network operations.

## Continuous Performance Hygiene

1. Add targeted tests when fixing regressions (render churn, merge complexity, retry behavior).
2. Keep budget checks in CI for critical views and sync paths.
3. Prefer small measurable improvements over broad speculative refactors.
4. Re-profile after each optimization to verify real impact.

## Related docs

- [[Architecture]]
- [[Core API]]
- [[Data and Sync]]
- [[Diagnostics and Logs]]
