# Desktop capture readback validation — September 12, 2026

## Result and scope

The Linux native benchmark now independently verifies the captured task's exact
ID, title, Inbox status and live state in SQLite. The previous timed endpoint
checked only that the table grew by one row; content verification used app IPC.
That could accept unrelated row growth as the capture's durable boundary.

This is a benchmark correctness improvement. It changes neither production app
code nor save scheduling, SQLite durability, revision/CAS or recovery behavior.
It does not establish an application latency improvement or complete the desktop
performance/stability audit. No release diagnostic is added because no production
path changed. The evidence below was collected from the isolated worktree before
publication; local validation does not certify a later integration or CI run.

The reader checks fixture count and absence of the capture before Enter, then
uses a single consistent read-only SQLite snapshot to check exact captured
identity/content and total count. It retains the existing five-second busy wait
and six-second child-process timeout. After canonical WebView reload, the same
row must be visible and independently readable. Missing or mismatched stored
before/after/reload evidence fails report validation.

Native report schema is now 2. Scenarios are
`portable-native-settings-capture-idle-v3` and
`portable-native-settings-capture-v2` (early-session). Their stronger timed
readback boundary is incompatible with prior count-only cohorts. Historical
reports are retained as their original evidence, without relabeling.

## Fresh control and native limitation

Source: `80dede27c78a4737d144bb4b81052cdc9b9a6406`, clean when the control was built.
Worktree: `/home/dd/worktrees/Mindwtr/desktop-stability-20260912`, branch
`perf/desktop-stability-20260912`. Dependencies were installed there with
`bun install --frozen-lockfile`. Build/temp/artifact storage stayed under
`/home/dd`.

Archived Benchmark executable SHA-256:
`c1bb07e750ef45852a7812acd1d082bf1debfae8c5ad9fb6fe37ec8772311c1b`.
The archived `build.json` records every bundle/map hash, both lockfile hashes,
source/dirty state and the build configuration. It was a release Tauri build,
`VITE_STARTUP_PROFILING=1`, hidden Vite source maps, two Cargo build jobs, product
`Mindwtr Benchmark`, identifier `tech.dongdongbh.mindwtr.benchmark`.

Fixture: `mixed-v1-10000-c5d46363f404ddd5`, 10,000 synthetic mixed-status tasks and
20 projects (no sections or areas), fresh portable profile per attempt; sync Off. Initial import is separate from
post-refresh readiness, and all attempts selected save-idle mode with sampling
and the render probe disabled. No build or test overlapped these attempts.

Host: Linux 7.1.11-arch1-1 x86_64, Wry 0.53.5/WebKitGTK, Intel i7-8700 (12 logical CPUs), Bun 1.3.3, Node v22.23.2,
Rust/Cargo 1.91.1. Both monitor modes were approximately 60 Hz, compositor scale
1.5; WebKit reported device scale 2. Requested owned viewport: 1200 x 800 @ 2.
Full environment, output modes, thermal values and host pressure are archived.
This is a shared workstation, not an idle-device release-tail lab.

Five warm-up attempts failed before any measured capture. The owned window
remained 2560 x 1440 @ 2. Explicit Wayland selection and moving sizing after
canonical import/save-idle did not resolve it. A diagnostic run confirmed native
visible=true, fullscreen=false, maximized=false; niri size actions returned
success without the requested geometry. `loginctl show-session 2` then reported
`LockedHint=yes`, with zero focused niri windows. Those attempts were made while the session was locked; they were not evidence
of an app performance regression. The unlocked follow-up below resolved the
viewport failure.

No failed observation was dropped or turned into a latency result. There are no
accepted A/A, A/B, capture percentile or speedup figures from these attempts.
Temporary viewport experiments were archived and removed. The runner now names
canonical-readiness, owned-window, viewport and exact-readback timeout boundaries
so these failures are easier to locate.

## Validation

