# Performance and stability handoff

Updated September 13, 2026. Engineering handoff for future desktop and mobile
sessions, not a claim that the performance audit is complete.

Latest desktop continuation base: published `fc6b606c4` on `main`. Its app/core
sources match the verified archived timestamp-candidate control; see the
[September 13 invoke investigation](desktop-invoke-completion-2026-09-13.md).
The September 12 original control was `80dede27c78a4737d144bb4b81052cdc9b9a6406`.
The accepted desktop commits are exact native capture readback (`0d6c2929a`)
and shared token timestamp reuse (`992934a56`), now merged and pushed to `main`.
The portability follow-up is `e22327cc2`; the dated reports retain the pre-commit
binary, source-map and runner identities. The earlier
`3d67289a9` / `perf/native-contention` work remains historical evidence below.
At the next session, inspect current Git/CI state; local test results here do not
certify a later commit, release, or deployment.

Publication follow-up: the first CI run (`34737920122`) passed the performance
budgets but found a hard-coded lab path in the new SQLite test fixture. The test
now uses the platform temporary directory and respects local `TMPDIR`. This
test-only portability correction does not invalidate the native measurements.
Replacement [CI run 34738227281](https://github.com/dongdongbh/Mindwtr/actions/runs/34738227281)
completed successfully on `e22327cc2`, with local/remote main SHA parity verified.
[Native Platform CI 34737920115](https://github.com/dongdongbh/Mindwtr/actions/runs/34737920115)
also passed on `992934a56`; the follow-up changed only tests/docs.

Android benchmark hardening and its handoff are now merged and pushed to `main`
as `e2234c4fa5461de2a1afb4f22e816a1d82b128ea`. All jobs in
[CI 34740710185](https://github.com/dongdongbh/Mindwtr/actions/runs/34740710185)
passed, and local/remote main SHA parity was verified. The subsequent Android
document-provider write fix was validated on `perf/android-capture-cost-20260913`
in `/home/dd/worktrees/Mindwtr/android-stability-20260913` before publication.
Its dated report retains the pre-commit build identities and local/native checks;
the source is now committed, merged and pushed as
`fc6b606c4554cb6d58792cce044f04cf958ca1cc`. All jobs in
[CI 34742804799](https://github.com/dongdongbh/Mindwtr/actions/runs/34742804799)
passed, with local/remote main SHA parity verified. The subsequent desktop
completion-probe improvement is committed as `e282fa6e1`. It was validated on
`perf/desktop-save-serialization-20260913` in the existing
`/home/dd/worktrees/Mindwtr/desktop-stability-20260912` worktree.
The dated report retains its pre-commit native build and runner identities.
CI `34742804799` covers the Android fix; use the CI run for the current pushed
`main` revision to establish integration status for the desktop continuation.

## Start here

1. Read this handoff, then the relevant investigation linked below. Historical
   reports retain their original findings; later reports can supersede an old
   report's “next step.” Do not restart completed or rejected experiments.
2. Read [Performance baselines](baselines.md) for runner commands,
   readiness/identity contracts, isolation, and artifact formats, and
   [Performance budgets](budgets.md) for the existing CI thresholds.
3. Pick one measurable hypothesis on one platform, establish a current control,
   add a failing correctness/work-count regression, and make a bounded change.
   Keep desktop and mobile as separate tracks; shared-core microbenchmarks do
   not replace native validation on either.
4. Preserve raw successes and failures, validate correctness before timings,
   and commit each accepted fix with its evidence. Check current authorization
   before merging/pushing; this handoff is not ongoing publication permission.

## Completed changes and strength of evidence

September 13 desktop continuation: the opt-in completion probe separates public
invoke entry, synchronous return and promise settlement in the capture's page
clock. The ordinary bundle excludes its profiling transport. After two review
corrections, 102 performance-tool tests, desktop checks and independent review
passed. Ten fresh native cases passed with exact capture, SQLite readback,
save-idle and reload checks. In five sampled captures, dispatch took 35–37ms and
settlement followed 991–1091ms later. Dispatch occurred before DOM appearance in
the two slower cases and afterward in the three faster cases. This establishes
stronger attribution, not an app speedup or isolated SQL cost. See
[native invoke completion](desktop-invoke-completion-2026-09-13.md) for exact
builds/maps/runner identities, retained failures, clock limits and the clean
control replacement. The lab ended unlocked with unchanged display outputs and
no Benchmark processes; Android and normal app profiles were not accessed.

September 13 next Android pass: two matched control batches set Newest before
each preflight, passed 40/40 visible-IME checks and retained ten measured traces.
Identical-build frame-duration p95 varied from 14.27 to 16.98 ms. Separate trace
attribution located native modal premount and window-relayout cost; no capture
optimization or speedup is accepted. See
[matched capture control and native cost](android-capture-cost-2026-09-13.md).

The earlier direct-export failure was reproduced twice, then fixed by skipping
filesystem-path preparation for Android document-provider write URIs. On the
same Downloads provider, candidate JSON and CSV exports matched reference bytes;
all 1,034 TaskNotes ZIP entries matched with valid CRCs and timestamp-only metadata
differences. Focused tests, typecheck, lint and independent review passed. See
[document-provider backup writes](android-document-write-2026-09-13.md) for the
red regression, exact APK/map identities, diagnostic marker, native readback,
limitations and restored-device evidence. The fix is accepted; source and CI
provenance are described above.

September 13 Android continuation: the connected OnePlus device is available.
The new runner requires the expected runner APK hash, coherent per-frame sample
counts, a trace for every iteration, and exactly-one Inbox growth on capture-save.
A real-device failure also replaced the obsolete Close/ViewGroup selector with a
stable header test identifier.
See [Android benchmark integrity](android-harness-integrity-2026-09-13.md) for the
fresh fixture export, schema-5 control, validation and restored-device evidence.
The completed native control retained 19 measured iterations/traces and passed
60/60 visible-IME checks. Both cancellation batches preserved Inbox 234; save
smoke grew it by the expected four tasks, then normal restore returned it to 234.
Original APK hashes, Sync Off, and global device settings were verified after
restoration. The accepted Android benchmark hardening establishes stronger
measurement evidence, not an app speedup. The source commit retains the archived
pre-commit binary and runner identities in the dated report.

September 12 desktop continuation: the native capture runner now verifies the
exact captured SQLite row through independent readback and retains structured
reload evidence. See [capture readback validation](desktop-capture-readback-2026-09-12.md).
This is a harness correctness improvement; no app speedup is established. The
fresh native control initially failed its viewport gate while the graphical
session was locked. After unlocking, exact capture/readback/reload smoke passed;
the report records one corrected virtualized-reload harness assumption. The new
schema-2 timed readback boundary requires fresh cohorts. Android device work resumed September 13; see the current continuation below.

The same continuation then removed duplicate context/tag timestamp parsing in
the shared store derivation. See [desktop token timestamp derivation](desktop-token-timestamps-2026-09-12.md).
The 10k work-count regression fell from 20,000 timestamp reads to 10,000 with
identical derived results. Two native A/B/B/A sequences passed exact capture,
SQLite readback and reload checks. Native speedup remains unestablished:
render-probe Enter-to-DOM medians were 147.0 ms control and 150.5 ms candidate
(six observations each), and automation-visible medians were higher for the
candidate. Accept this as redundant-work reduction only. The sampled 277 ms
control capture retains evidence of overlapping save serialization. Measurements
used the patch in `perf/desktop-stability-20260912` before publication; consult
Git history and exact CI runs for subsequent integration status.

September12 review addendum: iOS widget publication now performs one full
selection pass instead of six, with448 byte-identical old-source comparisons.
See [widget publication derivation](widget-publication-2026-09.md), Plan084.
Native iOS latency and WidgetKit rendering remain unmeasured; prior platform
work and open hypotheses below are unchanged.

The figures below are historical observations under each report's conditions,
not universal performance promises. Follow the links for raw samples, build
hashes, fixture sizes, safety tests, and limitations.

| Area | Implemented / established | Evidence and limits |
|---|---|---|
| Startup and loading | Canonical-data and interactive-readiness markers, production-browser runner, Android launch classification, phase separation | [Baseline contracts](baselines.md#readiness-contract). Shell/splash timing is not usable-app readiness; deep-link starts are not covered by the main-screen marker. |
| Desktop Settings | Transitions preserve visible content while lazy routes/sections load; General co-loads with Settings, other sections remain lazy | [Settings investigation](desktop-settings-2026-09.md). First Integrations medians about 412 → 158 ms; General improved strongly at 0/1k tasks, not consistently at 10k. Browser/automation timings, not native keyring or all-OS results. |
| Shared full merge | Avoid spreading normalized task winners when attachment reconciliation leaves their attachment reference unchanged | [Merge allocation](merge-allocation-2026-09.md). Paired 10k-task Bun median CPU fell about 27–31%, corroborated in Node; 420 pairs retained equal data/statistics. Not a measured phone/full-network sync speedup. |
| Native desktop snapshot writes | Reuse prepared INSERT statements without changing transaction or snapshot semantics | [Statement reuse](native-snapshot-save-2026-09.md). Isolated 10k-task save median 2461 → 1901 ms, three samples per mode. The experimental one-second target was not met by this change. |
| Native desktop capture persistence | Append only new tasks when the canonical result preserves all existing tasks and other entities/settings exactly; otherwise retain full replacement | [Append-only path](native-append-capture-2026-09.md). Isolated save median 1792 → 465 ms; small native A/B/B/A readback median 2532 → 1081 ms. Not a general differential writer; visibility did not initially improve. |
| Desktop pre-save preparation | Structurally equal cloned snapshots skip fingerprint preparation, with the old fingerprint rule retained as mismatch fallback | [Baseline equality](storage-baseline-equality-2026-09.md), `552707a59`. Isolated 10k-task median 34.03 → 5.05 ms; deterministic zero-serialization and compatibility tests. Intermittent slow visible captures remained. |
| Shared serialization / desktop self-write tracking | Reuse at most eight property-name layouts within a traversal; read values fresh and retain identical canonical bytes | [Property ordering](watcher-property-order-2026-09.md), `e744235c4`. Watcher regression 503 sorts → fewer than ten; isolated median 9.89 → 8.56 ms. No deferred snapshot or cross-call cache. |
| Shared token statistics / desktop capture | Parse each eligible task's token timestamp once for both context and tag accumulators | [Timestamp derivation](desktop-token-timestamps-2026-09-12.md). Work-count regression 20k → 10k reads; old-source output/identity equivalence. Native capture speedup unestablished; 32 A/B/B/A runs including warm-ups passed exact readback/reload gates. Android native benefit unmeasured. |
| Mobile quick-capture rendering | Stabilize the context value when its action callback is unchanged; propagate changed actions/options normally | [Capture context](capture-context-2026-09.md), `3d67289a9`. Regression reduces three consumer renders to one. All 20 phone keyboard checks and three sampled capture iterations passed; overall latency improvement is not established. |

## Measurement and stability safeguards added

- Native desktop capture checks canonical readiness, then actual save-queue
  quiescence rather than an arbitrary sleep. Independent SQLite readback,
  exactly-once capture, and reload survival remain required. See
  [save-idle boundaries](native-save-idle-2026-09.md).
- The in-page render probe separates DOM appearance from WebDriver overhead;
  opt-in JSC sampling locates pre-frame work. See
  [append visibility follow-up](native-append-capture-2026-09.md#capture-visibility-follow-up)
  and [native capture sampling](native-capture-sampling-2026-09.md).
- `NATIVE_INVOKE_PROBE=1` adds bounded, allowlisted command completion records
  through a profiling-only Mindwtr transport. It requires render/idle mode,
  preserves Tauri internals and operation identity, and rejects lost ownership
  or incomplete observations. [Completion validation](desktop-invoke-completion-2026-09-13.md).
- On this dual-monitor niri workstation, `NATIVE_VIEWPORT=1200x800@2` targets
  only the verified Benchmark executable's window. Requested/actual dimensions,
  scale, and transient resizes are checked; other windows/display settings are
  untouched. [Fixed-viewport A/B/B/A](fixed-viewport-2026-09.md),
  `e96858a3c`, completed the previously invalid property-order comparison:
  Enter-to-DOM 142 → 139.5 ms (essentially unchanged), independent readback
  1004.3 → 927.3 ms (descriptive, six observations per build).
- Android capture benchmarks require **visible IME**, not just input focus:
  ten cold launches plus ten warm opens must pass before timing. App and runner
  hashes are checked before and after the batch. See
  [keyboard acceptance](capture-focus-2026-09.md#automatic-acceptance-gate-and-rendering-follow-up)
  and [identity checks](mobile-navigation-2026-09.md#benchmark-identity-fix).
- Profiling flags now version Metro transforms and are Gradle bundle-task
  inputs (`131ca1276`). Native sampler presence alone was insufficient: stale
  JS contained a no-op start function. Require a fresh nonempty profile after
  one manual capture before a long batch. See
  [profiling-cache isolation](profiling-cache-2026-09.md).
- Synthetic restart/endurance tests cover pre-commit termination, injected write
  errors, post-ack termination, stale snapshots, three-peer convergence, and
  lost remote acknowledgements. A 100-round run passed 600 cycle samples during
  the merge investigation. This is not hardware power-loss, actual disk-full,
  real cloud concurrency, or native background recovery evidence. See
  [reliability boundaries](baselines.md#restart-recovery-and-sync-endurance).

## Findings that remain open

- **Android capture:** native modal creation/layout, window add/relayout/removal,
  and occasional system-server contention still contribute to missed frames.
  React/Fabric/GC work also precedes opening. The latest context candidate's
  sampled frame-overrun p95 was +7.03 ms versus +7.13 ms control, but its worst
  overrun was higher (+16.85 versus +14.30 ms). Small non-interleaved sampling
  batches do not establish an overall speedup or regression.
- **Desktop capture:** deterministic preparation costs are reduced, but rare
  long Enter-to-DOM samples and roughly one-second automation-inclusive durable
  readback at 10k tasks remain. September 13 reproduced 256/303ms captures with
  save preparation and synchronous public invoke dispatch before DOM appearance.
  The roughly one-second post-return promise wait extends beyond DOM appearance
  and is not synchronous JS blocking or isolated SQL time. No scheduling change
  or overall speedup is established. Continue separating those save phases. Earlier
  large visibility differences did not consistently reproduce. Do not attribute
  all readback time to SQL or assume all rendering delays are fixed.
- **Scrolling and Settings on Android:** 1k-task native baselines exist, with
  occasional view-creation/mounting costs. They do not establish 10k-task,
  sustained allocation/memory, General-subpage, or sync-contention performance.
  See [mobile navigation](mobile-navigation-2026-09.md) and the later
  [native scrolling baseline](native-interactions-2026-09.md#android-scrolling).
- **Full sync:** host merge CPU improvements are proven within their test scope.
  Native merge/bridge time, encryption, network, attachment transfer, peak memory,
  and concurrent editing still need separate measurements.

## Prioritized next sessions

These are proposed work items, not completed checks or authorization to access
personal data, accounts, or additional hardware.

### P1 — Matched native interaction measurements on both platforms

**Android:** the schema-5 control and matched Newest-before-preflight A/A series
are complete. Start from the retained trace attribution, not another harness
rewrite or repetition of those batches. A possible bounded experiment is reducing
nonessential descendants in the initial 52-item native mount batch, after identifying
which can move without visible popping, missing controls, accessibility or focus
changes. Do not infer that design from the traces alone. For an accepted proposal,
build sampling-disabled control/candidate Benchmark APKs from exact sources with
identical dependencies. Keep startup/compilation settings identical;
archive each APK and verify installed hashes. Use matched fixtures and an
interleaved A/B/B/A protocol after the 20-check IME gate. Retain per-iteration
frames, thermal/refresh conditions, and failures. Collect separate sampled traces
only for attribution. Do not introduce a p95 gate from three interactions or
equate pooled frame percentiles with input latency. If reporting input-to-visible
latency, first define and validate an appropriate native presentation boundary.

**Desktop:** use fresh isolated portable profiles, fixed viewport, and idle-save
boundaries with the same archived binaries across A/B/B/A. Reproduce a slow
10k-task capture with the in-page probe and separately sample JSC/native phases.
Distinguish event handling, DOM/paint opportunity, preparation, IPC, native
transaction, recovery JSON, and independent readback. Change only the dominant
reproducible cost; extend the existing differential tests before touching writes.

September 13 completed fresh sampled control attribution and the native invoke
completion boundary. Start from those retained profiles and matching maps rather
than repeating the completed control or token-timestamp experiment. The next
bounded hypothesis is reducing synchronous save preparation or payload serialization
with deterministic output-equivalence and write-safety regressions. The two slow
captures also leave 31–68ms between invoke return and DOM appearance to attribute.
Native transaction, recovery-copy and response-handling costs remain separate
open boundaries; do not infer a scheduling design or revive the rejected deferred
watcher cache from the observed overlap alone.

Acceptance: complete comparable reports, no input/keyboard regression, exact-once
creation, durable readback and reload survival, and no weakened correctness gates.
An inconclusive result is a valid outcome; retain it and avoid speculative fixes.

### P1 — Save and edit responsiveness during real sync

Use explicitly authorized test backends/accounts and synthetic peers. Measure
desktop and phone capture, typing, task completion, and navigation during a large
merge and attachment transfer. Separate network/encryption/merge/storage/UI phases
and record peak memory. Test retry/lost acknowledgement, conflict with pending
local edits, deletion/tombstone convergence, and cancellation/backgrounding.

Acceptance: no lost or duplicate acknowledged captures, no overwritten edits or
resurrected deletions, convergence after retry/restart, phase timings from native
runtimes, and a bounded fix with a regression if a bottleneck is reproduced.
Host file-remote endurance does not complete this item.

### P2 — Large lists, cold loading, and memory

Cover desktop and phone 1k/10k fixtures, repeated navigation/scroll/edit cycles,
mounted-row bounds, offscreen work, GC/allocations, and retained memory after
returning idle. Measure cold canonical reads/migrations separately from warm
loading and IPC transfer. Profile native Settings configuration/keyring reads on
appropriate test profiles; portable Linux mode bypasses the OS keyring.

Acceptance: stable virtualization and selection/edit state, no sustained growth
across repeated cycles, complete readiness without backup-only/error/locked false
positives, and measured before/after evidence for any optimization.

### P2 — Native reliability and remaining platforms

Test capture queue replay after process termination (including native widget/
intent capture), interrupted attachments, old-version database upgrades, backup
restore, and real disk-full handling on disposable isolated storage. Preserve
SQLite/WAL durability, rollback, FTS/FK integrity, revision/CAS arbitration,
observed-ID/restore protections, and recovery-copy semantics.

Add native macOS and Windows baselines, and iOS/device coverage when hardware and
authorization are available. Linux/Chromium measurements and platform compilation
are not substitutes. Do not claim these checks have already been done.

### P3 — Sustainable regression tracking

Maintain an idle-device/native-host trend series with enough comparable batches
to estimate normal variance before choosing latency/tail thresholds. Keep CI
work-count/integrity assertions strict and hosted timing reports descriptive.
Archive exact source/build/map identities and failed runs. Record the terminal
status of exact CI runs; do not call a running workflow green.

## Rejected experiments and traps

- Immediate `onShow` focus and next-frame focus failed cold keyboard readiness;
  focused text input did not mean the IME served it. Keep the restored 120 ms
  path unless a new proposal passes the full native gate.
- Activity-local capture presentation passed correctness after inset fixes but
  worsened the comparison's frame metrics. It was **not promoted**. Read the
  [focus experiment](capture-focus-2026-09.md) before revisiting it.
- Co-loading General Settings alone did not reliably solve first-open delay;
  the accepted change also uses the route transition.
- Cloning/deferred watcher serialization was rejected as slower in the probe
  and as requiring additional snapshot/queue safety. Current reuse caches only
  field-name order within one traversal, never mutable payloads across calls.
- Never pool portrait/landscape or changing-scale runs, early-session/idle-save
  scenarios, sampled/unsampled builds, or differently sized capture-grown stores.
- Old Hermes files survive APK replacement. Pair fresh profiles with the exact
  APK's map. Root-only samples are not automatically idle time; verify scheduler
  evidence. Incomplete overlapping thread-state intervals can corrupt frame CPU
  attribution; validate interval coverage before using a span join.
- Do not add help banners or question-mark controls to main pages during
  performance/discoverability work. Keep existing task/project detail help and
  user-dismissable first-use guidance; no distracting main-page UI.

## Current local lab state and evidence

September 13 latest device restoration: only the separate Android Benchmark app
and its runner were used. The current full control/candidate JSON contains 1,034
live synthetic tasks, five tombstones and 20 projects; Inbox is 234. The older seed
export had one tombstone, and the previous session's normal restore added four
for its removed test captures. Do not treat the seed hash as the current full
snapshot hash. No task save, import or restore occurred in the latest continuation.
The [document-write report](android-document-write-2026-09-13.md) records current
export and original/restored APK hashes. A fresh original-app launch confirmed
the prior rows, Inbox 234, Newest sort, Sync Off and debug logging false. Both test
packages were stopped. Initial/final display, keyboard, animation, radio and
low-power settings match. Synthetic successful/failed exports, diagnostics and
the earlier recovery snapshot remain. Production and Dev apps were untouched.
Reconfirm state before the next experiment.

Local evidence lives under `/home/dd/.cache/mindwtr-performance-tmp/`, especially
`native-contention/`, `capture-storage-followup/`, `settings-first-open/`, and
`mindwtr-perfetto/`. Exact run directories/hashes are in the linked reports.
APKs, native executables, maps, traces, screenshots and synthetic databases are
local artifacts, not committed or guaranteed to survive cleanup. If missing,
rebuild and establish a fresh baseline; do not invent continuity from filenames.

Use isolated worktrees under `/home/dd/worktrees/Mindwtr/<task>`. Keep dependencies,
builds and `TMPDIR`/`BUN_TMPDIR` on disk under `/home/dd`, not `/tmp` or `/dev/shm`.
Preserve other work and do not reuse another session's device/window without
checking ownership. No builds/tests may overlap measured batches. No normal-app
uninstall, data clear, personal database import, or global monitor/radio changes.

## Commands and CI map

Run from the intended checkout; set disk-backed output/temp paths before large
experiments. Full invocation and safety requirements remain in
[Performance baselines](baselines.md), not duplicated here.

```bash
rtk bun run test:perf
rtk bun run test:perf-tools
rtk bun run test:reliability
rtk bun run perf:web
rtk bun run perf:storage
rtk bun run perf:native
rtk bun run perf:android-interactions
```

The runners requiring explicit device, synthetic-data or binary identity
configuration must not be run with guessed values. Run relevant correctness,
typecheck/lint, native tests, and diagnostic-ledger tests for the changed path.

- [CI](../../.github/workflows/ci.yml): push/PR unit checks, cross-platform performance
  budgets and benchmark harness regressions.
- [Performance Baselines](../../.github/workflows/performance-baselines.yml): weekly
  Monday/manual, sequential production-browser/storage/reliability reports and
  Android runner compilation; **no physical-phone measurements**. It does not
  automatically run on every push. Artifacts currently retain for 90 days.
- [Native Platform CI](../../.github/workflows/native-platform-ci.yml): path-filtered
  native checks; compile/test success is not a native performance benchmark.
- [Diagnostics ledger](../release-notes/diagnostics-ledger.md): authoritative
  release markers and what they prove. Hidden/complicated production fixes need
  a privacy-safe marker and sanitizer test as required by `AGENTS.md`; do not
  infer durable saves or speed from a marker that only proves a path ran.

## Suggested skills and next-session reporting

The project-local `$mindwtr-performance-loop` skill follows this measurement,
correctness, fix, validation and handoff cycle. In this lab it is exposed through
Mindwtr's `.codex/skills/` link; its maintained source is in the private
`mindwtr-agent` repository, not the public app tree. A standalone clone can follow
this handoff and the public baseline guide without that private skill.

Use `diagnosing-bugs` for one reproducible bottleneck; `perfetto-trace-analysis`
and `android-emulator-testing` for device work; `mindwtr-design-guardrails` before
any persistence/sync/status/settings change; `sync-device-testing` for authorized
real-backend acceptance. Use `apple-design` / `ui-ux-pro-max` if a measured fix
changes interaction or layout. Follow the active session's delegation rules;
this handoff does not authorize subagents.

After each session, update this index with the new source commit, evidence link,
accepted/rejected result, exact validation and CI status, remaining limitations,
next bounded hypothesis, and restored device/window state. Keep detailed raw
measurements in a dated report rather than accumulating them here. A successful
microbenchmark, passing build, and completed platform audit are different claims.
