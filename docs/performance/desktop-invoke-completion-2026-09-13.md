# Desktop capture save phases, September 13, 2026

## Scope and current control

The preceding Android document-provider backup fix was committed, merged and
pushed as `fc6b606c4554cb6d58792cce044f04cf958ca1cc`. This continuation returns to
the desktop save-serialization lead in the handoff. It does not retry the rejected
watcher deferral or mobile modal/focus experiments.

Worktree: `/home/dd/worktrees/Mindwtr/desktop-stability-20260912`, branch
`perf/desktop-save-serialization-20260913`, based on that published commit.
Artifact root: `/home/dd/.cache/mindwtr-performance-tmp/desktop-save-serialization-20260913/`.

The prior final timestamp-candidate release executable is a valid current app
control: all 552 mapped app/core source files match the current checkout, all
archived executable/bundle/map hashes and both lockfiles match, and native/build
inputs have no changes from the archived source base. The pre-commit archive is
`desktop-stability-20260912/builds/timestamp-candidate-r2/`; its complete identity
and current-source comparison are retained in `control-source-identity.json`.
Executable SHA-256:
`f1fe4ce16c79e2776f8b72362d649c4ae54f06efe17e55d9b71b8b1724386493`.
This avoids treating an old filename alone as source provenance.

The Linux graphical session was unlocked and had no Benchmark window at start.
The runner uses a fresh isolated portable profile for every warm-up/measurement,
10,000 synthetic mixed-status tasks, 20 projects, Sync Off, viewport 1200x800 at
scale 2 and the actual idle-save boundary. Only the verified Benchmark window is
floated/resized. Native correctness still requires exact-once capture, independent
SQLite identity/content readback, and visible reload survival. Android and normal
app profiles are not accessed in this continuation.

## Retained slow-frame attribution

The previous 277ms sampled capture and 134ms comparator were analyzed against
their original control maps, separately from the current timestamp-candidate
control. Their inclusive stack counts are not additive CPU milliseconds.
The dated token-timestamp report retains the original source/binary identities;
`attribution/` here retains exact mapped source lines and reproducible analysis.

The slow archived profile has 13 distinct stacks on the changed-entity
baseline/equality path (indices 131–143), followed by 29 on the watcher signature
path (144–172). The latter contains 23 recursive normalization stacks and six
fully attributed native `stringify` leaves. Another 27 `stringify` leaves lack a
mapped target-module caller and remain unattributed. The comparator has zero for
these target paths. Mapped source proves ordinary baseline construction and
self-write signature preparation; it does not prove IPC, SQL or recovery duration.

JSC timestamps preserve ordering within the raw profile, but no retained clock
snapshot relates that clock to page `performance.now()`. Similar total spans do
not supply the missing offset. New instrumentation must use the page clock for
both invoke events and the existing capture render probe.

## Fresh sampled control

An initial wrapper attempt failed before launching an app because the shell
omitted `NIRI_SOCKET`. It is retained as `control-jsc-wrapper.log`; the working
invocation explicitly supplies the already verified graphical-session sockets.
The first launched batch, `control-jsc-ready/desktop-HODvpw`, passed all six
warm-up/measured correctness cases, but an archived-profile analysis overlapped
it after the analyst's initial pause acknowledgment. It is retained as confounded
and excluded from clean timing claims (`contamination-note.md`).

The replacement `control-jsc-clean/desktop-nBjwFh` ran with no builds, tests or
trace processing alongside it. One warm-up and all five measured captures passed
exact-once save, independent SQLite readback, idle-save and visible reload gates.
Original runner/helper hashes matched before and after. JSC sampling was enabled;
these are diagnostic observations, not uninstrumented latency baselines.

| Measured run | Enter-to-DOM ms | Independent readback, automation ms | Storage-adapter stack samples |
|---|---:|---:|---:|
| 1 | 303 | 1123.62 | 53 |
| 2 | 148 | 1122.79 | 0 |
| 3 | 180 | 1096.98 | 0 |
| 4 | 305 | 1247.87 | 54 |
| 5 | 162 | 1059.63 | 0 |

