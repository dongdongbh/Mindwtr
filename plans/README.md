# Plans index

Written by the 2026-08-13 improve audit (Phase 2 of the review-improve loop), stamped against `0e4021faa`. Selection was non-interactive: every high-confidence actionable finding became a plan; speculative/deferred items are recorded below instead of planned.

## Execution order and status

| # | Plan | Findings | Effort | Status |
|---|------|----------|--------|--------|
| 001 | tauri-main-thread-commands | R-01, R-02 | S-M | DONE |
| 002 | calendar-feed-revocation | R-03 | S | DONE |
| 003 | local-api-hardening | R-04, R-05 | S-M | DONE |
| 004 | mcp-hardening | R-06, R-08 | S | DONE |
| 005 | import-sourcekey-identity | R-07 | S | DONE |
| 006 | derived-state-hot-path | A-02, A-04 | S | DONE |
| 007 | capture-import-chain | A-05 | S | DONE |
| 008 | source-hygiene-pair | A-03, A-07 | S | DONE |
| 009 | i18n-toast-leaks | Q-02 | S | DONE |
| 010 | locale-coverage-label | Q-01 | S | DONE |
| 011 | undo-import | Q-03 | S-M | DONE |
| 012 | csv-export | DIR-01 | M | DONE |
| 013 | automation-query-unification | DIR-02 | M | DONE |
| 014 | dx-batch | DX-01/02/04/05 | S | DONE |
| 015 | core-lint-ci | DX-03 | S | DONE |
| 016 | desktop-flat-eslint | DX-06 | S-M | DONE |
| 017 | adr-encryption-at-rest | DOCS-01 | S | DONE |
| 018 | mobile-store-action-settlement | ARCH-01 | M | DONE |

Dependencies: 015 before 016 (both touch lint wiring; 015 is upstream in CI). 001's commit 2 depends on its commit 1. 006 commit 2 depends on commit 1 only for merge cleanliness. Everything else independent.

## Deferred (recorded, deliberately not planned)

- **DEPS-01** desktop `file:` → `workspace:*` core dependency (138MB stale copy): defer until just after 1.2.0 stable — lockfile churn mid-RC-train is the hazard, not the change.
- **DEPS-02** Expo SDK 54→57 migration: own release train post-stable, staged 54→55→56→57 with per-hop device rounds and patch re-validation; the `@fugood/react-native-audio-pcm-stream` New-Architecture question decides whether realtime transcription needs a new transport first.
- **DEBT-03** attachment-backend 2×5 glue duplication: investigation verdict only — lifecycle + wire protocol already shared; diff WebDAV+Dropbox bodies before believing consolidation pays. Do not re-audit without that diff.
- **DIR-03** publish the CLI (bin in mindwtr-mcp) vs. relabel docs as contributor script: maintainer product decision; both halves cheap once decided.
- **DIR-04** web/PWA storage decision: spike (measure serialized 5k-task fixture vs localStorage quota) decides invest (IndexedDB adapter behind setStorageAdapter) vs demote (docs). Product call after the measurement.
- **DIR-05** Obsidian on mobile: real parity hole, deliberately not now (SAF two-way writer risk). Recorded to stop re-derivation.

## Considered and rejected

- zustand v5 / lucide 1.x bumps: ride-along only, no standalone value.
- Re-export shim deletion (attachment-utils, dropbox-sync pair): churn > value.
- Rust storage.rs/sync.rs "god module" split: production halves are ~3k lines; tests inflate the counts.
- native-schema job off macOS: needs xcrun swiftc, verified.
- testing-strategy.md command additions: 6-locale parity cost for info one click away.
- MCP/cloud auth helper sharing: deliberate workspace independence, recorded in file headers.
- Global Android user-CA trust: deliberately restores OS trust-store parity for arbitrary self-hosted URLs; scoping it requires a separate native HTTP stack, and the device owner or administrator must explicitly install the CA. The low-leverage L/HIGH-risk migration is rejected unless the product threat model changes.
- Mobile task-field renderer mega-interface: real coupling, but current performance gates are green and the refactor crosses keyboard, recurrence, attachment, audio, and progressive-disclosure behavior. Keep as Worth exploring until a measured regression or a narrower slice justifies it.

## Legacy plans (2026-08-09 files, reconciled 2026-08-13)

