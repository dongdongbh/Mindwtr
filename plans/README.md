# Plans index

## Review from v1.3.6 — November 25, 2026

| Plan | Impact | Effort | Verification |
| --- | --- | --- | --- |
| [135](135-entity-open-url.md) | Preserve one encoding contract for clipboard, widgets and search | Small | Byte-level output and parser round trip |

The transport audit kept Gmail's explicit all-or-nothing acknowledgement contract. A transport-format migration would reopen ADR 0020 without new performance evidence. The architecture change above is independent of the attachment and recurrence fixes.

## Release review from v1.3.0 — September 28, 2026

Planned at `285b922ab` after four comprehensive fixes. Astra reviews only shipping
React Native/desktop/core/cloud/MCP/automation/release surfaces; native mobile
migration is excluded. Selection is automatic under review-improve-loop. Sol
implements bounded code changes; root integrates one commit per finding.

| Plan | Finding | Priority | Effort | Dependencies | Status |
| --- | --- | --- | --- | --- | --- |
| [132](132-editor-focus-draft-recurrence.md) | Editor Focus ignores draft recurrence | P2 | S | None | DONE |
| [133](133-shared-token-grouping.md) | Four duplicate context/tag grouping loops | P3 | S | None | DONE |
| [134](134-image-size-exception-rationale.md) | Stale image-size exception rationale | P3 | S | None | DONE |

132 reuses the existing draft serializer;133 is the sole selected architecture
candidate (Worth exploring, selected because two shipping adapters repeat the
same domain decisions). It must delete duplicate loops in the existing module.
No Strong architecture candidate or measured performance regression was found.
134 corrects documentation only; it does not remove the dependency vulnerability.

Deferred: image-size now has patched 2.x releases, but the Expo54-pinned Metro
0.83.3 asset reader uses the old filename interface. Replacing it or overriding
the Metro family needs Android/iOS asset-bundling validation in a separate
maintenance change. Existing build-time-only exceptions and topology checks
remain unchanged. Rust quick-xml/rkyv exceptions remain as previously recorded;
the fresh configured audits passed and rkyv is inactive in the locked feature graph.

Rejected: whole calendar/sync adapter rewrites, new task-row caches, all-axis
registries, speculative product direction, size-only module splits, and reopening
settled snapshot/CRDT/MCP/native-migration decisions without new evidence.
No public-doc change selected. Audit sampling and host tests do not prove device,
background, signing or production backend behavior.

## Review loop from v1.3.0 — September 22, 2026

Planned against `59d0e575e` (public docs `89ac579b`). GPT-6 Astra reviewed all nine improve categories; GPT-5.6 Sol implements the selected findings. Automatic selection under review-improve-loop includes all three high-confidence actionable plans. The comprehensive fixes are separate commits; their evidence is in the local task report. Existing plan128 is an unrelated native experiment and is preserved.

| Plan | Finding | Priority | Effort | Dependencies | Status |
| --- | --- | --- | --- | --- | --- |
| [129](129-authenticated-developer-examples.md) | DOCS-01: developer examples omit required authentication | P3 | S | None | DONE (web183b164e) |
| [130](130-cloud-quick-add-capture-parity.md) | CORRECTNESS-01: Cloud quick-add drops project/date capture metadata | P2 | S | None | DONE (8dd02f92f) |
| [131](131-widget-shared-focus-pools.md) | ARCH-01: widget duplicates core Focus pool policy through an obsolete adapter | P3 | S | None | DONE (6e3eff2ee) |

Plans may run independently in isolated worktrees. Plan129 changes only the public-doc repository;130 reuses core capture inside the existing single Cloud write;131 is the sole additional Strong architecture candidate, deleting the obsolete adapter and duplicate policy. AUTO-04 already handles the CLI capture deepening, so it is not a second architecture refactor. Root maintains status and creates one commit per finding.

Considered and rejected: PWA port drift (5173 matches), Core API tombstone visibility mismatch (visible versus all collections are intentional), new CI/dependency restructuring, generic retry/notification/controller frameworks, size-only module splits, new caches, and reopening ADR0029 native/merge scheduling direction without new measurements. Existing image-size build-input advisories and quick-xml/rkyv dependency deferrals remain; current locked-manifest checks and configured Rust audit gate pass. No additional supported security or performance defect was established. Physical-device/background/signing limits remain explicit in the result.