The same signature recurred: both 300ms captures contain save preparation in the
sampled opening interval, while the three faster captures contain none. This is
attribution evidence for the next measurement boundary, not proof of a safe
scheduling change. Original JSC profiles, separately symbolicated copies,
`current-control-attribution.json` and matching maps are retained.

## Completion probe

The existing runner's optional fetch probe times response headers only. The new
`NATIVE_INVOKE_PROBE=1` observes public native-invoke entry, synchronous return,
and promise settlement in the same page clock as Enter/DOM/frame opportunity.
It requires the render probe and idle-save mode and retains a separate
`native-invoke-completion-v1` profiling label.

The initial direct-wrap prototype was rejected before native execution: pinned
Tauri 2.9.4 defines `__TAURI_INTERNALS__.invoke` without writable/configurable
attributes. The final implementation leaves that object untouched. Instead,
`VITE_STARTUP_PROFILING=1` exposes a versioned Mindwtr-owned transport around the
public `@tauri-apps/api/core` invoke function, after the existing dynamic import.
The runner installs its observer only after canonical synthetic fixture checks.
The ordinary flag-disabled build retains the direct public-invoke path; all 45
compiled JavaScript chunks were checked and contain none of the transport hook,
label or ownership-error strings. Source maps are excluded from that assertion
because their `sourcesContent` can retain code removed from executable output.
See `normal-bundle-profiling-absence.json`.

Only command names (`save_data`, `save_task`, `get_data`), sequence, numeric clocks
and outcomes enter the evidence. Arguments, payloads, results and errors are not
retained. The wrapper preserves receiver, argument count, synchronous exceptions
and original promise identity. A 64-call bound, strict shape/clock validation,
pending-call rejection and scoped restoration prevent incomplete evidence from
silently becoming a timing result. Existing exact capture, independent SQLite
readback, save-idle and visible reload gates remain mandatory.

Entry-to-return measures synchronous public-invoke dispatch. The later interval
includes native work, response handling and callback delivery; it does not isolate
SQL or recovery-copy writing, and promise fulfillment does not establish hardware
durability. JSC's separate clock still cannot be directly subtracted from these
page clocks. No save scheduling, acknowledgment, retry, transaction or watcher
semantics change.

## Validation

Host checks passed: 30 focused performance tests, 14 desktop transport tests,
desktop typecheck and lint, and the full 100-test performance-tool suite (730
assertions). The retained red tests cover missing evidence, unsupported cohorts
and the corrected public-transport seam. Logs are under `invoke-probe/`.

Independent review found two evidence-integrity gaps: ownership loss could leave
a partial observation that passed validation, and a throwing `then` getter could
look like synchronous fulfillment. Both were reproduced by red tests and fixed
in the runner helper. Stop now invalidates evidence after target/wrapper ownership
loss while preserving a later owner; getter/attachment exceptions return the
original result but invalidate the observation. The correction passed 9 probe
tests, 17 affected focused tests and all 102 performance-tool tests (742 assertions).
The bounded independent correction review found no remaining source issues.

The profiling Vite and release Tauri builds passed. The fresh Benchmark archive
is `builds/invoke-probe/`, with executable SHA-256
`e663e22d45b7ffbeaaeadde0fad14ad0a07a85584399840a6d4021dfb35cc87a`.
All 96 archived executable/bundle/map hashes were verified, and the transport's
mapped source matches the tested checkout. The subsequent review correction
changes only runner-injected code, so it does not require an app rebuild.
`invoke-runner-hashes-before.json` and `runner-source-final/` retain the exact
runner/helper source independently of the executable's build-time source patch.

## Native completion evidence

Three fresh batches passed every capture/readback/idle/reload check:

- `invoke-probe-smoke/desktop-E8p9NZ`: one warm-up and one measured capture,
  with render and completion probes, without JSC sampling.
- `invoke-probe-sampled/desktop-pfxKM3`: one warm-up and five measured captures,
  with render, completion and JSC probes.
