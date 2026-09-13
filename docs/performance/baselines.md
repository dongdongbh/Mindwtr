# Performance baselines and profiling

Measure before optimizing. Keep fast CI budgets (`bun run test:perf`), production UI
measurements, and native device traces as separate layers. A faster splash screen is
not a faster usable app; a browser timing is not a native launch timing.

For completed optimizations, rejected experiments, remaining work and the next-session
checklist, start with the [performance and stability handoff](stability-handoff.md).

## Readiness contract

| Signal | Meaning | Clock |
|---|---|---|
| Mobile `js.shell_ready`, `js.splash_hidden` | Shell/splash transitions only | Since JS profiler module load |
| Mobile `js.local_data_ready` | Canonical fetch returned without a store error; not the early backup snapshot | Since JS profiler module load |
| Mobile `js.interactive_ready` | First active Focus/Inbox/Projects screen has canonical data, nonzero layout, foreground state, and two animation-frame opportunities | Since JS profiler module load |
| Mobile `js.resume_ready` | Active, already-loaded screen received foreground state and two animation-frame opportunities | Since AppState active callback |
| Android `native.fully_drawn` | That screen requested `Activity.reportFullyDrawn()`, once per Activity | Absolute monotonic uptime marker; not a duration |
| Desktop `bootstrap`, `storage_adapter_ready`, `shell_ready`, `local_data_ready`, `interactive_ready` | WebView bootstrap through successfully loaded, resolved Suspense content and two visible animation-frame opportunities | `performance.now()` since navigation |

The readiness marker is an **application-defined paint opportunity**, not compositor
presentation or proof of input latency. Native TTID/TTFD includes work outside JavaScript;
do not subtract or combine unrelated clock origins. Deep-link capture/task/settings starts
are not yet covered by the mobile main-screen readiness marker and must not pass as main-screen baselines.
Failed storage loads, backup-only rendering, locked mobile content, and hidden screens
must not report successful readiness. Instrumentation never changes hydration or save acknowledgment.

`EXPO_PUBLIC_STARTUP_PROFILING=1` enables detailed JS/core phase output on Android/iOS;
`VITE_STARTUP_PROFILING=1` enables desktop console phases and `performance.mark` entries.
Normal releases log one privacy-safe `Startup screen ready` line per process/document
when diagnostic logging is enabled (`v1.3.0/startup-readiness`), with elapsed time and a fixed mobile route.
No task text or profiling telemetry is uploaded. Existing optional mobile performance
diagnostics still cover mutation, persistence, list derivation/commit, and navigation.

## Production browser baseline

From the repository root, with dependencies and Chromium installed:

```bash
bunx playwright install chromium
VITE_STARTUP_PROFILING=1 bun run desktop:web:build
DEVICE_LABEL=lab-linux RUNS=30 bun run perf:web
```

Default fixtures contain 0, 1,000, and 10,000 synthetic mixed-status tasks. Their fixed
timestamps and content hashes identify the dataset. Each size has one unmeasured warm-up
and sequential measured runs in fresh browser contexts. External requests are blocked;
the script owns its loopback production preview process, with a strict port check.
No personal browser profile, desktop database, or sync server is used.

Reports in `build/performance-web/<timestamp>/` retain raw samples, invalid runs, source
revision/dirty state, built-artifact hash, browser version, OS, device alias, and fixture ID.
They measure initial Focus readiness, Inbox navigation/capture/scroll, and first-open
General Settings and Integrations. The `fresh-context-focus-inbox-capture-scroll-settings-v2`
scenario is deliberately incompatible with the earlier capture-only baseline. At 1k/10k
tasks the runner requires real virtualization, a changed visible row window after scrolling
away from the newly captured task, and at most 100 mounted task rows before/after scrolling.
It checks bounded rendering and successful scroll response, **not** sustained frame rate.
Capture
must appear in the real list and then in the web adapter's saved localStorage document.
Interaction measurements include automation dispatch/polling overhead and are named
accordingly. This is **production browser UI**, not native Tauri startup, SQLite fsync,
or cold OS/browser-process performance. Build before measuring: the hash identifies
the actual dist files; the recorded checkout revision alone does not establish freshness.

Use `RUNS=3 SIZES=0,1000` only for a harness smoke check, never a regression verdict.
`.github/workflows/performance-baselines.yml` runs 30 samples per fixture weekly and
on manual dispatch, uploading 90-day artifacts and a job summary. Hosted hardware varies:
these runs are reporting-only. Harness failures still fail the job. Existing PR budget
gates remain unchanged, with added benchmark-tool regression tests.

### Desktop CPU attribution

Use a separate diagnostic run when navigation or Settings timings need explanation:

```bash
# Optional local source maps for resolving minified profile frames; do not publish them.
VITE_STARTUP_PROFILING=1 bun --cwd apps/desktop x vite build --sourcemap hidden
CPU_PROFILE=1 DEVICE_LABEL=lab-linux RUNS=3 SIZES=1000,10000 bun run perf:web
```