## Review loop from v1.3.0 — September 18, 2026

Planned against `561cfdfa0` (integration branch `agent/integrate-20260918` = main `8fe8c9293` + the phase-1 review fixes and their closure corrections). Phase-1 findings were fixed directly (see `.orchestrator/tasks/impl-20260918/LEDGER.md`, not tracked). This is the phase-2 improve set, selected by default (non-interactive run): every high-confidence actionable finding of the three audits. Plan 116 targets the public docs repository.

| Plan | Finding | Priority | Effort | Dependencies | Status |
| --- | --- | --- | --- | --- | --- |
| [111](111-clear-trash-purges-only-what-is-shown.md) | PROD-02: Clear Trash deletes items the screen does not show | P1 | S | None | DONE |
| [112](112-undo-project-delete-restores-its-tasks.md) | PROD-05: Undo after a project delete restores an empty project | P2 | S-M | None | DONE |
| [113](113-sidebar-drop-onto-history.md) | PROD-01: dropping a task on Done/Archived in the sidebar stopped working | P2 | S | None | DONE |
| [114](114-save-and-edit-follows-deferred-tasks.md) | PROD-03: Save & edit can land where the new task is hidden | P2 | S | None | DONE |
| [115](115-trash-retention-notice.md) | PROD-04: Trash never says items are removed after the retention period | P3 | S | 111 (same files) | DONE |
| [116](116-user-guide-matches-1-3-1-screens.md) | DOCS-01: public guide describes the pre-1.3.1 screens (six languages) | P3 | M | 113 (one sentence) | DONE |
| [117](117-ai-endpoint-stays-on-device.md) | SEC-02: a synced settings document can choose where the AI API key is sent | P0 | S | None | DONE |
| [118](118-date-only-imports-stay-date-only.md) | BUG-01: Todoist import and speech-to-task add a clock time to date-only dates | P1 | S | None | DONE |
| [119](119-server-rejected-attachment-is-terminal.md) | REL-03: a file the self-hosted server refuses blocks every remote write | P1 | M | None | DONE |
| [120](120-email-capture-deterministic-ids.md) | REL-01: email-captured tasks get random ids, so a replay duplicates them | P2 | S | None | DONE |
| [121](121-log-sanitizer-current-key-shapes.md) | SEC-01: log sanitizer misses current API key shapes; two drifted copies | P2 | S | None | DONE |
| [122](122-email-capture-partial-fetch.md) | REL-02: email capture downloads whole messages to keep 16,000 characters | P2 | S | None | DONE |
| [123](123-capture-webhook-idempotency.md) | REL-04: capture webhook has no idempotency key | P2 | S | None | DONE |
| [124](124-sync-settings-allowlist-test.md) | TEST-01: no test pins which settings cross devices | P3 | S | 117 | DONE |
| [125](125-desktop-drop-duplicate-task-indexes.md) | PERF-01 step 1: nine task indexes exist twice in the desktop database | P2 | S | None | DONE |
| [126](126-msstore-routing-test-asserts-something.md) | DX-01: Store rollout routing test passes when pwsh is missing or broken | P3 | S | None | DONE |
| [127](127-render-test-timeouts.md) | DX-02: heavy render tests fail at the 5 s harness default under load | P3 | S | None | DONE |

### Architecture deepening (phase 3, implemented from `.orchestrator/tasks/impl-20260918/ARCH-BRIEFS.md`)

DONE: ARCH-01, ARCH-02, ARCH-03, ARCH-04 (plus the core fix "a purged row is never restored"), ARCH-05. Not selected: ARCH-06.

ARCH-01 one home for the desktop profile search path (scripts copy still lacks Flatpak and macOS sandbox roots); ARCH-02 one active-filter chip builder (four desktop copies; ArchiveView still shows chips for criteria it does not apply); ARCH-03 import the time-estimate list from core (five hand-typed lists); ARCH-04 Rust project delete/restore in the shared parity fixture (three `purgedAt` differences); ARCH-05 task destination patch written four times; ARCH-06 stale-path fallback order and moved-folder list written three times.

