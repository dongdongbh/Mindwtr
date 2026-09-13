# Desktop token timestamp derivation — September 12, 2026

## Change and acceptance boundary

The shared store derivation now parses a task's token-usage timestamp once and
passes it to the context and tag accumulators. A 10,000-task work-count regression
drops from 20,000 timestamp reads to 10,000. Deleted tasks and tasks without tokens
still avoid timestamp reads. The fallback remains valid `updatedAt`, then valid
`createdAt`, then zero; there is no retained or cross-call cache.

This is a bounded reduction in redundant derivation work. It changes no writes,
date interpretation, status/visibility rules, token statistics, or persistence
acknowledgements. The separate save-serialization delay remains open. Native
comparison results are recorded below; this report does not complete the desktop
audit or establish Android performance.

The measurements used an uncommitted patch in
`/home/dd/worktrees/Mindwtr/desktop-stability-20260912`, branch
`perf/desktop-stability-20260912`, based on
`80dede27c78a4737d144bb4b81052cdc9b9a6406`. These local results predate publication;
Git history and the exact CI runs establish subsequent integration status.

## Control and attribution

The [capture readback validation](desktop-capture-readback-2026-09-12.md) records
the fresh control build, environment and initial locked-session failures. After
unlocking and correcting the virtualized-reload assertion, fresh unchanged A/A
batches passed with one excluded warm-up and three measured captures each:

| Batch | Automation-observed visibility, ms | Exact SQLite readback, ms |
|---|---|---|
| `control-aa-a/desktop-dXbNLP` | 171.72, 162.73, 156.55 | 975.70, 855.41, 870.57 |
| `control-aa-b/desktop-yTwstI` | 170.39, 143.58, 147.11 | 894.21, 834.20, 932.49 |

These six shared-host observations establish descriptive variability, not a tail
gate. They use report schema 2 and scenario
`portable-native-settings-capture-idle-v3`; old count-only cohorts are incompatible.

A separate JSC smoke and ten measured sampled captures used the same control
executable and its exact archived source maps. The ten Enter-to-DOM observations
were 152, 134, 277, 163, 142, 165, 161, 152, 131 and 176 ms. Each capture retained
113–237 stack samples. The recurring chain was:

`useListViewOptimizations.getDerivedState` → `computeTaskDerivedState` →
context/tag accumulator `add` → token timestamp parsing.

The token-usage module appeared in 26–42 inclusive stack samples per measured
capture. Both accumulators parsed the same timestamp. The 277 ms sample also
included storage-adapter, sync-helper, local-data-watcher and native stringify
frames. Sharing token timestamps does not explain or eliminate that extra work.
Inclusive stack counts overlap and are not additive CPU milliseconds. DOM
appearance and the next animation-frame opportunity do not prove compositor
presentation.

## Correctness and checks

The new work-count tests failed before implementation: the single-task probe
read valid `updatedAt` twice, and the 10k probe read it 20,000 times. The old run
had 64 passing and two failing tests. After implementation the focused core
suite passed 67 tests with 188 assertions.

A separate old-source differential harness passed two tests with 28 assertions,
comparing the complete derived result and context/tag usage. It covers every
task status, duplicate/whitespace/prefix-mismatched tokens, deleted tasks, missing
or empty arrays, invalid dates and fallback, epoch zero, provided-map and task
identity, and a changed timestamp on a second derivation. Its reference preserves
the old timestamp parser and accumulator independently of the candidate helper.

Core and desktop typechecks/lint passed; core lint retained three existing
`no-explicit-any` warnings in unchanged `task-status.ts`. Diagnostic sanitizer and
ledger governance passed nine tests. The isolated `bun run test:perf` passed
seven core budgets, two desktop ListView/Timeline tests and six mobile JavaScript
fixture tests. Those mobile fixtures are not native phone evidence.

The desktop release marker `v1.3.0/derived-token-timestamps` logs once per WebView
session after a list commits with nonempty token statistics. It proves the new
derivation is available to that list, not a measured speedup or durable save.
The ledger documents this boundary; no task content or dates are logged.

Independent Sol review found one unintended public export through the package's
existing wildcard. The root entry now explicitly preserves all seven original
runtime exports and `TaskTokenUsage`, excluding the internal timestamp helper.
A live export-identity check and repeated core/desktop typechecks passed. The
reviewer's bounded correction pass confirmed the issue resolved with no remaining
findings. The pre-correction build is retained but excluded from comparison.

## Native comparison

The final candidate and control were release Tauri builds with identical lockfile
hashes, product configuration, build flags and runtime. Both retain startup
profiling support; the first timing sequence disabled the capture render probe,
JSC sampler and diagnostics. A separate sequence enabled only the in-page render
probe. Cohorts are not pooled across profiling modes.

| Build | Executable SHA-256 |
|---|---|
| Control | `c1bb07e750ef45852a7812acd1d082bf1debfae8c5ad9fb6fe37ec8772311c1b` |
| Final candidate | `f1fe4ce16c79e2776f8b72362d649c4ae54f06efe17e55d9b71b8b1724386493` |

Each sequence used A/B/B/A order, one excluded warm-up plus three measured runs
per batch, or six measured observations per build. Each run used a fresh portable
profile with 10,000 synthetic mixed-status tasks, 20 projects, no sections/areas,
sync Off, viewport 1200 x 800 @ 2 and actual save-queue quiescence. Exact-once
capture, independently read SQLite identity/content and visible reload survival
remained mandatory. No builds or unrelated tests overlapped measured batches.
All six native runner/helper hashes match the earlier unlocked controls.

