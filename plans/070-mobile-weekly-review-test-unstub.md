# Plan 070: Stop stubbing @mindwtr/core in the mobile Weekly Review test

> Executor: drift check `git diff --stat 992113e77..HEAD -- apps/mobile/components/review-modal.test.tsx apps/mobile/components/review-modal.tsx packages/core/src/review-utils.ts`.

## Status
- Priority P2 · Effort M · Risk LOW (failures surfaced are information) · Category: tests · Planned at `992113e77`, 2026-09-04 (Phase 2 TEST-01)

## Why
`apps/mobile/components/review-modal.test.tsx:105` replaces the whole `@mindwtr/core` module with a hand-written object (no `...actual` spread) and re-implements `buildReviewSteps` (~:188-221, already drifted: the daily branch hardcodes `{ id: 'today', hasWork: false }` while `packages/core/src/review-utils.ts:766-819` derives it), fakes `partitionByReviewDate` (~:129) and `isTaskInActiveProject` (~:130). Thirteen tests over 763 lines assert Weekly Review behavior against fabricated domain output; a change to step order, hasWork or review-date partitioning cannot fail them. The sibling `daily-review-modal.test.tsx:79-85` shows the right pattern (`...actual`, override only `useTaskStore`).

## Steps
1. Change the mock to `async (importOriginal) => ({ ...(await importOriginal()), useTaskStore: <existing fake> })`; delete the `buildReviewSteps` / `partitionByReviewDate` / `isTaskInActiveProject` / bucket-builder stubs.
2. Run the file; for each failure decide: (a) the assertion was only true against the stub → rewrite the fixture with real tasks (dates, statuses, project ids) so the real bucket builders produce the intended bucket; (b) the component is wrong → STOP and report (that is a product finding, not a test fix).
3. Keep every behavior the thirteen tests were asserting; add one test that pins the canonical step order against `buildReviewSteps` from core so the two cannot drift silently.
- Verify: `cd apps/mobile && bun run test -- components/review-modal.test.tsx` green; lint on the file (exhaustive-deps is error in mobile); `bun run typecheck:mobile`.

## Scope
In: the test file only (fixtures may be added beside it). Out: `review-modal.tsx`, core review-utils (a needed change there = STOP and report).

## STOP conditions
- Un-stubbing reveals a real component defect; more than ~3 tests need the component changed to pass.
