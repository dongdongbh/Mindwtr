# Plan 072: Widen the axe contrast gate over every theme and two more screens

> Executor: drift check `git diff --stat 992113e77..HEAD -- e2e/a11y.spec.ts packages/core/src/types.ts`.

## Status
- Priority P3 · Effort M · Risk LOW · Category: tests · Planned at `992113e77`, 2026-09-04 (Phase 2 TEST-03) · Depends on: 071 (shares the e2e seeding helpers; land after it)

## Why
`e2e/a11y.spec.ts:11-49` runs axe's color-contrast rule once on the default Focus view in the default theme. `AppTheme` (`packages/core/src/types.ts:350`) has eleven members; ten never meet the gate, nor does any dialog, settings page or review modal. The project's theme-add checklist says contrast must be measured, and the sidebar CTA already needed a contrast fix.

## Steps
1. Parameterize the existing test over the theme list (use `THEME_DESCRIPTORS` in `packages/core/src/theme-scheme.ts` if it enumerates AppTheme; else a literal list with a comment pointing at the type). Seed the theme through the same persisted seam the app reads at startup (find how `appearance.theme` is persisted; read `apps/desktop/src/App.tsx` startup) before `page.goto('/')`.
2. Add two contexts per theme: the Settings page and one open modal (Daily Review or the task editor), navigated via the existing seams.
3. Expect the first run to surface pre-existing violations: land the gate with a documented allowlist keyed by `theme + selector + rule` that can only shrink (a stale-entry assertion, same shape as `apps/desktop/src/test/i18n-missing-keys.test.ts`), and list every allowlisted violation in the commit message so it becomes visible debt.
- Verify: `bunx playwright test e2e/a11y.spec.ts` green; runtime stays reasonable (one browser context per theme).

## STOP conditions
- Themes cannot be switched through a persisted seam before load; the run exceeds ~5 minutes; a violation is in a component whose fix is not a one-line token change (report it, allowlist, move on).