The sampling-disabled timing sequence passed all 16 runs, including warm-ups:

| Metric, ms | Control median (range), n=6 | Candidate median (range), n=6 |
|---|---|---|
| Automation-observed capture visibility | 164.77 (140.60–311.95) | 182.25 (158.28–259.13) |
| Exact SQLite readback | 947.89 (883.73–998.76) | 943.47 (896.31–1067.80) |
| Settings opening | 170.05 (135.57–202.36) | 149.46 (123.75–186.46) |
| Integrations opening | 90.43 (60.84–122.65) | 68.78 (59.58–94.01) |

The candidate's visible-capture median was higher, while durable readback was
essentially unchanged. The control itself varied between its first and last
batches. This small shared-host sequence establishes neither a speedup nor a
release tail gate. Recorded host snapshots showed thermal-zone 2 at 61–78 C and
I/O pressure `some avg10` around 31–39%; those snapshots do not attribute individual
interaction delays to a particular process or phase. All slow samples are retained.

The separate render-probe-only sequence also passed all 16 runs:

| Metric, ms | Control median (range), n=6 | Candidate median (range), n=6 |
|---|---|---|
| Enter to DOM appearance | 147.0 (139–158) | 150.5 (127–173) |
| Enter to animation-frame opportunity | 147.5 (139–158) | 151.0 (127–174) |
| Automation-observed capture visibility | 171.15 (163.54–178.22) | 189.04 (148.50–226.54) |
| Exact SQLite readback | 942.80 (914.38–1008.50) | 961.31 (904.96–1028.05) |
| Settings opening | 174.42 (142.56–213.28) | 201.65 (138.03–219.72) |
| Integrations opening | 71.14 (62.33–109.28) | 58.83 (52.76–109.93) |

These measurements show no established native capture speedup. The candidate's
Enter-to-DOM median was 3.5 ms higher, with overlapping ranges; automation-visible
medians were higher in both sequences. The change is accepted only for the
deterministic reduction in redundant work with preserved correctness. The small
cohorts neither certify native performance parity nor establish a release-tail
regression. The prior intermittent save-related delay remains open; no slow
sample was removed and no budget was lowered.

A final candidate JSC smoke passed its excluded warm-up and one measured capture,
retaining nonempty profiles with matching archived maps. The measured capture
was 150 ms Enter-to-DOM, 151 ms to the next frame opportunity, with 132 samples;
the token-usage module appeared in 33 inclusive stacks. That is within the
control's sampled range and supplies no additional speedup evidence. Raw profiles
and symbolicated copies remain separate from both timing sequences.

## Reproduction and remaining work

Artifact root:
`/home/dd/.cache/mindwtr-performance-tmp/desktop-stability-20260912/`.

- `builds/control/`: release executable, matching bundle/maps, source and hashes.
- `builds/timestamp-candidate-r2/`: final candidate with matching maps/source.
  `builds/timestamp-candidate/` retains the pre-export-correction build; the
  corrected source rebuilt to the same executable hash.
- `control-aa-a/`, `control-aa-b/`: unsampled A/A controls.
- `control-jsc-smoke/`, `control-jsc-investigation/`: original sampled reports,
  raw profiles, symbolicated copies and `jsc-summary.json`.
- `analyze-jsc.mjs`: mapping against exact archived asset filenames and hashes;
  native or invalid coordinates are not guessed.
- `timestamp-perf-budgets.log`, `timestamp-vite-build.log`,
  `timestamp-native-build.log`, `timestamp-r2-*-build.log`: isolated validation/build outputs.
- `timestamp-timing-ready-{a1,b1,b2,a2}/` and
  `timestamp-timing-ready-comparison.json`: complete sampling-disabled sequence.
- `timestamp-probe-{a1,b1,b2,a2}/` and `timestamp-probe-comparison.json`:
  separate render-probe sequence. Each batch retains raw samples, screenshots,
  isolated profiles, command environment, driver logs and before/after host state.
- `timestamp-candidate-jsc-smoke/desktop-OIj7IF`: separate final candidate
  sampling smoke, original profiles, symbolicated copies and summary.
- `final-runner-hashes.json`: the unchanged six runner/helper hashes.
- Worktree `.orchestrator/tasks/desktop-token-timestamp-20260912-04/`: red/green,
  differential reference, static-check logs and implementation result.

Two pre-launch wrapper attempts (`timestamp-timing-a1` and
`timestamp-timing-diagnosis`) failed because the shell lacked `NIRI_SOCKET`.
No app or timed sample was started. The diagnostic error is retained; the wrapper
now saves stderr and the successful commands explicitly supplied the verified
niri/Wayland environment. The session remained unlocked throughout.

Final cleanup (`lab-state-unlocked-final.json`) found no owned Benchmark app or
tauri-driver remaining, unchanged compositor output settings and
`LockedHint=no`. The shared main checkout remained clean. Personal app data was
untouched, and no Android device was accessed.

Desktop next hypothesis: use the retained slow sample to separate deferred save
serialization, IPC response, transaction and recovery-copy publication before
changing scheduling or writes. Larger-list scrolling and retained-memory testing
remain separate work. Android awaits device connection and its own verified
Benchmark package, fixture, IME gate and native comparison.
