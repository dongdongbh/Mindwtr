# Performance baselines and profiling

Measure before optimizing. Keep fast CI budgets (`bun run test:perf`), production UI
measurements, and native device traces as separate layers. A faster splash screen is
not a faster usable app; a browser timing is not a native launch timing.

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

## Storage and sync processing

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

Follow [Android Startup Profiling](../apps/mobile/README.md#android-startup-profiling)
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

1. Reproduce with a signed/profileable **release** build and synthetic data. Capture
   cold launch, foreground resume, open quick capture, first input, save, Focus/Inbox/
   Projects navigation, and a sustained large-list scroll. Include empty/typical/large stores.
2. Android: use Perfetto/System Trace for process launch, scheduling, native/UI-thread
   stalls, frames, memory and I/O; use a compatible Hermes/JS profiler for JS attribution.
   `reportFullyDrawn()` makes application readiness available to platform measurements.
   For stable automated TTID/TTFD/frame metrics, provision a dedicated device and an
   Android Macrobenchmark instrumentation runner. This change does not install that runner.
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