### Direction (recorded for the owner, not built)

D1 "Restore project" from Trash brings its tasks back (needs a new synced field; after 112). D2 finish the partial translations now that the "partly translated" hint is gone (nl 28%, hi/ru 60%, pl/ar/pt/tr ~61%, it 66%, fr 81%). D3 one "where does this task live" rule in core (114 is the first step).

### Deferred (recorded, deliberately not planned this run)

- PERF-01 step 2: retire unused and prefix-covered indexes in core and Rust; needs `EXPLAIN QUERY PLAN` for the MCP `listTasks` sorts and a "full save of 10k tasks" perf row first.
- REL-03 twin: WebDAV 413/507 on attachment upload is a different seam. Mobile client-side validation failures only log and continue (no bounded seam). Owner decisions: soft-delete vs "keep the record, stop retrying" at the terminal step; a server-specific "file too large" toast (new key).
- Owner decisions from phase 1: compact mobile rows hide note/tags on the Reference list with no "Show details" control; a replayed Apple Reminders import counts as imported and deletes the reminder when only a tombstone exists (CP-3).
- Phase-1 closure leftovers: layout migration orphan-WAL double fault (N2); stale-lock live-removal race (C4b); editor attachment draft can drop a kept voice capture (R1); muted unapplied filter chips have no screen-reader cue; desktop row menus without arrow keys; Linux zbus notification connection never reset.
- Release rollout: no minimum time at a stage; shared concurrency groups can cancel a pending manual halt.
- Closure leftovers from phases 2-3: a device-local setting edited during a sync cycle is invisible to the change fingerprint (the AI endpoint and offline model path are restored explicitly; a general rule needs its own plan; mobile `applyDataToStore` not audited); `purgeDeletedTasks` / `purgeDeletedProjects` have no app caller left; Focus view shows no chip for a selection in a hidden category (needs a core hook change); email capture counts a replay as imported; the capture replay answer reveals whether an id exists to a capture token; core and Rust word the purged-restore refusal differently; narrowed Clear Trash text reads "1 tasks".
- Reliability "investigate" list: IMAP host change reuses the old password; synced calendar URLs cause blind GETs to LAN hosts; real Todoist export shapes; email-capture state lock after a panic.

### Considered and rejected (this run)

- Sharing the profile path list through `packages/core` (core must stay free of `fs`/`os`).
- Raw English store errors in toasts (realistic paths are blocked earlier or have a translated banner).
- Re-homing `quick-add-images` in the layout migration (old paths keep working because the folder did not move).
- ARCH-06 as "two TypeScript re-homing functions": there is one function with two callers.

## Review loop from v1.2.8 — September 16, 2026

Planned against `0b9ea1d0e` (integration branch `agent/integrate-20260916` = main `700c42184` + the 32 phase-1 review fixes). Phase-1 findings were fixed directly (see `.orchestrator/tasks/impl-20260916/LEDGER.md`, not tracked). This is the phase-2 improve set: every high-confidence, actionable finding from the product, reliability/security/tests and architecture audits became a plan; each plan is one commit. Root maintains status and integration.

