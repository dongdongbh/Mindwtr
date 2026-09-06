# Plan 071: Cover clarify, review and onboarding in the Playwright suite

> Executor: drift check `git diff --stat 992113e77..HEAD -- e2e playwright.config.ts`.

## Status
- Priority P2 · Effort M · Risk LOW (e2e is the slowest gate: keep walks short) · Category: tests · Planned at `992113e77`, 2026-09-04 (Phase 2 TEST-02)

## Why
`e2e/app.spec.ts` has five tests (default view, sidebar nav, create/delete task, restore from trash, filter trash); `e2e/a11y.spec.ts` one axe run. Both seed `mindwtr:desktop:first-run-onboarding:v1 = dismissed`, so onboarding never renders end to end, and nothing opens the clarify wizard, the Daily Review, the Weekly Review or the focus star. This loop's B1 (ten-row slice) and B2 (hardcoded focus limit) both passed every gate; one walk of the Daily Review comparing the header count with the rendered rows would have failed on both. The suite runs in CI (`.github/workflows/ci.yml` ~:495).

## Steps (three specs, three commits)
1. `e2e/review.spec.ts`: seed more tasks than any step used to cap (≥12 overdue/due-today, ≥12 inbox, ≥12 waiting, ≥12 focus candidates) through the same seeding seam `app.spec.ts` uses; open Daily Review; on each step assert the header count equals the number of rendered `[data-task-id]` rows; on the focus step assert the header shows the configured limit and starring stops at it.
2. `e2e/clarify.spec.ts`: capture a task into the Inbox, open Process Inbox, choose a project, land the task in Next; assert it is gone from Inbox and present in the Next list.
3. `e2e/onboarding.spec.ts`: do NOT seed the dismissal; assert the three choices render (sync / import / start fresh); choose start fresh (or Skip); reload; assert the modal does not return.
- Existing seams: `[data-sidebar-item][data-view="…"]`, `[data-task-id]`, the review modal's step rail; read `e2e/app.spec.ts` for the seeding and navigation helpers and match its style. Read `playwright.config.ts` for the dev-server setup.
- Verify: `bunx playwright test e2e/review.spec.ts` (and the two others) locally headless; the whole suite still under its CI budget.

## STOP conditions
- The app exposes no stable seam for a needed step (adding a `data-testid` in one component is allowed; more = STOP); an e2e walk reveals a product defect (report, do not fix here).