The regression was red against the original implementation: the report validator
accepted a nominally passed sample without independent captured-row evidence.
The initial focused run recorded 5 passing tests, 2 failures and a missing-helper
load error. After the fix, the focused helper/report suite passed 13 tests with
63 assertions, including a real SQLite query containing an apostrophe in the
synthetic title.

The final `bun run test:perf-tools` suite passed **88 tests across 14 files**
(614 assertions, 51.39 seconds), including the focused SQLite/report regressions.
The runner's `node --check` passed. The new reader also read the actual
native-generated 10,000-task SQLite database from the retained control profile,
confirming its expected count and absent capture title without changing it.

The clean control frontend and release native builds passed, as did the desktop
typecheck. The unchanged benchmark-tool suite had passed 80 tests across 13 files
(46.01 seconds). These are build and harness correctness results, not native
latency evidence. Production app code is unchanged, so app-wide/native unit and
hot-view performance suites were not repeated for this tooling-only patch.
Independent Sol implementation review found no code defects and one conflicting
early-session version sentence in the baseline guide; that sentence was corrected.
The leader accepted the tooling correctness change with the native limitation
retained. The subsequent unlocked native smoke passed, as described below.

The first publication CI run on September 13 (`34737920122`) passed the large-store
budgets but exposed a test portability defect: the SQLite fixture directory used
the lab machine's hard-coded `/home/dd`. The test now uses the platform temporary
directory, honoring `TMPDIR` for disk-backed local runs. This only changes the
small disposable test database's location; native runner and application behavior
and the measured build identities are unchanged.

## Unlocked native follow-up

After the user unlocked the desktop, `LockedHint=no` and the existing fixed-window
helper immediately achieved 1200 x 800 @ 2 with the same archived control binary.
That resolves the earlier viewport blocker without changing app or compositor
configuration.

The first unlocked warm-up (`unlocked-smoke/desktop-12uD20`) proved exact captured
SQLite identity/content, then failed the newly added visible-reload check. Its
Inbox was correctly virtualized: reload starts at the top while the appended
capture is at the bottom. The harness now scrolls the actual Task list to its end
before requiring the exact row to be visible. This occurs after all timed
capture boundaries and retains the same independent reload-readback assertion.

`unlocked-smoke-scroll/desktop-IiZNOR` then passed its warm-up and one measured
iteration, including all schema-2 capture evidence, canonical/save-idle gates,
viewport checks and reload survival. The measured iteration was 166.91 ms to
automation-observed visibility and 954.58 ms to exact SQLite readback. One sample
is a smoke result, not a speedup or tail-latency estimate. The rejected initial
unlocked warm-up is retained separately.

## Retained evidence and next steps

Artifact root:
`/home/dd/.cache/mindwtr-performance-tmp/desktop-stability-20260912/`.

- `builds/control/`: executable, matching `dist`/maps, hash manifest and source patch.
- `environment-start.json`, `control-build.log`, `control-typecheck.log`,
  `control-perf-tools.log`, `final-perf-tools.log`, `lab-state-final.json`: fresh
  control provenance, checks and cleanup verification.
- `aa-1/`, `aa-wayland-1/`, `viewport-diagnosis/`, `viewport-after-ready/`,
  `native-window-state/`: all failed warm-ups, reports, synthetic profiles,
  screenshots, driver logs, commands and host snapshots.
- `viewport-diagnostic-runner.mjs`, `window-blocker.txt`: rejected setup probes.

Only copied Benchmark executables and fresh synthetic profiles were launched.
Every attempt's driver process group was stopped. A final process check found
no owned Benchmark app remaining, and compositor output settings matched the
initial snapshot. Personal app data and global monitor settings were untouched.
No Android device was accessed.

Desktop continuation: fresh unchanged A/A controls and a separate sampled cohort
now pass. The resulting bounded app change and matched comparison are recorded
in [token timestamp derivation](desktop-token-timestamps-2026-09-12.md). The
harness-only checks above remain scoped to this readback fix.
Android next step: wait for the user's device connection, then verify the separate
Benchmark package and synthetic state before its own performance work.