| Plan | Finding | Priority | Effort | Dependencies | Status |
| --- | --- | --- | --- | --- | --- |
| [088](088-cli-stdout-and-governance-glob.md) | ARCH-01: CLI stdout log leak + unwired scripts tests | P2 | S | None | DONE |
| [089](089-capture-webhook-attachment-admission.md) | SEC-01: capture webhook skips attachment admission | P1 | S | None | DONE |
| [090](090-mobile-managed-attachment-gate.md) | SEC-02: managed-attachments gate is a bare prefix | P1 | S | None | DONE |
| [091](091-android-alarm-map-persistence.md) | REL-01: alarm map lost when a reschedule aborts | P2 | S | None | DONE |
| [092](092-desktop-lenient-json-prefix-guard.md) | REL-02: lenient parse adopts a nested fragment | P2 | S | None | DONE |
| [093](093-mcp-bootstrap-temp-rename.md) | REL-03: MCP bootstrap not atomic | P2 | S | None | DONE |
| [094](094-cloud-ready-probe-throttle.md) | REL-04: /ready fsync per unauthenticated hit | P2 | S | None | DONE |
| [095](095-core-store-write-contract-guard-test.md) | TEST-01: store write guard never fires in CI | P3 | S | None | DONE |
| [096](096-core-load-idempotence-matrix.md) | TEST-02: load(load(x)) covers 3 of 18 migrations | P2 | M | None | DONE |
| [097](097-mcp-exercise-tool-schemas.md) | TEST-03: MCP schemas never exercised | P3 | M | None | DONE |
| [098](098-local-api-project-allowlist-parity.md) | TEST-04: project allowlist parity test | P3 | S | None | DONE |
| [099](099-local-api-lock-poison-recovery.md) | REL-05: poisoned write lock = 500s until restart | P2 | S | None | DONE |
| [100](100-mcp-logger-sanitizer.md) | SEC-03: MCP logger bypasses sanitizer | P3 | S | None | DONE |
| [101](101-desktop-inlist-add-keeps-text.md) | PROD-01: in-list add drops rejected capture text | P2 | S | None | DONE |
| [102](102-mind-sweep-honours-store-result.md) | PROD-02: Mind Sweep counts refused captures | P2 | S | None | DONE |
| [103](103-capture-rejections-visible.md) | PROD-03: silent capture rejections | P2 | S | None | DONE |
| [104](104-store-results-at-completion-and-star-sites.md) | PROD-04: six sites ignore the store result | P2 | M | None | DONE (partial: Pomodoro Mark-done still lacks undo/prompt) |
| [105](105-docs-remove-skip-occurrence.md) | PROD-05: docs promise a Skip occurrence action | P3 | S | None | DONE |
| [106](106-getting-started-deterministic-ids.md) | PROD-06: two devices seed two Getting Started projects | P2 | S | merge asymmetry below | BLOCKED |
| [107](107-desktop-editor-attachment-status.md) | PROD-07: desktop editor hides attachment state | P3 | S | None | DONE |
| [108](108-hardcoded-strings-existing-keys.md) | PROD-09: hardcoded English with existing keys | P3 | S | None | DONE |
| [109](109-sync-setup-parity.md) | PROD-10: self-hosted Test connection / blank token | P3 | S | None | DONE |
| [110](110-mobile-getting-started-guide-link.md) | PROD-11: mobile card lacks the guide link | P3 | S | None | DONE |

Blocked with evidence (needs a sync owner before it can ship): plan 106 was implemented and then withdrawn. With deterministic ids, a tombstone whose `deletedAt` precedes a newer live row's `createdAt` (device A deleted the tutorial, device B seeded it later) merges INCONSISTENTLY in `packages/core/src/sync.ts`: task tombstones at rev ≥ 2 beat the rev-1 live row (result is a hybrid: `deletedAt`/`rev` from the tombstone, `updatedAt` from the live row) while the project in the same merge comes back live — the user sees an empty Getting Started project on both devices. With `createdAt` before `deletedAt` (single-device history) both agree. Reproduction table: `.orchestrator/tasks/impl-20260916/result-p2-core.md` §8. Fixing the asymmetry is merge-engine work (ADR 0007 territory) and the next sync loop's first item; until then random seed ids stay (duplicate tutorial after pairing, harmless). Also recorded: `purge-expired-tombstones` reports itself applied even when it removed nothing (load-migration bookkeeping, harmless).

