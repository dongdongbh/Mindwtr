# Android benchmark integrity and current control, September 13, 2026

## Scope and result

This iteration addresses four ways the native Android benchmark could accept
incomplete or mismatched evidence. It changes the host runner and the opt-in
Macrobenchmark tests, plus a stable test identifier on the existing capture
header Close control. Production app behavior is unchanged by this iteration;
current-device timings are a fresh control, not an app speedup comparison.

The starting source is `e22327cc2f5ff5dcc472f39c973e24c9b03224b4` on `main`,
with the harness patch in `perf/android-stability-20260913`. The desktop changes
and subsequent CI portability fix are separate published work. Detailed local
artifacts are under `/home/dd/.cache/mindwtr-performance-tmp/android-stability-20260913/`.

## Reproduced gaps and accepted contracts

- The host checked the target APK against an expected hash but merely recorded
  the initially installed runner. An already-stale runner could pass. Both built
  APK hashes are now required before instrumentation, and checked again at the
  existing post-readiness and final boundaries.
- The nominal fake declared 50 frames while supplying two samples. The host now
  requires a positive integer frame count and an equally sized CPU and overrun
  array for each measured iteration. CPU durations are finite and nonnegative;
  overruns remain signed. AndroidX 1.4.1 maps each frame into both supported
  submetrics and reports that same population as frameCount.
- A batch could pass with just one retained trace, irrespective of iteration
  count. Each measured iteration now needs a unique profiler output and a
  matching nonempty retained Perfetto file; malformed and incomplete references
  fail validation.
- Capture-save waited for a matching row without checking count growth or sheet
  dismissal. Each save now requires the sheet input to disappear, the Inbox count
  to grow by exactly one, and its generated title row to appear. These are UI
  correctness assertions, not an independent durable SQLite acknowledgement.

Metadata schema 5 identifies the stronger contract. The capture-save automation
span includes the additional assertion waits, so comparisons need fresh cohorts.
The existing 10-cold/10-warm visible-IME preflight remains mandatory for both
capture scenarios, including memory mode. No budget or readiness gate is relaxed.