- `invoke-probe-disabled-smoke/desktop-2WsGvY`: one warm-up and one measured
  capture with all three optional probes disabled. The report retains
  `profiling: none` and contains no invoke-probe evidence or summary.

All eight enabled cases recorded exactly one fulfilled `save_data`, with zero
pending/failed observations and no overflow. No builds, tests or trace processing
overlapped these batches. Analysis ran after measurement; executable and runner
hashes remained unchanged. Raw profiles, host conditions and all warm-ups remain
in their original directories.

The nonsampled smoke measured 147ms Enter-to-DOM, followed by invoke entry at
216ms, synchronous return at 251ms and settlement at 1340ms. The sampled measured
cases below use the same page clock, with Enter set to zero and values rounded
to the observed millisecond precision. DOM and frame-opportunity clocks coincide
in these cases; neither establishes physical pixel presentation.

| Run | DOM ms | Invoke entry ms | Return ms | Settlement ms | Synchronous dispatch ms | Post-return wait ms |
|---|---:|---:|---:|---:|---:|---:|
| 1 | 126 | 189 | 224 | 1215 | 35 | 991 |
| 2 | 151 | 215 | 252 | 1269 | 37 | 1017 |
| 3 | 303 | 198 | 235 | 1288 | 37 | 1053 |
| 4 | 256 | 188 | 225 | 1316 | 37 | 1091 |
| 5 | 137 | 209 | 245 | 1257 | 36 | 1012 |

In the two slower cases, synchronous invoke dispatch occurs before DOM appearance;
in the other three, it occurs afterward. Promise settlement is later than DOM
appearance in every case. The larger post-return interval therefore cannot be
treated as synchronous JavaScript blocking or isolated SQL time. Raw values and
the interval/clock assertions are retained in `invoke-timeline.json` per enabled
batch and reproduced by `invoke-timeline.py`.

Exact candidate maps corroborate overlapping preparation in the two slow sampled
cases: each has 42 storage-adapter stacks; watcher stacks number 31 and 30. Each
contains six native `stringify` leaves with watcher callers, plus 28 and 30 with
public Tauri API callers. These are inclusive stack observations, not additive
CPU milliseconds or a direct alignment of JSC timestamps to the page clock.
The three faster profiles contain zero storage-adapter/watcher stacks. Their
sampling windows finish before the observed save invocation; absence from those
profiles does not mean the save work disappeared. One fast profile also contains
a single public Tauri `stringify` leaf whose command is not identified by the
stack alone. The original archived profile's callerless leaves remain unattributed;
the new evidence does not retroactively supply their missing callers.

See `analyze-invoke-jsc.mjs`, `summarize-invoke-attribution.py`, the sampled batch's
`attribution.json` and separately symbolicated profiles. Only the new archive's
matching maps are used for this batch.

## Outcome and next boundary

Accept the probe as a benchmark evidence improvement. This change establishes
neither an app speedup nor a release latency percentile. The new diagnostic cohort
has extra instrumentation and cannot be compared with the earlier control as an
optimization result. App save scheduling and persistence semantics remain unchanged.

The next desktop hypothesis is reducing reproducible synchronous save preparation
or payload serialization before rendering, with output-equivalence and write-safety
regressions before implementation. The 31–68ms between synchronous invoke return
and DOM appearance in the two slow cases also remains to attribute; it cannot be
assigned to native waiting from these observations. Native transaction, recovery
copy and response handling still need separate boundaries if persistence latency
becomes the target. Do not revive the rejected deferred watcher/snapshot cache
solely because dispatch sometimes precedes DOM appearance.

Final lab verification found the session unlocked, display outputs unchanged, and
no Benchmark window, owned benchmark process or `tauri-driver` left running
(`final-lab-state.json`). Android and normal app profiles were not accessed.
The preceding published Android fix remains on `main` with all jobs in
[CI 34742804799](https://github.com/dongdongbh/Mindwtr/actions/runs/34742804799)
successful. This desktop continuation was validated on
`perf/desktop-save-serialization-20260913` before source commit `e282fa6e1`.
The preceding Android CI does not certify these instrumentation changes; check
the CI run for the current pushed `main` revision for integration status.
