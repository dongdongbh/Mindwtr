# Plan 068: Correct the five repo README drifts (Task Dependencies, APK section, storage, snooze, database path)

> Executor: drift check `git diff --stat 992113e77..HEAD -- README.md README_zh.md apps/desktop/README.md apps/mobile/README.md`.

## Status
- Priority P2/P3 · Effort S · Risk LOW · Depends on: none · Category: docs · Planned at `992113e77`, 2026-09-04 (Phase 2 DOCS-01..05). Deliver as FIVE separate commits, one per finding.

## Findings and steps
1. DOCS-01 — delete "**Task Dependencies** - Block tasks until prerequisites complete" from `apps/desktop/README.md:21` and `apps/mobile/README.md:24` (no such feature; cross-task dependencies were declined). If a replacement bullet is wanted, "Sequential Projects — only the first unfinished task is offered as the next action" is accurate (`packages/core/src/project-utils.ts` getSequentialProjectTaskCues).
2. DOCS-02 — `apps/mobile/README.md` "### 2. Install Android SDK" (~:98-118) lost its ```bash fence (comments render as headings); "### 3. Build APK" (~:120) is empty. Re-fence the block; under step 3 either move the ABI-split commands from "### Build (ABI-split APKs)" (~:145-158) or replace the empty heading with a one-line cross-reference to that section.
3. DOCS-03 — `apps/mobile/README.md` ~:302-304 and ~:340-343 say AsyncStorage; truth is SQLite via `@op-engineering/op-sqlite` (`apps/mobile/lib/storage-adapter.ts`), AsyncStorage remains only the legacy-JSON migration source and a marker. Also fix the project-structure paths (`app/(drawer)/(tabs)/`, `app/(drawer)/settings.tsx`) and the `storage-adapter.ts # AsyncStorage integration` comment (~:317). Link `docs/ARCHITECTURE.md`.
4. DOCS-04 — `apps/desktop/README.md:31` "Desktop notifications with snooze": drop "with snooze" (no snooze in `apps/desktop`); root `README.md:181`: qualify as "snooze on mobile"; mirror the same sentence in `README_zh.md` if it exists there (rg for the zh twin).
5. DOCS-05 — `apps/desktop/README.md` Data Storage (~:105-111): add the SQLite database path beside `data.json` for installed builds with one line saying `data.json` is the sync and backup snapshot (mirror the portable block ~:116 which already names `mindwtr.db`); fill the "### Views" table (~:34-47) with the shipped views it omits (Timeline — opt-in, Reference, Someday, Done, Trash; roster in `apps/desktop/src/lib/sidebar-views.ts`).
- Verify each: `bun run docs:check-readme` (root) exits 0; `git diff --check` clean.

## STOP conditions
- A claimed path or command cannot be confirmed in the tree; the docs:check-readme gate fails for a reason outside these edits.
