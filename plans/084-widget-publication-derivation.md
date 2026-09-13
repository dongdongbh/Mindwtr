# Plan 084: Derive iOS widget lists once per publication

Status: DONE. Priority P2. Effort M. Risk MED. Confidence HIGH. Category performance / architecture. No dependencies. Planned against `43f40c2ea` on 2026-09-12; automatically selected by the review-improve loop. Root maintains plan status and integrates one implementation commit.

## Why and current state

`apps/mobile/lib/widget-service.ts:386` builds a 50-item payload for the fingerprint, then `updateIosWidgetPayloadsFromData:222-243` calls `buildPayloadFromData` five more times for caps 12/3/5/12/24. Each reaches `widget-data.ts:419-614`, repeating visibility, Focus selection, sorting, formatting and chooser saved-filter work (`widget-lists.ts:74-87`). A 5,000-task Bun probe measured six-payload medians of 100/136/272 ms for 0/10/50 saved filters, five samples after two warmups. These are descriptive host observations, not iOS latency measurements.

The current native keys and family budgets are deliberate. Android publishes one scrollable slice, iOS multiple capped families. Shortcuts has its own full snapshot and fingerprint because metadata outside widget rows must still update. Foreground coalescing and persisted widget fingerprints already reduce publication frequency; preserve them.

## Settled interface and boundaries

Deepen the existing widget-data module: derive selection/ordering once for one publication and shape its fingerprint and capped family payloads from that result. Keep the existing single-payload API for real callers, delegating to the same derivation. A narrow batch API or invocation-local projection is acceptable; no generic cache, registry, mutable global snapshot, new settings or public core API. The deletion test is removing five whole-data builds from the iOS adapter, not moving them to another wrapper.

Preserve every serialized field, item order, hidden-count subtitle, section cap, saved-filter list, completion token, language/theme behavior and native storage key. Do not simply slice the 50-row fingerprint payload: hidden-count subtitles and per-section shaping depend on the requested family cap. Keep independently invalidated Shortcuts snapshots, persisted fingerprint semantics, failure retry and sandbox suppression. Read CONTEXT/ADRs: native extensions consume read-only snapshots and enqueue durable commands; they never write SQLite.

## Owned files

- `apps/mobile/lib/widget-data.ts`, `widget-data.test.ts`
- `apps/mobile/lib/widget-service.ts`, `widget-service.test.ts`
- `apps/mobile/lib/widget-lists.ts` only if an existing selection helper needs extraction; no unrelated cleanup.
- A bounded reusable host work-count/compatibility probe under `scripts/performance/` only if needed. Root owns dated evidence report, stability-handoff link, diagnostics ledger and plans index.

## Execution and acceptance

1. Drift check: `rtk git diff --stat 43f40c2ea..HEAD -- apps/mobile/lib/widget-data.ts apps/mobile/lib/widget-service.ts apps/mobile/lib/widget-lists.ts`. Compare any changes before editing. Read AGENTS, guardrails, performance-loop and TDD skills. Existing widget tests are the test pattern.
2. Add a red work-count regression through the real publication interface with native transport mocked, requiring one expensive selection pass per iOS publication. Keep real derivation; do not satisfy it by mocking the helper under test. Before the fix it must show six passes. Add output compatibility fixtures for caps 3/5/12/24/50, >50 tasks, due/start dates, explicit Focus + Today sections, archived/deleted tasks and projects, filters, language and themes.
3. Implement the invocation-local derivation, remove repeated full-data calls. Tests must prove byte-equivalent family payloads and unchanged hidden-count subtitles; preserve no-change skip, failure then retry, Shortcuts-only changes, theme/language/day/Focus-filter invalidation and Android behavior.
4. `rtk bun --cwd apps/mobile test lib/widget-data.test.ts lib/widget-service.test.ts` must pass. Run `rtk bun run typecheck:mobile`, `rtk bun run lint:mobile`, `rtk git diff --check`: exit0 with no new owned-file warnings.
5. Add one privacy-safe successful iOS publication log `releaseCheck: v1.3.0/widget-batch-derivation`, `count: 5`, after all family writes succeed. It proves the batched publication path, not OS rendering or latency. No task text/ids or keys/paths. Root adds ledger entry and existing safe fields coverage.
6. Report deterministic work reduction first. Any host before/after timings use identical generated fixtures and dependencies, warmups, retained samples and alternating batches in isolation without builds/tests; no mobile speedup claim. Root runs final verify/perf and independent Astra closure.

## Done and maintenance

All focused tests/typecheck/lint/diff checks pass; public single-payload behavior unchanged; one invocation owns derivation and family shaping; no cross-publication data cache; independent snapshot invalidation remains. Root marks DONE after integration and attaches evidence. New widget families should request another projection of the same derivation, while any new output-sensitive field must enter existing invalidation gates.

STOP and report if matching old serialized outputs requires recomputing selection, if a shared mutable cache is necessary, or if native schema/command ownership or unrelated files must change. Do not lower timing budgets, rewrite native modules or combine widget and Shortcuts caches.

## Worktree rules

Use `/home/dd/worktrees/Mindwtr/widget-batch-20260912`; all dependencies/builds and substantial TMPDIR/BUN_TMPDIR stay under `/home/dd`, never `/tmp` or `/dev/shm`. RTK prefix shell commands; CodeGraph before structural discovery; apply_patch edits. You are not alone: preserve others' changes and never inspect crash logs. No worker commits, pushes, issue messages or further delegation. Root owns integration and one scoped commit for this finding.

## Validation

Real publication work-count regression failed with six selection passes, then passed with one. All 60 focused widget tests, mobile typecheck/lint and diff-check passed. An independent old-source differential probe checked 448 serialized outputs against 43f40c2ea across 65/5,000-task fixtures, four languages, two system themes, two Focus selections and seven caps. Every output was byte-identical after loading each isolated core's locale cache. Details and remaining native limits: `docs/performance/widget-publication-2026-09.md`. Final aggregate gates and independent review are recorded by the loop coordinator.
