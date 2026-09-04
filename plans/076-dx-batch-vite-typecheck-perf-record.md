# Plan 076: DX batch — dead Vite test block, emit-free core typecheck, recorded perf measurements

> Executor: drift check `git diff --stat 66bcc1a4c..HEAD -- apps/desktop/vite.config.ts package.json packages/core/package.json packages/core/src/performance-large-store.test.ts .github/workflows/ci.yml docs/performance-budgets.md`. THREE commits: DX-03, DX-04, DX-02.

## Status
- Priority P3 · Effort S · Risk LOW · Category: dx · Planned at `66bcc1a4c`, 2026-09-04 (Phase 2 DX-03, DX-04, DX-02). Land AFTER plan 075 (shares ci.yml).

## Steps
1. DX-03 — `apps/desktop/vite.config.ts:48` declares a `test:` block that vitest never reads (`vitest.config.ts` wins in CONFIG_NAMES order; nothing passes `--config`). Delete the block; leave a one-line comment pointing at `vitest.config.ts`. Verify: `cd apps/desktop && bun run test -- src/lib/density.test.ts` still runs under jsdom; `bun run build` config unaffected (`bunx vite build --mode production` dry check is optional).
2. DX-04 — `package.json:109` `typecheck:core` runs `bun run --filter @mindwtr/core build` (= `tsc` with emit) while CI runs `tsc --noEmit`. STOP-check first: `rg -n "core/dist|packages/core/dist" .github scripts apps/*/package.json apps/*/scripts docker 2>/dev/null` must be empty and `packages/core/package.json` `main`/`exports` must all point into `src/`. Then add `"typecheck": "tsc --noEmit"` to `packages/core/package.json` and make root `typecheck:core` call it; leave `build` as is. Verify: `bun run typecheck:core` exit 0 and writes nothing (`git status --short` clean, no new files under packages/core/dist beyond what existed).
3. DX-02 — `packages/core/src/performance-large-store.test.ts` ~:265-270 `expectWithinBudget` only surfaces numbers on failure. Append `{ label, size, actualMs, budgetMs }` to a module array and write it at suite end (afterAll) to a JSON file under an ignored path (e.g. `packages/core/.perf/measurements.json`; add to .gitignore if not covered) when `MINDWTR_PERF_TEST=1`; add a CI step in the performance job that prints the file into `$GITHUB_STEP_SUMMARY` as a small table and uploads it as an artifact. Mention the file in `docs/performance-budgets.md` (one paragraph). No assertion changes. Verify: `MINDWTR_PERF_TEST=1 bun run --filter @mindwtr/core test:perf` writes the file; `bun run test:governance` exit 0.
- Overall: `git diff --check` clean.

## STOP conditions
- Something consumes `packages/core/dist` (DX-04); the perf JSON path collides with an existing artifact name.