Follow-ups from the phase-2/3 closure reviews (recorded, not fixed): Pomodoro Mark-done reports failures but still has no undo toast / next-action prompt — needs a shared completion helper extracted from the row hooks (plan 104's stated Why, half delivered); the local API rejects seven cloud-writable project fields (`tagIds`, `taskSortBy`, `isFocused`, `supportNotes`, `dueDate`, `reviewAt`, `startDate`) — pinned as NOT_IMPLEMENTED by plan 098's parity test, owner decision whether to widen; the inline create-person failure reuses `task.addFailed` copy (a `people.addFailed` key is locale-frozen); plan 103's rejected desktop audio capture keeps the dialog open but does not retry the recording; plan 109's desktop self-hosted probe handler has no unit test; MCP `isoDateLikeSchema` is shape-only (`2026-13-45` passes; pinned in index.test.ts); `scripts/mindwtr-api.test.ts`'s readiness poll was widened to 30 s (unplanned test-only commit); the File Sync reader in sync.rs keeps its own forward scan (port the storage.rs prefix guard); an empty File Sync document now fails as "no recognised sync surface" (safe, wording misleading); `/ready` shares the feed's client-key rule so a proxied external monitor can be throttled when proxy headers are untrusted; the log sanitizer stringifies numeric/boolean context values.

Deferred (recorded, not planned): PROD-08 incubate question, PROD-12 Quick Add help tokens, the Dropbox-not-configured string, and the 65 `resolveText` keys with no English entry — all need locale edits, which were frozen this batch by a concurrent widget change; do them together once the tree is clean. ARCH-07 (44 unreferenced RN transitive deps) is MED confidence and lockfile-churning mid-RC. ARCH-08 quick-add token table and ARCH-09 settings descriptor are worth-exploring deepening candidates for a later loop. Architecture candidates selected for phase 3 (not plans): Focus derivation in core, WebDAV encryption-posture port, sort-roster unification. Direction notes (not planned): restore a hand-cancelled task to its previous status (needs a P18 field decision), a desktop "settle store action" helper (after plan 104 shows the sites).

Considered and rejected: attachment remote/local ports (L effort, data-loss class, outside an RC); Rust sync.rs/storage.rs split (pure moves, large churn); vitest config triplicate (guarded); load-migration cost (single-digit ms); `task-utils.ts` split (namespace, fails the deletion test); a mobile folder-probe for File Sync (needs design).

## Review loop from v1.2.8 — September 15, 2026

Planned against `51ac48c2f`. The comprehensive batch fixes archive-section retention, cloud attachment GC, revoked capture-token fallback, legacy capture-audio readability, project-title Escape, menu focus, and Shortcut diagnostic privacy; each remains its own implementation commit. The broad improve pass selects only the three supported opportunities below. Root maintains status and integration.

| Plan | Finding | Priority | Effort | Dependencies | Status |
| --- | --- | --- | --- | --- | --- |
| [085](085-bulk-date-accessible-names.md) | QUALITY-01: mobile bulk input accessible names | P2 | S | None | DONE |
| [086](086-bulk-area-custom-order.md) | QUALITY-02: desktop bulk area custom order | P3 | S | None | DONE |
| [087](087-archive-reactivation-validation.md) | PERF-01: remove per-task archived-section projections | P2 | M | None | DONE |

Plans 085/086 can execute independently from 087. Plan087 is the sole Strong architecture candidate: deepen existing container validation with scoped restoration eligibility, remove repeated projected arrays, preserve the later durable transition. No new generic cache or schema is selected.

Considered and rejected: another widget chooser/fallback rewrite (native Tasks and Compact intentionally differ); generalized bulk-form controllers (working save/session guards); public widget-copy expansion without a concrete misleading instruction; new roadmap features; native-queue or snapshot-sync rewrites without evidence reopening existing ADRs. Fresh dependency audit reproduces the existing image-size Metro build-time deferral with no listed patched release; quick-xml/rkyv parent constraints remain recorded below. No public-doc plan selected. Native accessibility and platform latency require separate device evidence; host tests do not establish those outcomes.


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
| 067 | deferred-remote-write-outcome | BUG-01 | S | DONE (84d5ea4ed; post-switch deferred case keeps B4's wording as an info toast) |
| 068 | app-readme-drift | DOCS-01..05 (five commits) | S | DONE (dd4f268ed, 02a48e494, 9c44f7e6f, 1950bbc90, cc8aecaa7) |
| 069 | delete-unused-process-inbox-helper | TEST-04 | S | DONE (f7c480f97) |
| 070 | mobile-weekly-review-test-unstub | TEST-01 | M | DONE (69687b2d2; mutation-checked against core) |
| 071 | e2e-gtd-loops | TEST-02 | M | DONE (2f6232541, c71daa570, b476316e2) |
| 072 | axe-contrast-gate-themes | TEST-03 | M | DONE (eee154f94; allowlist keyed theme·rule·colour pair, 21 pre-existing violations in 7 themes) |
| 073 | desktop-overlay-derived-state | PERF-01, PERF-03 (two commits) | S | DONE (71ab902bc, becc04eed) |
| 074 | cleartext-banner-polling | PERF-02 | S | DONE (c1282df4d) |
| 075 | ci-core-job-split | DX-01 | S | DONE (a545e540c) |
| 076 | dx-batch-vite-typecheck-perf-record | DX-03, DX-04, DX-02 (three commits; after 075) | S | DONE (22c84e485, b9d22254b, 2f2f6cb93) |

Fixed directly during the loop without a plan (see the loop ledger): BUG-R1 mobile attachment timers (c9541342e) and the thirty Phase 1 findings.

Architecture deepening (Phase 3, from the architecture audit): DEBT-01 editor field rosters → core (Strong), DEBT-04 widget builders on the Focus sequential rule (Strong), DEBT-02 auto-sync pacing controller → core (Strong), DEBT-03 device-local cache rules → core, lazy version (Worth exploring, accepted: two real adapters and one recorded drift), DEBT-06 task-list sort rosters → core (Worth exploring, accepted: "FOUR allowlists" trap). DEBT-05 (dev-runtime gate helper: store.ts enforces when `process` is undefined, i.e. desktop production THROWS on a write-contract violation while mobile repairs silently) is a maintainer polarity decision → deferred, recorded here. DX-05 (roster parity gate) is superseded by DEBT-01/06.

### Direction (recorded, not built)
- **DIR-01** expandable projects in the desktop sidebar (promised on #1116): `buildProjectGroups` and `getProjectNextActionState` already exist; device-local expand state can follow `HIDDEN_SIDEBAR_VIEWS_STORAGE_KEY`. Needs a design spike (default collapsed state, area nesting, badges). Desktop first.
- **DIR-02** widen the shared review contract from step order to step content (bucket key + cap per step from `buildReviewSteps`) so both Daily Review modals read truncation and the focus limit from core. Medium; narrows divergence, cannot dedupe JSX.
- **DIR-03** one quick-add token registry (token + label key + gating flag) feeding the help sentence and the editor badges; spike the assembled-sentence grammar in zh/ja/fa/sv first.
- **Investigate**: Daily Review step order is re-listed per platform (`DailyReviewModal.tsx` ~:199-214, mobile sibling) and consulted from core only through `hasWork`; add a contract test before it diverges.

### Deferred (this run)
- **DEPS-R1** quick-xml 0.39.4 (RUSTSEC-2026-0194/0195) and rkyv 0.7.46 (RUSTSEC-2026-0235): `cargo update --precise` refuses both (wayland-scanner/ashpd/rfd/tauri-plugin-dialog pin quick-xml ^0.39; rust_decimal/byte-unit/tauri-plugin-log pin rkyv 0.7). Wait for the parents; a `[patch.crates-io]` override is not worth the risk for build-time XML and an unreached deserializer.
- **DEPS-R2** image-size (Metro build-time transitive): patched 2.0.3 exists, but its API differs from the filename API used by Expo's pinned Metro. Defer replacement pending compatible Metro/image-size integration and Android/iOS asset-bundling validation; existing audit exceptions remain unchanged.
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


## 2026-09-07 improve audit (v1.2.7 review loop)

Planned against `77137ce0d` / `a68aeeb6f`. All reviews use GPT-6 Astra; implementation is delegated to GPT-5.6 Sol, with root handling ordinary docs. Selection is automatic under the review-improve-loop: all five exact-evidence findings are selected. Each finding gets one scoped implementation commit per repository. Prior plans and deferred decisions remain as recorded above.

| # | Plan | Priority | Effort | Status |
|---|------|----------|--------|--------|
| 077 | sqlite-final-tombstone-expiry | P2 | M | DONE |
| 078 | cloud-focus-write-parity | P2 | M | DONE |
| 079 | mcp-auth-throttle-docs | P3 | S | DONE (app README and all six public locales; web check passed) |
| 080 | inbox-project-reuse-eligibility | P2 | S | DONE |
| 081 | dialog-autofocus-return | P2 | S | DONE |

No logical dependencies; isolated implementations may run in parallel. Diagnostics ledger and field-test additions are integrated by root, preserving all entries. Public docs plan079 also receives one scoped mindwtr-web commit.

Considered and rejected: no fresh evidence reopens the snapshot-sync ADRs, MCP per-process multi-database state (one configured database is the supported host), cloud revision ceiling without a production trigger, or a suspected calendar duplicate-submit path without reproduction. Existing image-size/quick-xml/rkyv advisory deferrals remain; fresh shipped npm lock audits are clean except the exact documented Metro chain. No additional dependency or CI restructuring plan is warranted. No new roadmap feature was selected.


### Architecture deepening, 2026-09-07

| # | Plan | Priority | Effort | Status |
|---|------|----------|--------|--------|
| 082 | webdav-presence-proof | P2 | M | DONE |

Strong and automatically selected: both WebDAV adapters can stamp an unknown remote result as a completed daily proof. Replace their duplicated decision with the existing core attachment-presence module. Keep each platform's local-prepass, cancellation, cooldown and activation behavior. No dependencies on077–081. The timestamped HTML report is a temporary review artifact; plan082 is the durable Spec.

Rejected after current-body comparison: whole attachment-backend consolidation and deletion of existing Cloud/Dropbox adapters widen interfaces without removing domain decisions; sync configuration transactions already have a deep module; notification polling and native alarm scheduling remain distinct adapters; editor mega-interface and Daily Review direction remain unselected.


## 2026-09-09 improve and architecture audit (v1.2.8 review loop)

Selected against `57b257812`: product and integrity broad audits found no additional supported defects after comprehensive remediation. The architecture/performance audit reproduced one calendar-specific N+1 storage path. User selection is automatic under review-improve-loop; all reviews use Astra, implementation uses Sol.

| # | Plan | Priority | Effort | Status |
|---|------|----------|--------|--------|
| 083 | calendar-push-mapping-inventory | P2 | S-M | DONE |

Plan083 is both PERF-01 and the sole Strong architecture candidate; one implementation commit. No dependencies. Rejected: another shared UI draft lifecycle and another visibility controller would move platform lifetime decisions into wider interfaces without a reproduced remaining defect. Prior ADR/roadmap/dependency deferrals stay unchanged. A source comment suggests checking cancellation-alert presentation on iOS pageSheet during a device round; no current runtime evidence establishes a defect, so no implementation plan was created.

## 2026-09-12 improve and architecture audit

Reviewed against `43f40c2ea`, including explicit MCP validation, transports, durable writes, startup and packaged-client setup. Correctness/security/test coverage findings from the comprehensive pass are remediated separately; docs corrections cover package setup and stale engineering claims. The broad audit adds one supported performance/deepening candidate. All reviews use GPT-6 Astra xhigh; implementations use GPT-5.6 Sol or the leader. Automatic selection is authorized by the review-improve loop.

| # | Plan | Priority | Effort | Status |
|---|------|----------|--------|--------|
| 084 | widget-publication-derivation | P2 | M | DONE |

Plan084 is the sole new Strong architecture candidate and one finding/commit. No dependencies. Shared native-command persistence recovery also deepens an existing duplicated rule, already handled in comprehensive remediation; it is not a second refactor plan. The complete selected plan set is committed before phase-two implementation.

Considered and rejected: whole native-queue unification, combining widget/Shortcuts caches, optional-capability wrapper consolidation, splitting native modules solely by size, new architecture registries, repeated UI lifecycle mega-interfaces, snapshot/CRDT migrations and roadmap expansion. Native CI already compiles app Kotlin and runs widget/Watch Swift package tests; missing local Swift is a validation limit, not a new tooling defect. Prior dependency migration/advisory decisions remain unless a fresh shipped-path audit supplies new evidence. No new DX or product-direction plan is selected.