The frame contract was verified against Google Maven's pinned
[AndroidX 1.4.1 sources](https://dl.google.com/dl/android/maven2/androidx/benchmark/benchmark-macro/1.4.1/benchmark-macro-1.4.1-sources.jar):
`Metric.kt` constructs frameCount from frameData.size and
`FrameTimingQuery.kt` maps every frame into each supported submetric. The local
source JAR and extracted files are retained with the artifacts. A historical
three-iteration native report also has matching 20/22/36 frame counts and sample
populations and one profiler output per iteration; it is format evidence only.

## Device and fixture provenance

Physical OnePlus CPH2655, Android 16/API 36, arm64, 1080×2376 portrait. Existing
physical density 640/override 480, animation scales 1.0, peak refresh setting
120 Hz, Gboard, USB charging, radios online, low-power mode Off. No global display,
keyboard, radio, or power settings were changed. Exact fingerprint, thermal and
battery snapshots are retained in `environment-start.json` and each batch’s
condition files. The initial active display mode was 1080×2376 at 120 Hz; adaptive
refresh remains enabled, so the configured peak is not a promise of constant
refresh throughout every interaction.

Only `tech.dongdongbh.mindwtr.benchmark` and its
`tech.dongdongbh.mindwtr.macrobenchmark` runner are used. The production and Dev
apps were not opened or modified. The original release Benchmark version is
1.3.0/code 139, non-debuggable. Its exact APKs were pulled before replacement:

| Artifact | SHA-256 |
|---|---|
| Original Benchmark | `3ef80137cd44952a5e4b1943049b1d97b67c63098d86e15e249521731d69061f` |
| Original runner | `fab7679a1d7e94859ad037c0aa739c8f88f5dce24c377608db816cc33b819dbe` |
| Exported fixture | `e520f20551ff80b1600b7dee0fd7639caa3f57019f2139fc63567a5e059dd7b6` |

`original/fixture.json` contains 1,035 task records: 1,034 live tasks plus one old
tombstone, 20 synthetic projects, and no sections/areas/people. Live statuses:
Inbox 234, Next 200, Waiting 200, Someday 200, Done 200. All task and project title
patterns were checked as synthetic. Dataset label:
`export-1034-live-e520f20551ff80b1`. English UI, Newest capture sort, Sync Off.
The export is a full-content identity, superseding the old operator-only label.

The installed historical Benchmark's first export attempt created a zero-byte
file through the selected Downloads provider and fell back to the share sheet.
Saving the fallback through My Files produced the nonempty, parsed backup above.
Both attempts are retained. This is an observation on the historical APK, not a
confirmed regression in current main; a separate current-build reproduction is
needed before a production change.

Experimental native generation uses Benchmark-only applicationId, startup
profiling enabled, capture sampling disabled, and profileable release builds.
The ignored generated app/build.gradle keeps code 139 instead of tracked code
140 so the original non-debuggable release can be restored with install -r
without uninstalling or clearing data. Tracked app.json is unchanged. Dependencies,
native outputs, build temp and reports remain on disk under /home/dd.

## Build and automated validation

The Benchmark release app built successfully in 8m 2s; the opt-in runner built
successfully in 37s, including Kotlin compilation. Existing dependency/native
warnings remain in the retained logs. No production dependency or version change
was made. Initial control identities (`control-initial/`, startup/memory and failed capture preflight):

| Artifact | SHA-256 |
|---|---|
| Current Benchmark | `a74c0cbe40a46d7cbe94fbd1e6b28ecfaf459b32e17a2e1446672399b452a1c1` |
| Current runner | `c05155af5ff9a4cf1863470f72a2411522c7b1bcc2c9036c741ba2ed0ed8ec66` |
| Matching Hermes bundle | `eaec4d12b4a487a62ba2c06156a4d74697d19c8408b97dd582a08989f4b4b8de` |
| Matching source map | `17bbd9e620fc5162525be3c3d621d46f8d89d9901ae1b4de1473ea7be6381cff` |

The APK's bundled asset matched the archived generated Hermes bytes. The native
source/dependency hash manifest, final host-runner patch/hash manifest, badging,
package dumps, exact flags, and build logs are retained under `control-initial/`,
`control/`, and the
artifact root. Both installed hashes were checked after installation; the target
is non-debuggable, and English Inbox count 234 plus Sync Off were reconfirmed.
Host runtime: Bun 1.3.3 / Node 22.23.2; AndroidX Macrobenchmark 1.4.1.

Regression-first worker evidence reproduced four failing groups on the old host
checks: expected runner validation, stale runner, incoherent frames, and missing
iteration traces. The focused host suite passed 48 tests/484 assertions. Root's
full `test:perf-tools` run passed 92 tests/677 assertions. Independent Sol review
found one P2 ineffective `Set.add()` duplicate guard; it now checks `Set.has()`
before insertion, and the focused trace regression passed with 21 assertions,
including the specific duplicate-filename error. Kotlin remained unchanged by
that correction and matched the compiled source manifest. Diff checks passed.

## Native control and restoration

The first capture A/A attempt (`measurement/aa-1/captureOpenClose-rsNvxv`)
failed during preflight, before any warm-up or timing sample. It proved a visible
IME on cold open 0 but could not find the old Close/ViewGroup selector. Retained
hierarchy and screenshot show two Close nodes, both Android Button: the full-screen
backdrop and the header. The cancellation control now has a stable
`quick-capture-close` test identifier; both Kotlin callers require that ID and
the Close label. The click handler, focus delay, keyboard checks, and accessibility
role/label are unchanged. This small integration correction was made by the leader
after the bounded review and requires fresh app/runner identities.

The corrected app and runner rebuilt in 1m 24s. All 18 capture-modal Vitest tests,
mobile TypeScript checking and changed-file lint passed. An initial invocation
through the root Bun runner failed to parse a React Native dependency's Flow
syntax; the mobile package's configured Vitest command is the applicable runner.
That invocation error is retained separately from product/test failures.

Corrected capture-control identities (`control/`):

| Artifact | SHA-256 |
|---|---|
| Benchmark | `98393836deb44edb5a48692be5eabca7f6ef351b3b6b5a44705aa1e0a47fd8ba` |
| Runner | `78dc5e76698b5cae5089567fbd15afb7f4c259e0c0943c1cfa038dc4facfe30c` |
| Hermes bundle | `c633cab9a4378281069c02f433c40f75d27a7e645a198d2501550a4f3c0791af` |
| Source map | `d83352533c06d85f7da517507d4ba2ab842fb4605dde7c9ce6130c77f588b83c` |

The capture cohort uses only this corrected pair. Startup/memory observations
are from the earlier pair and are not pooled with capture results. No Hermes
capture sampling was enabled in either cohort. All measured batches ran after
builds and tests stopped; unrelated shared-host apps were left alone.

### Completed control observations

Every successful batch below passed schema-5 completeness and final APK identity.
All used partial compilation with three excluded warm-ups. The startup/memory
pair predates the test-ID-only capture selector correction; keep those APK/map
identities separate from the capture pair.

| Batch | Measured iterations | Observation | Artifact directory below measurement/ |
|---|---:|---|---|
| Cold startup | 3 | TTID median 307.31 ms, range 304.61–334.79; TTFD median 749.83 ms, range 749.54–771.64 | `startup-smoke/coldStartup-qEVSHA` |
| Scroll memory | 5 | Anonymous RSS 176792–206012 KiB, median 200468; file-backed RSS 173232–173744 KiB, median 173508 | `scroll-memory/inboxScroll-QojKGL` |
| Capture open/close A1 | 5 | Frame CPU p50/p95 3.15/13.80 ms; overrun p50/p95 −8.61/1.92 ms; frame counts 21/35/34/35/40 | `aa-1-selector/captureOpenClose-lcLNLm` |
| Capture open/close A2 | 5 | Frame CPU p50/p95 3.28/14.73 ms; overrun p50/p95 −8.58/2.91 ms; frame counts 18/37/37/22/35 | `aa-2-selector/captureOpenClose-qhF1D1` |

The two capture batches use identical APKs and task data; each passed ten cold
and ten warm visible-IME opens before compilation. Every measured capture uses
Newest sort. The first preflight followed the scrolling experiment's Default
sort; the second began in Newest. This extra preflight-state difference and
adaptive refresh make the A/A observations descriptive, not a strict noise or
tail gate. A fresh launch after both batches confirmed Inbox still 234.

These percentiles describe pooled frames in each batch, not input-to-visible
latency. There is no A/B app optimization or measured app speedup in this
iteration. Five RSS samples do not establish leak freedom, allocation peaks, or
long-term retention. Native JSON, each measured trace, readiness reports, raw
condition snapshots and the failed preflight remain archived. `native-summary.json`
collects the results without dropping the failure.

Capture-save smoke (`save-smoke/captureSave-rQYHnP`) also passed its 20-check
preflight, three compilation warm-ups, and one measured save. Its single trace
contains 59 valid paired frame samples; frame CPU p50/p95 was 3.40/15.19 ms and
overrun p50/p95 −8.90/3.18 ms. Treat this as a correctness smoke, not a timing gate.
Each save passed the new sheet-dismissal, exact count increment and unique row
assertions. A fresh launch then showed exactly four new synthetic capture rows
and Inbox 238, as expected from 234 + three warm-ups + one measured save.

Across successful batches: 19 measured iterations/traces retained, 60/60 native
visible-IME checks passed, all final identity checks passed, and AndroidX reported
zero thermal-throttle sleep seconds. The one failed selector preflight remains
separate. This does not establish independent mobile SQLite readback, long-term
memory stability, physical typing latency, sync responsiveness, or a release tail
gate.

### Restored lab state

The normal Restore Backup UI loaded the archived `fixture-before.json` and
confirmed 1,034 live tasks and 20 projects before replacement. It reported restore
success and retained its automatic pre-restore recovery snapshot. The original
Benchmark and runner APKs were then reinstalled with install -r; both installed
SHA-256 values exactly match the original table above. No uninstall or data-clear
command was used.

A fresh launch of the original app confirmed Inbox 234, the prior synthetic rows,
and Newest sort. Sync Off was reconfirmed in Settings. Both test packages were
then force-stopped. Display size/density, animation scales, refresh settings,
default IME, radio states and low-power setting exactly match the initial snapshot.
See `environment-end.json` and `restoration/` for identities, UI evidence and
condition checks. The synthetic backup folder, its Benchmark-only folder grant,
benchmark reports, and automatic recovery snapshot are retained as test artifacts.
Production and Dev apps/data were untouched.

## Acceptance and next experiment

Accept the stronger host/native benchmark contracts and stable capture-close
selector. The archived measurements predate the publication commit and identify
the exact measured source and binaries above; they do not establish an app speedup. Desktop publication and its
CI repair are already complete on `main` at `e22327cc2` with replacement run
`34738227281` successful.

Next Android experiment: use this exact selector-capable app/runner protocol,
restore the exported fixture and set Newest before every preflight, then collect
a fully matched A/A series before profiling a dominant capture phase or selecting
a candidate. A sampled build needs a fresh matching map and separate cohort.
The historical export-provider fallback observation remains a separate stability
lead; do not label it a current-main regression without reproducing it there.