`2026-08-09-improve-product.md` and `2026-08-09-improve-architecture-performance.md` predate this run (base faea7edc3):
- Persistence-failure surface with retry — **DONE** (645f376d7, PersistenceFailureBanner both platforms).
- Watcher partial-failure lifecycle — **DONE** (watcher controller/generation commits + this loop's S6/S11/C2).
- Localize desktop Settings feedback — **LARGELY DONE** (4b8c53a4c, 43fc66552, 06eb36bc9, 24ac122f2); the ratchet-test remainder is superseded by plan 009.
- Mobile onboarding busy-guard — **LIKELY DONE** (8aad219ff); verify before re-planning.
- SQLite warm-open cost, TS/Rust golden merge fixtures, exact transfer-operation IDs, mobile Data-row a11y — **STILL OPEN**, carried as future candidates (not selected this run; the first two are M-L with high care requirements, the latter two are UX polish batches).

---

# 2026-08-22 improve audit (Phase 2 of the review-improve loop), stamped against `b0a96ccc9`

Selection non-interactive: every HIGH-confidence actionable finding became a plan; numbering continues from the 08-13 run. All 08-13 plans remain DONE. Executors: one commit per finding, red test first, honor STOP conditions, update this table.

## Execution order & status

| Plan | Title | Priority | Effort | Depends on | Status |
|------|-------|----------|--------|------------|--------|
| 019 | cloud-server-integrity | P1 | S | — | DONE |
| 020 | core-store-write-integrity | P1 | M | — | DONE |
| 021 | delete-vs-live-revision | P1 | M | — | BLOCKED (ADR 0007 records the outside-window rule as deliberate; fixtures pinned; superseding ADR = maintainer decision) |
| 022 | sync-orchestrator-rejections | P1 | S | — | DONE |
| 023 | fts-search-quoting | P1 | S | — | DONE |
| 024 | attachment-integrity | P1 | L | — | DONE (SEC-07 partial on mobile: migration pre-pass provenance is an open design decision) |
| 025 | android-component-security | P1 | M | — | DONE (SEC-03 permission half declined: exported receiver is documented public API; rate limit shipped) |
| 026 | network-policy | P2 | M | — | DONE (+ in-window fix: cloud attachment downloads decrypt before validating) |
| 027 | mcp-hardening-2 | P1 | M | — | DONE (npm release owed for the fixes to reach users) |
| 028 | desktop-native-hardening-2 | P1 | M | — | DONE |
| 029 | core-input-hardening | P2 | M | — | DONE (BUG-12: real win needs an incremental hash API in uuid.ts — follow-up) |
| 030 | batch-update-perf | P1 | S | — | DONE (50k-task batch move ~11s → ~0.6s) |
| 031 | mobile-test-integrity | P2 | M | 024 (soft) | DONE |
| 032 | dx-batch-2 | P2 | M | DX-01 lands first & alone | DONE |
| 033 | docs-batch-2 | P2 | M | — | DONE |
| 034 | csv-recurrence | P2 | M | — | DONE |

Dependency notes: 031 after 024 (shared vi.mock idiom for un-stubbing); 032's DX-01 (lockfile) lands as an isolated commit before other work touches node_modules; 024 items 1→5→8→9 are ordered internally.

## Phase 2 plans — review-improve loop 2026-09-04 (stamped against `992113e77`)

Selection was automatic: every HIGH-confidence actionable finding from the Phase 2 improve audit (`.orchestrator/tasks/review-loop-20260904/improve-*.md`, git-excluded working state) became a plan; direction items are recorded below, not built.

| # | Plan | Findings | Effort | Status |
|---|------|----------|--------|--------|
| 067 | deferred-remote-write-outcome | BUG-01 | S | TODO |
| 068 | app-readme-drift | DOCS-01..05 (five commits) | S | TODO |
| 069 | delete-unused-process-inbox-helper | TEST-04 | S | TODO |
| 070 | mobile-weekly-review-test-unstub | TEST-01 | M | TODO |
| 071 | e2e-gtd-loops | TEST-02 | M | TODO |
| 072 | axe-contrast-gate-themes | TEST-03 | M | TODO |
| 073 | desktop-overlay-derived-state | PERF-01, PERF-03 (two commits) | S | TODO |
| 074 | cleartext-banner-polling | PERF-02 | S | TODO |
| 075 | ci-core-job-split | DX-01 | S | TODO |
| 076 | dx-batch-vite-typecheck-perf-record | DX-03, DX-04, DX-02 (three commits; after 075) | S | TODO |

Fixed directly during the loop without a plan (see the loop ledger): BUG-R1 mobile attachment timers (c9541342e) and the thirty Phase 1 findings.

Architecture deepening (Phase 3, from the architecture audit): DEBT-01 editor field rosters → core (Strong), DEBT-04 widget builders on the Focus sequential rule (Strong), DEBT-02 auto-sync pacing controller → core (Strong), DEBT-03 device-local cache rules → core, lazy version (Worth exploring, accepted: two real adapters and one recorded drift), DEBT-06 task-list sort rosters → core (Worth exploring, accepted: "FOUR allowlists" trap). DEBT-05 (dev-runtime gate helper: store.ts enforces when `process` is undefined, i.e. desktop production THROWS on a write-contract violation while mobile repairs silently) is a maintainer polarity decision → deferred, recorded here. DX-05 (roster parity gate) is superseded by DEBT-01/06.

### Direction (recorded, not built)
- **DIR-01** expandable projects in the desktop sidebar (promised on #1116): `buildProjectGroups` and `getProjectNextActionState` already exist; device-local expand state can follow `HIDDEN_SIDEBAR_VIEWS_STORAGE_KEY`. Needs a design spike (default collapsed state, area nesting, badges). Desktop first.
- **DIR-02** widen the shared review contract from step order to step content (bucket key + cap per step from `buildReviewSteps`) so both Daily Review modals read truncation and the focus limit from core. Medium; narrows divergence, cannot dedupe JSX.
- **DIR-03** one quick-add token registry (token + label key + gating flag) feeding the help sentence and the editor badges; spike the assembled-sentence grammar in zh/ja/fa/sv first.
- **Investigate**: Daily Review step order is re-listed per platform (`DailyReviewModal.tsx` ~:199-214, mobile sibling) and consulted from core only through `hasWork`; add a contract test before it diverges.

### Deferred (this run)
- **DEPS-R1** quick-xml 0.39.4 (RUSTSEC-2026-0194/0195) and rkyv 0.7.46 (RUSTSEC-2026-0235): `cargo update --precise` refuses both (wayland-scanner/ashpd/rfd/tauri-plugin-dialog pin quick-xml ^0.39; rust_decimal/byte-unit/tauri-plugin-log pin rkyv 0.7). Wait for the parents; a `[patch.crates-io]` override is not worth the risk for build-time XML and an unreached deserializer.
- **DEPS-R2** image-size (Metro build-time transitive, no fixed release): monitor.
- **B12** ~75 call-site keys still missing from en.ts (Obsidian view 38, People manager, Saved filters, Pomodoro phases, mobile context-automation): allowlisted shrink-only in `apps/desktop/src/test/i18n-missing-keys.test.ts` and `apps/mobile/tests/i18n-missing-keys.test.ts`; ~375-525 translations = own task.
- `formatFocusTaskLimitText`'s literal-`3` fallback (`packages/core/src/focus-utils.ts:12-18`) is dead now that every locale carries `{{count}}` (guarded); delete with its test in a follow-up.

## Plans 035–066 (2026-08-26..31 loop, reconciled 2026-09-04)

All executed in the 1.2.5-rc → 1.2.6 window; each plan file records its own outcome and index rows were never added at the time. Treat every one of 035–066 as DONE unless its file says otherwise.

## Deferred (recorded, deliberately not planned this run)

- **DEPS-03** ~50 RN transitives pinned as direct root dependencies (from 7703fdee2, none imported by root code): removal is mechanical but requires a lockfile review + real Android build round — own maintenance window, alongside DEPS-02 (Expo 54→57).
- **SEC-15b** any-token-mode IP rate limiting + true-LRU eviction on the cloud limiter: real but opt-in mode; an IP bucket changes behavior for proxied deployments — needs a deployment-model decision.
- **SEC-12b** moving WebDAV URL userinfo into the keyring at config-save: real, M effort, follow-up to 026's redaction.
- **SEC-10b** Android network-security-config domain scoping: REJECTED as planned — conflicts with settled #663 (base-config cleartext is load-bearing for arbitrary private-IP WebDAV); the JS-level `assertConnectionAllowed` guard (026) is the enforcement point.
- **DIR-02** spreadsheet round-trip apply mode: DECIDED "no" this run — docs stance (skip on id match) stands; 033/DOCS-05 aligns the code comments. Revisit only with a rev-aware design.
- **DIR-03** backup ZIP with attachment bytes: needs a mobile memory/threading measurement spike; DOCS-01 (033) captures the safety value now.
- **BUG-26 caveat** — if investigation shows SyncRun re-checks freshness, 024 item 7 downgrades to early-abort only.
- **DEBT-01** (AppTheme descriptor registry) and **DEBT-02** (sync-configuration transaction consolidation): routed to the architecture-deepening phase, not this plan set.
- **DX-02** worktree pool: `git worktree prune` done operationally; deleting the 21 checkout dirs (53 GB) left to the maintainer (destructive).

## Findings considered and rejected (this run)

- MCP task-content-as-instructions sanitizer: inherent to a task-reading tool; client-side concern.
- MCP auth-throttle FIFO eviction: bounded impact (401→429 only); comment-worthy at most.
- window_state.rs non-atomic layout write: loss is monitor geometry; not scheduled.
- `insertColumns` dead cache in queries.ts: one-line deletion, fold into any 027 commit touching the file.
- Wholesale task-utils.ts split; big React-surface splits; SETTINGS_X_VALUES helper; wiki/Home.md link parity; CI caching: all re-confirmed not worth doing (see 08-13 rationale).
- allTokens memoization (ListView.tsx:292): consumers re-render regardless; buys nothing.