Each measured iteration retains separate Chromium `.cpuprofile` files for Inbox
navigation, first-open General Settings, and Integrations, alongside the usual
fixture/build metadata and raw samples. Open the profiles in Chrome DevTools;
retain the matching `dist` and source maps locally before rebuilding. Sampling is
1,000 microseconds using the [DevTools CPU profiler](https://chromedevtools.github.io/devtools-protocol/tot/Profiler/).
Idle samples and automation waits are not application CPU. These profiles do not
attribute native Tauri/keyring/SQLite work or GPU/compositor time.

`CPU_PROFILE` defaults off: normal baselines never open a profiling session.
Sampled runs carry `profiling: chromium-cpu-1000us`; the comparison tool rejects
them, even against other sampled runs. Use profiles to choose a change, then
measure its benefit with fresh **unprofiled** repeated runs. Failed UI actions
still attempt to retain their profile, clean up the session, and fail the run.

Measured example: [desktop Settings page transitions](desktop-settings-2026-09.md).

## Native Linux desktop interactions

`bun run perf:native` drives the real release Tauri/WebKitGTK app through
[Tauri WebDriver](https://tauri.app/develop/tests/webdriver/manual-setup/).
It requires Linux, `tauri-driver`, `WebKitWebDriver`, `dbus-run-session`, `sqlite3`,
and an unlocked graphical session. Confirm the session is unlocked before
starting. A window-size command acknowledging success does not prove the requested
geometry was applied; the runner checks the actual viewport. Build a separate
Benchmark executable first:

```bash
cd apps/desktop
VITE_STARTUP_PROFILING=1 bunx tauri build --no-bundle \
  --config '{"identifier":"tech.dongdongbh.mindwtr.benchmark","productName":"Mindwtr Benchmark"}'
cd ../..
sha256sum apps/desktop/src-tauri/target/release/mindwtr
EXPECTED_BINARY_SHA256=<the-built-executable-hash> DEVICE_LABEL=lab-linux \
  RUNS=30 SIZES=0,1000,10000 bun run perf:native
```

Use a separate worktree under `/home/dd/worktrees/Mindwtr/` on the shared lab
machine. Keep dependencies, build caches, `TMPDIR`, and `OUT_DIR` on disk under
`/home/dd`, not a RAM filesystem. `TAURI_DRIVER` may point to a privately installed
driver. Pass the graphical session's actual environment when the shell does not
inherit it; do not guess a display socket or resize other applications.

On niri, opt into a fixed comparison viewport with `NATIVE_VIEWPORT=1200x800@2`
and the graphical session's explicit `NIRI_SOCKET`. The runner first verifies
the isolated data path and Benchmark product, then finds the unique compositor
window whose PID resolves to this iteration's copied executable. Only that
window is floated and sized, always using its explicit window ID. There is no
focused-window fallback, global display change, or modification of other windows.
Unsupported/missing compositor access, ambiguous ownership, wrong scale, or an
unattainable size fails the run. Leave the option unset on other compositors.

Reports record both requested and actual viewport and the window mode. Every
sample checks the requested dimensions/scale, and a resize observer rejects
temporary changes during measured interactions. Compare only identical viewport
and window-mode cohorts. Monitor orientation alone is not a valid comparison
condition. See [the fixed-viewport follow-up](fixed-viewport-2026-09.md).

For A/B checks, set `NATIVE_BINARY` to an archived Benchmark executable and supply
its matching `EXPECTED_BINARY_SHA256`. The runner still copies it into a fresh
portable profile and checks its native identity. This avoids rebuilding between
control and candidate runs. The recorded checkout revision describes the runner's
checkout, not necessarily that archived executable; retain the artifact's source
provenance separately and compare the actual binary hashes.

Each iteration copies the hash-checked executable into a new portable directory,
seeds only synthetic JSON, and starts a separate session bus. It verifies the native
data path and Benchmark product name before proceeding. This avoids the normal
profile and single-instance connection. Portable mode also bypasses the OS keyring;
these results cannot characterize keyring latency.

The first launch completes JSON-to-SQLite import and canonical interactive readiness
before a WebView refresh. Only after the refreshed view reports canonical readiness
does the runner measure Settings, Integrations, and Inbox quick capture. Refreshing
before the first import completes can leave native work in flight and contaminate
subsequent timings. A visible shell is not a readiness gate.

The default `SAVE_QUEUE_MODE=idle` additionally observes the shared store and
desktop adapter queues before the first refresh, Settings, capture, and the final
reload. Two consecutive idle observations must have unchanged save generations.
Queued/debounced, immediate, in-flight, retrying, and pending reconciliation work
block the gate; missing hooks, malformed observations, persistence failures, and
a 60-second timeout fail the sample. The hook exists only in profiling builds,
exposes counts/booleans, and never flushes, retries, or changes save scheduling.
Each wait is retained separately from the interaction timing.

This boundary covers known local save work, not future scheduled work, other
processes, sync, or every background job. It is not proof of whole-app quiescence.
For older archived binaries without the hook, explicitly use
`SAVE_QUEUE_MODE=early-session` to omit save-idle observations. Current
idle-boundary measurements use `portable-native-settings-capture-idle-v3`
and early-session measurements use `portable-native-settings-capture-v2`.
Schema 2 strengthens the timed independent readback from a total-row count to the
exact captured task. Do not compare these cohorts with the older count-only
idle-v2 or early-session-v1 timings as a like-for-like speedup.

See [the save-queue boundary validation and local results](native-save-idle-2026-09.md).

Capture must appear in the task list, be readable from SQLite through a separate
read-only connection, and survive a WebView reload. Before Enter, the independent
reader verifies the fixture count and absence of the synthetic capture title. The
timed endpoint requires exactly one live Inbox row with the visible capture's ID
and exact title, plus the expected total count, from a consistent read snapshot.
An unrelated inserted task cannot satisfy this gate. After reload, the same task
must be visible and independently readable again. Reports retain before/after/
reload row evidence and final canonical-readiness clocks; missing evidence fails
report validation. See [the readback validation review](desktop-capture-readback-2026-09-12.md).

The reader allows a bounded five-second SQLite busy wait; time spent waiting
remains in the recorded duration. It never disables durability or modifies
application storage settings.

Reports retain raw samples, startup/import marks, fixture and executable hashes,
WebDriver capabilities, viewport, source revision/dirty state, and failure evidence.
One warm-up is excluded per fixture. Use `RUNS=1` for a smoke test; fewer than 30
samples are descriptive only and fewer than 100 cannot establish a p95 release gate.
Native reports are currently reporting-only, not input to `perf:compare`.

These are automation-observed upper bounds including WebDriver dispatch and polling,
not native process TTID, compositor input latency, or power-loss recovery evidence.
The SQLite readback check happens after UI visibility, so its duration is not an
isolated measure of disk writing. Sync is off; this does not test editing during sync.
Linux observations do not establish macOS or Windows performance. Use
`NATIVE_DIAGNOSTICS=1` only for a separate diagnostic run with Settings phase logs;
it also records allowlisted IPC command names and fetch response-header timing,
never arguments or payloads. Response headers are not the complete invoke callback
or deserialization duration. Do not compare diagnostic timings with normal runs.
Keep raw profiles and logs local.

For capture visibility diagnosis, `NATIVE_RENDER_PROBE=1` installs an opt-in
WebView observer after the pre-capture save-idle gate. It records the first Enter
keydown, the matching task row's DOM appearance with a layout box, and the next
animation-frame callback in the same `performance.now()` clock. Raw clocks and
`eventToDomMs`/`eventToFrameMs` are retained per sample. The frame callback is a
rendering opportunity, not proof that pixels reached the display. This helps
separate in-page latency from WebDriver dispatch/polling; the observer itself has
overhead, so reports carry `profiling: capture-render-probe` (combined with the IPC
label if both flags are enabled). Compare only matching diagnostic cohorts, never
these samples against uninstrumented baselines. The probe is runner-injected,
never bundled into the application, and only observes synthetic benchmark tasks.

Add `NATIVE_JSC_PROFILE=1` to that diagnostic command to retain JavaScriptCore
stack samples from the isolated Linux WebView. It requires the render probe and
labels reports additionally with `jsc-capture-1000us`. Only the child benchmark
environment exposes JSC's profiler hooks; the application binary is unchanged.
Sampling starts in the probe-installation WebDriver entry, before Enter dispatch,
and stops at the first matching-row animation-frame callback. A five-second timer
stops sampling if the frame never arrives; a timed-out or missing/empty profile
fails the run. This is not a hard real-time deadline if JavaScript is blocked.

The runner dumps stacks after the measured interaction to `jsc-samples/` inside
each isolated disk-backed profile, validates the 1 ms requested interval, and
retains the relative filename and sample count. No sandbox disabling or system
profiler installation is needed. The internal hooks are WebKit-version-dependent:
unsupported hooks fail explicitly. See WebKit's
[profiler implementation](https://github.com/WebKit/WebKit/blob/main/Source/JavaScriptCore/runtime/JSGlobalObject.cpp).
Profiles can include script URLs and function names; keep them local. They are
statistical JS stacks, not native Rust/I/O stacks, compositor traces, or an exact
wall-time allocation. The sampling timestamp has its own clock: do not directly
subtract it from the WebView's `performance.now()`. The window also includes the
short pre-Enter dispatch period. Use only matched instrumented runs for comparison.

See [the captured slow native interaction](native-capture-sampling-2026-09.md).

Measured example and outstanding save-path finding:
[native desktop and Android scrolling baseline](native-interactions-2026-09.md).

## Storage and sync processing

For desktop self-write marking, run `bun scripts/performance/watcher-mark.ts`.
It measures the actual watcher controller with a synthetic 10,000-task snapshot,
without native calls or timers. `SIZE=1..50000` and `RUNS=3..100` override the
defaults (10,000 and 7); one warm-up is excluded. JSON stdout includes every
sample and the median. Run separately from other workloads. This isolates
snapshot preparation, not durable saving or UI latency.
See [the property-order measurement and compatibility checks](watcher-property-order-2026-09.md).

For the desktop pre-save comparison identified by native capture sampling, run
`bun scripts/performance/save-baseline.ts`. It compares a 10,000-task cloned
synthetic snapshot with a new capture, asserting retained observed IDs and an
empty changed-entity baseline. `SIZE=1..50000` and `RUNS=3..100` override the
defaults (10,000 and 7); one warm-up is excluded. JSON stdout retains every
measured duration and the median. This is in-memory baseline preparation only,
not serialization across IPC, durable saving, or UI latency. Run it separately
from builds and tests. A deterministic large-store unit test additionally guards
against restoring fingerprint serialization for unchanged cloned tasks.

```bash
RUNS=10 SIZES=1000,10000,50000 bun run perf:storage
```

This creates **new synthetic databases only** under `build/performance-storage/`, never
opens a personal database, and uses the production `SqliteAdapter` and `mergeAppData`.
Override `STORAGE_OUT_DIR` with a disk-backed directory for local experiments; do not use
`/tmp` or another RAM filesystem. Databases remain beside the reports for inspection.

One warm-up precedes measured runs of canonical hydration, unchanged full-snapshot save,
JSON serialization/parsing, unchanged and one-task sync merges, one-task full-snapshot save,
and targeted task save. Integrity assertions require zero entity/settings rewrites for
unchanged saves, exactly one entity rewrite for a single edit, and committed readback from
a separate connection. WAL with FULL synchronous acknowledgement remains enabled. Initial
population is reported separately as a single descriptive observation.

These measure warm-cache disk-backed Bun SQLite and sync CPU, **not** the Tauri/RN bridge,
physical cold-cache reads, cloud RTT, encryption, attachment transfer, or end-to-end sync.
The weekly/manual workflow runs them sequentially after browser measurements and uploads
JSON reports only. Timing is reporting-only on hosted hardware; integrity failures fail CI.

Measured follow-up: [full-merge allocation and Android capture](merge-allocation-2026-09.md).

## Restart recovery and sync endurance

```bash
bun run test:perf-tools
ROUNDS=100 SIZE=1000 bun run test:reliability
```

The runner creates a unique directory under `build/reliability` and retains synthetic
SQLite databases, a synthetic file remote and a JSON report. It never accepts an existing
database or contacts a sync account. `RELIABILITY_OUT_DIR` must be on disk.

Three child-process cases exercise the production SQLite snapshot writer: SIGKILL before
COMMIT, an injected write error before COMMIT, and SIGKILL after successful save acknowledgement.
Fresh connections check SQLite integrity, complete-batch rollback or persistence, and unique
task IDs. A separate stale-snapshot test checks that a newer writer's acknowledged edit survives.
The injected error represents the adapter's error path; it does **not** simulate actual disk
exhaustion. Process termination is not evidence of hardware power-loss durability.

Three peers then edit offline and exchange data through `performSyncCycle`, rotating order
each round. SQLite connections reopen between cycles. One remote write per round succeeds
but loses its acknowledgement; retries must settle, preserve all edits, retain a tombstone
against a stale live peer, and converge across every entity field without duplicate IDs.
Virtual time advances past backoff without changing the production retry policy. This is
deterministic interleaving, not concurrent cloud writes or native background scheduling.

Reports retain per-cycle SQLite read/write, remote file read/parse, serialize/write and total
durations. `cycleProcessingMs` is the residual (merge, validation, bookkeeping and harness
overhead), **not pure merge CPU**. These are local-file phase measurements, not WebDAV/Dropbox
RTT, encryption, attachment transfer or native bridge measurements. The weekly/manual workflow
runs 100 rounds with 1,000 tasks and retains reports even on failure. Timings remain descriptive;
correctness assertions fail CI. The short two-round case runs with `test:perf-tools`.

Still separate release checks: native capture queue replay after termination, interrupted
attachment transfers, old-version database upgrades, backup restore, real disk-full behavior,
and multi-device tests against each supported backend. Do not mark these covered by this runner.

## Audit coverage and next measurements

| Area | Automated evidence | Still needs native profiling |
|---|---|---|
| Data loading | Canonical readiness; SQLite hydrate | Cold disk/migration and RN/Tauri bridge time |
| List rendering | Desktop/mobile render budgets; real browser mounted-row/scroll assertions | Sustained frame pacing, allocations and memory while scrolling |
| Task changes | Production store mutation/bulk budgets; visible and persisted capture; targeted/snapshot SQL writes | Input-to-frame response and save latency under background contention |
| Settings | First-open General/Integrations browser timings; deferred-resource/draft-retention tests | Native config/keyring latency and platform-specific sections |
| Sync | Fingerprint, JSON and full-merge CPU measurements; existing sync phase diagnostics | Controlled network RTT, encryption, attachment IO, contention and peak memory |

Do not infer a fast full sync from a fast fingerprint. Likewise, virtualizing rows does
not eliminate full-store derivation or merge costs. Prioritize observed long phases,
preserving revision arbitration, tombstones, pending edits and durable-save guarantees.

## Android device baseline

Follow [Android Startup Profiling](../../apps/mobile/README.md#android-startup-profiling)
to install the separate profileable release APK. Debug/Expo development builds are rejected.
Create a fixture export for the normal import UI, for example:

```bash
node --input-type=module -e 'import {fixture} from "./scripts/performance/fixture.mjs"; const f=fixture(1000); console.error(f.id); console.log(f.payload)' > /home/dd/mindwtr-benchmark-fixture.json
```

Use the printed ID for `DATASET_ID`. Import only into Mindwtr Benchmark. Confirm the task
count and startup destination manually; the shell runner cannot verify the imported store.
Record network state truthfully: `NETWORK` labels the condition; it does not change radios.
Use airplane mode for the offline experiment, no sync account, a consistent screen refresh
rate and animation settings, and a cool device without battery saver. Record device model,
OS build, power/thermal conditions and fixture identity alongside the raw reports.

Cold uses force-stop; hot uses HOME then foreground; warm attempts BACK then Activity
recreation. Actual Android launch classification is checked. The script records native
`am start -W` timing separately from JS timing; hot native dispatch is not cold TTID.
Unknown/mismatched classification, crashes, missing readiness, malformed/missing timing,
or log loss invalidate the report and return nonzero. A fixed post-launch window must
be long enough for the device; an invalid run is a finding, not an outlier to discard.

### Native interaction runner

`apps/mobile/benchmark` is an opt-in AndroidX Macrobenchmark test module, not shipped in
normal builds. Generate the **Benchmark** native project using the mobile README's profiling
recipe, then build from `apps/mobile/android`:

```bash
APP_VARIANT=benchmark EXPO_PUBLIC_STARTUP_PROFILING=1 ANDROID_PROFILEABLE=1 \
  ./gradlew -I ../benchmark/include.gradle :app:assembleRelease :macrobenchmark:assembleRelease \
  -PreactNativeArchitectures=arm64-v8a
```

Set `ANDROID_HOME` and `ANDROID_SDK_ROOT` to the installed SDK. The init script refuses a
non-Benchmark application ID and ignores included Gradle plugin builds. Install only the
generated `app-release.apk` and `macrobenchmark-release.apk` on the explicitly selected device.
The runner does not install, reset, import or erase data. Confirm English UI, the synthetic
fixture, disabled sync and an idle unlocked phone before running:

```bash
ANDROID_SERIAL=<device> ADB_BIN=<absolute-adb-path> \
SYNTHETIC_DATA_CONFIRMED=1 DATASET_ID=<fixture-id> DEVICE_LABEL=lab-phone NETWORK=online \
EXPECTED_APK_SHA256=<sha256-of-built-app-release.apk> \
SCENARIO=inboxScroll METRIC_MODE=timing RUNS=10 bun run perf:android-interactions
```

Scenarios: `coldStartup` (native TTID/TTFD), `inboxScroll`, `settingsNavigation`, `captureOpenClose`, and
`captureSave` (frame metrics). Run one scenario at a time. The target package is fixed to
`tech.dongdongbh.mindwtr.benchmark`; the actual installed APK hash must match the supplied
build hash. Non-debuggable/profileable checks and AndroidX device-quality checks are not
suppressed. Compilation uses partial compilation after three warm-up iterations, with
baseline-profile installation disabled to make that condition explicit and repeatable.

Use `captureOpenClose` for repeated same-fixture capture A/A and A/B measurements. It
opens the normal sheet, waits for title focus and UI idle, then uses the header Close
control. It asserts that the sheet disappears and the Inbox count is unchanged. No title
is entered or saved. Its `benchmark.capture.open` and `.close` sections include automation
waits, not app-only latency. This isolates modal/keyboard work from task persistence;
retain `captureSave` as a separate end-to-end correctness and performance scenario.
Keep APK, runner, fixture, sort, keyboard and device conditions identical for A/A runs;
collect multiple batches before choosing regression thresholds.

Both capture scenarios now require an automatic keyboard-readiness preflight in **timing
and memory** mode, even with `RUNS=1`. Before compilation warm-ups, it checks ten cold
launches and ten same-process reopenings. Every open requires a focused title and a
visible on-screen input-method window; every cancellation must leave Inbox unchanged.
This catches the case where a title is focused but Android has not served its input
connection. The restored 120 ms initial focus behavior is unchanged.

Rebuild/install the runner APK if it predates `CaptureKeyboardReadinessTest`. A missing
test, failed instrumentation, missing/malformed report, wrong APK/fixture, incomplete or
duplicate samples, or hidden keyboard blocks measurement and returns nonzero. There is
no skip switch. Metadata schema 4 records the preflight status; its log and native report
(plus failure screenshots when available) are retained separately under
`readiness-instrumentation.txt` and `readiness/`. Preflight time is not a capture timing
sample. It exercises the app before the existing compilation warm-ups, so keep this
protocol constant between comparison builds. Battery/thermal snapshots for the measured
run are taken after preflight. Schema 2 capture reports have no automatic readiness proof;
do not treat them as equivalent without separately matched correctness evidence.

For every scenario and metric mode, the host also resolves and hashes both installed
APKs again after measurement and artifact collection. Metadata `finalBuildIdentity`
must pass before the report can pass. Changed/missing packages or a failed final device
check invalidate the run, even when instrumentation reports success; collected native
JSON/traces remain available. Post-run diagnostic failures also produce terminal failed
metadata. Schema 3 lacks this end-of-run identity proof. These are boundary checks, not
continuous install monitoring: keep the device dedicated/idle, and never install or
change data during a run even if the APK bytes are identical.

Measured example: [mobile Settings and scrolling](mobile-navigation-2026-09.md).

Run `captureSave` last: warm-ups and measurements intentionally leave synthetic tasks in Inbox.
Restore the fixture through the normal import workflow before comparable capture reruns.
UI Automator fills the title directly; this is not a physical keyboard typing-latency test.
Capture traces include runner-process `benchmark.capture.open`, `.enterTitle`, and `.save`
sections for phase attribution. They include automation waits and are **not** app-only
input-to-visible or durable-save-ack latency metrics.
Scrolling selects Default order and requires a changed nonempty window of synthetic rows.
Capture selects Newest order in setup and requires its new row; it does not assume that a
new task is visible under the user's previous sort. Startup notification notices must clear
before interaction measurement, since they can intercept list gestures.

`build/performance-android` retains native JSON, Perfetto traces, instrumentation failures,
installed APK identity, fixture/condition labels and thermal state. `METRIC_MODE=timing`
(default) collects only startup/frame metrics. Use a **separate invocation** with
`METRIC_MODE=memory` to collect the last anonymous/file-backed RSS samples during each
iteration. Those counters are neither allocation peaks nor additive PSS totals. Missing
samples fail validation; they are never substituted with zero. The test-only module opts into AndroidX's
experimental [MemoryUsageMetric](https://developer.android.com/reference/kotlin/androidx/benchmark/macro/MemoryUsageMetric)
API; normal app dependencies are unchanged. The post-run
process diagnostic may say the process has stopped and is not used as a memory measurement.
ART heap and GPU counters are deliberately excluded from the aggregated benchmark. In the
pinned AndroidX 1.4.1 source (`MetricResultExtensions.kt`, `mergeToSingleMetricResults`),
an iteration missing any scalar counter loses **all** scalar results, including frame count.
ART heap samples depend on GC, so short interactions produced incomplete scalar reports
even when every frame-timing array was present. Isolating timing and collecting only RSS
for the memory experiment avoids that coupling without relaxing the sample-count guard.
If ART/GPU counters are needed, inspect the retained traces and report their availability
separately. Do not compare the old mixed/max-memory reports with the new separate/last-RSS
reports. Metadata records the metric mode; the test APK hash identifies the runner.

For retention investigation, run `SCENARIO=inboxScroll METRIC_MODE=memory RUNS=15` (with
the same safety/identity variables above), then repeat with a longer session if RSS has not
stabilized. Each iteration scrolls, waits for UI idle, and revisits the initial row in setup.
Keep the per-iteration sequence: a high-water mark alone cannot establish a leak. Longer
idle recovery should be measured separately while the same process is still alive, not by
the post-instrumentation process diagnostic.
Frame timings are not input-to-display latency.
Use `RUNS=1` to verify the harness only. Collect longer quiet-device runs and repeated A/A
and A/B sessions before drawing regression conclusions. Native JSON is not accepted by
`perf:compare`; do not mix its frame percentiles with per-run latency percentiles.

## Compare like-for-like

```bash
bun run perf:compare path/to/baseline-report.json path/to/candidate-report.json
```

The comparator requires matching platform/runtime/device/OS/build type/dataset/network/
scenario, valid reports, and at least 30 observations per metric. It rejects variable
hosted hardware. A median regression must exceed **both 15% and 20 ms**. Tail comparisons
require at least 100 observations; p95 is omitted below 20 and descriptive only below 100.
These are initial noise floors, not a universal UX SLA. Calibrate them with repeated A/A
runs on the same quiet hardware before making them release gates. Exit 0 = compatible
and within thresholds, 1 = regression, 2 = incompatible or insufficient evidence.

Do not run builds, parallel tests or unrelated workloads during baseline collection.
Retain failures and compare equivalent fixture/cache/network conditions. For important
changes repeat interleaved A/B runs; investigate distributions and traces, not best-of-N.

## Native profiling and optimization loop

### Capture A/A reference (2026-09-09 UTC)

Three unchanged five-iteration `captureOpenClose` batches passed on a OnePlus CPH2655
(Android 16), each after three compilation warm-ups. The synthetic fixture contained
1,021 tasks; Inbox remained at 221 before and after the runs. Thermal status was 0
at every batch boundary. These are local observations, not portable CI budgets.

| Batch artifact under `build/performance-android/` | Frames | Positive overruns | Frame CPU p95 | Frame overrun p95 |
| --- | ---: | ---: | ---: | ---: |
| `captureOpenClose-LMnn2M` | 119 | 19 | 17.19 ms | 7.56 ms |
| `captureOpenClose-bdXpiQ` | 157 | 21 | 16.49 ms | 6.89 ms |
| `captureOpenClose-aKRz3h` | 152 | 21 | 16.23 ms | 5.87 ms |

Percentiles above are AndroidX's pooled **frame** percentiles within each batch, not
interaction-latency percentiles. All batches used app SHA-256
`4ce98483172b9ce46edfcca58e37920c4990e209f32d18c47479bd98a2b05fce`
and runner SHA-256 `b45c3778aaaf81e525731fc507ea8e059c907ffc1e0e77169cb6c48033e46c86`.
Do not interpret variation between these unchanged batches as an optimization gain.

In batch one's iteration 1 trace, the opening UI frame took 22.40 ms, including native
modal creation and a 5.49 ms window-relayout binder call. The closing frame took 14.07 ms;
its 10.62 ms REMOVE slice included 1.36 ms accessibility removal and 5.35 ms window removal
calls. Thread-state accounting showed 5.96 ms Running and 7.96 ms Sleeping for that closing
frame: its mount/removal slice is not exclusive React CPU time. The server-side windows
included surface placement, focus updates and monitor contention. This no-save scenario
demonstrates capture UI jank independently of task persistence; it does not prove the save
path is free of other costs.

No production modal, keyboard, accessibility or save behavior was changed from this
evidence. Before testing a lifecycle redesign, attribute JS/React commit costs separately
and test modal focus, dismissal, keyboard resizing, pickers, recording and save failure.
Keep timing thresholds unset until longer, interleaved same-build runs establish noise.

### Capture token-discovery optimization (2026-09-09 UTC)

Follow-up Hermes sampling found `readQuickAddParseOptions` scanning task contexts/tags
through the full usage accumulator. Name-only callers were paying to parse every task's
timestamps and calculate counts/recency that their output discarded. `getUsedTaskTokens`
now collects normalized names directly in a Set and uses the same collator. Frequency and
recency APIs still use the full accumulator; deleted-task filtering, deduplication and
fresh reads after captures are preserved. No cache or persistence change was introduced.

Three sampled phone iterations before/after all passed against the same 1,021-task fixture.
The parser-options stack appeared in 9/10/10 samples before and 2/3/2 after; task-timestamp
stack samples fell from 5/7/6 to zero. These small sampling counts locate removed work;
they are not precise durations or evidence of a proportional whole-screen speedup.
The retained native artifact batches are `captureOpenClose-j2NCBb` (before) and
`captureOpenClose-I6Vil3` (after). Their sampled APK hashes are respectively
`d620c91009299ed46d35bc5f70e7a0001eb40906f84ec7d864ef8883f960a462` and
`c8a5c89362acf9479a82d289e8562d4717022e18003f3a1ea143bc7a9688d628`.

A local Bun comparison alternated the previous usage-derived collector with the direct
collector for 20 repetitions after five warm-ups, asserting identical context/tag output:

| Synthetic tasks | Previous median | Direct-name median |
| --- | ---: | ---: |
| 1,000 | 1.214 ms | 0.289 ms |
| 5,000 | 4.003 ms | 1.191 ms |
| 50,000 | 42.413 ms | 12.804 ms |

These are host helper timings, not Android or end-to-end capture latency. A regression
test rejects timestamp access in the name-only path and checks output parity across
5,000 mixed tasks. The production parser-options builder is also covered by the existing
1k/10k/50k CPU/scaling budget suite.

The final uninstrumented APK (`ba2f721b6b12fa51ef23e963a9364b7b6121b6beece4175487f42042bff4f467`)
passed five phone iterations in `captureOpenClose-NpmRBN`: 136 frames, 24 positive overruns,
frame CPU p95 14.19 ms and frame-overrun p95 2.71 ms. Thermal status stayed 0 at the batch
boundaries. This is one post-change batch, not an interleaved statistical comparison;
remaining positive overruns mean capture jank is not eliminated. The opt-out APK contains
no `libmindwtr_capture_profiler.so`, produced no new sampling files, and retained the same
221-item synthetic Inbox.

### Optimization procedure

#### Optional capture JS sampling (Android Benchmark only)

For JS stack attribution, rebuild the Benchmark release with
`EXPO_PUBLIC_CAPTURE_PROFILING=1` in addition to the normal Benchmark/profileable build
environment. Both `APP_VARIANT=benchmark` and that exact flag are required by the native
module; it also checks the installed package is `tech.dongdongbh.mindwtr.benchmark`.
The native sampling library is not compiled or packaged when the opt-in is absent.
No setting, exported component, permission, task payload or remote telemetry is added.

Always build through `-I ../benchmark/include.gradle`: it registers both public
profiling flags as Gradle bundle-task inputs. Metro separately versions its transform
cache for capture/startup profiling. Merely forcing a Gradle task or passing
`--reset-cache` did not invalidate an old disabled capture transform in the September
2026 investigation. See [the cache-isolation verification](profiling-cache-2026-09.md).
The [capture-context follow-up](capture-context-2026-09.md) correlates
the fresh Hermes samples with native frames and removes a redundant context invalidation.

Before a long sampling batch, force-stop and freshly launch the exact-hash Benchmark
APK, record the existing capture-profile filenames, and open/close one empty in-place
capture. Require a **new**, nonempty profile with `samples` and `stackFrames`; existing
files survive APK replacement and are not proof the current build sampled. Record
the new profile's APK/map hashes. Do not symbolize old files with a new source map.
If no fresh file appears, stop and inspect the built bundle before repeating the batch:

```bash
node_modules/react-native/sdks/hermesc/linux64-bin/hermesc -b -dump-bytecode \
  apps/mobile/android/app/build/generated/assets/createBundleReleaseJsAndAssets/index.android.bundle \
  -out=<disk-backed-artifact-directory>/bundle-disassembly.txt
```

`beginCaptureProfile` must contain the native start call, not just
`LoadConstUndefined` followed by `Ret`. Confirm the bundle is the one packaged in
the archived/installed APK. This is a build preflight, not a substitute for a fresh
on-device profile. After switching sampling off, verify that the native sampling
library is absent and no new profile is exported.

The in-place tab capture starts Hermes sampling before setting its visible state, then
stops 200 ms after the close callback to include React unmount work. Rapid reopening
retains the existing session. A 30-second JS timer also requests stop; backgrounding and
module teardown cancel native sampling independently. At most eight sessions start per
module lifetime. Background-cancelled sessions are not exported. Route-based capture and
widget capture are not instrumented by this probe.

Run `captureOpenClose` against this APK with its **new** SHA-256. Sampling is 1,000 Hz,
so its frame timings are diagnostic, not comparable with an uninstrumented APK. Pull the
profiles from the synthetic app after instrumentation finishes:

```bash
adb -s <device> pull /sdcard/Android/data/tech.dongdongbh.mindwtr.benchmark/files/capture-profiles <disk-backed-artifact-directory>
```

Retain the exact APK, its SHA-256, and
`apps/mobile/android/app/build/generated/sourcemaps/react/release/index.android.bundle.map`
with its SHA-256 before rebuilding. Preserve raw profiles and symbolicate **copies** with
the installed Metro tool (it rewrites the input profile):

```bash
node node_modules/metro-symbolicate/src/index.js <matching-bundle.map> <profile-copy.cpuprofile>
```

Require nonempty `samples` and `stackFrames`, then verify app frames resolve to the
expected source files. Sampling counts are not exact function durations; root-only samples
must not be assigned to React rendering. Distinguish warm-ups from measured iterations.
Keep profiles local and use synthetic data. To restore the timing baseline, reinstall the
saved uninstrumented Benchmark APK; never clear the normal app's data. Clean/rebundle when
changing Expo public build flags so Metro/Gradle caches cannot retain an older JS bundle.

The small JNI bridge calls `IHermesRootAPI` directly. The pinned RN 0.81.5 legacy adapter's
local source registers its `disable` JNI name against `enable`; the probe does not use that
adapter. Native dump exceptions are contained, and dump I/O runs off the UI thread.

#### Measurement loop

1. Reproduce with a signed/profileable **release** build and synthetic data. Capture
   cold launch, foreground resume, open quick capture, first input, save, Focus/Inbox/
   Projects navigation, and a sustained large-list scroll. Include empty/typical/large stores.
2. Android: use Perfetto/System Trace for process launch, scheduling, native/UI-thread
   stalls, frames, memory and I/O; use a compatible Hermes/JS profiler for JS attribution.
   `reportFullyDrawn()` makes application readiness available to platform measurements.
   For stable automated TTID/TTFD/frame metrics, provision a dedicated device and an
   Android Macrobenchmark instrumentation runner, described above.
3. iOS/macOS: use Instruments App Launch/Time Profiler, animation hitches and allocations
   on release builds. Use XCTest launch metrics for repeatable Apple launch experiments.
   JS/WebView markers supplement those tools; native Apple signposts and XCTest automation
   are not added here. Native Tauri WebView timing is not its total process startup time.
4. Attribute the critical path before editing: module evaluation, storage/migration,
   derivation, React rendering, native layout, network contention, or allocation/GC.
   Defer optional services only when traces show contention; preserve canonical data
   readiness and durable-save contracts. Do not add speculative caches or blanket memoization.
5. Make one bounded improvement, retain before/after traces and reports, verify data
   integrity and interaction behavior, and add the smallest regression test that catches it.

Start with controlled local profiling; remote performance telemetry would require a
separate privacy/product decision. Do not upload real datasets or unsanitized device logs.

References: [Android launch timing](https://developer.android.com/topic/performance/vitals/launch-time),
[Macrobenchmark](https://developer.android.com/topic/performance/benchmarking/macrobenchmark-overview),
[React Native 0.81 performance](https://reactnative.dev/docs/0.81/performance),
[Apple launch performance](https://developer.apple.com/documentation/xcode/reducing-your-app-s-launch-time).
