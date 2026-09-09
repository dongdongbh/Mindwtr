# Mobile Settings and scroll profiling: September 9, 2026

## Device baseline

Tested only the separate `tech.dongdongbh.mindwtr.benchmark` release app on the
connected OnePlus CPH2655, Android 16. The previously saved control APK was kept
installed; no mobile runtime code was changed in this pass. Its installed SHA-256
was verified before each batch:
`f177cf605b62105eb49b8dcb0a18aeb10084a592bd9c7d3b2536987588f1e202`.
Runner SHA-256:
`b1f4a0c82b82fda7242c79755e1918aa45ffafe1b914c40386f4106d912b8112`.

The synthetic fixture was `mixed-v1-1000-cbfcca2e13cf76a5-plus21captures`:
1,021 tasks, 221 in Inbox. Inbox and Sync Off were checked through the UI before
testing. Network stayed online. No tasks were saved, imported, deleted, or synced;
the scroll runner selected Default sort. The normal app was not opened or changed.
Builds/tests and desktop timing runs were stopped during native measurement.

Both scenarios completed ten iterations after three compilation warmups with
AndroidX 1.4.1 partial compilation, baseline-profile installation disabled. Thermal
status was 0 before and after both batches; starting battery temperatures were
29.2 C for Settings and 28.9 C for scrolling.

| Scenario | Frames | Positive overruns | Pooled frame CPU p95 | Pooled frame overrun p95 |
| --- | ---: | ---: | ---: | ---: |
| Settings menu open/back | 789 | 12 (1.5%) | 7.68 ms | -3.22 ms |
| Five Inbox scroll gestures | 2,038 | 36 (1.8%) | 9.01 ms | -2.25 ms |

Every scroll iteration changed the visible synthetic rows. Negative overrun means
a frame met its deadline. These are pooled frame metrics, not navigation/input
latency, independent per-interaction samples, or a statistical p95 release gate.
They do not cover opening General's subpage, cold Settings code evaluation, a
10k-task phone store, sustained memory retention, or behavior under active sync.

## Bounded trace findings

In Settings iteration 3, main-thread slice 6483 (`Choreographer#doFrame`) lasted
16.947 ms: 15.292 ms Running, 1.320 ms Sleeping, 0.335 ms Runnable. Native view
preallocation occupied 8.012 ms, and a nested mount batch 4.162 ms. Its RenderThread
frame lasted 2.502 ms, all Running; the main thread's render handoff included
`postAndWait`. An ART marking phase later in the trace did not overlap this frame.

In scroll iteration 0, main-thread slice 58390 lasted 14.407 ms: 13.917 ms Running,
0.465 ms Sleeping, 0.026 ms Runnable. A native mount batch occupied 11.893 ms, all
Running, including creation of 30 native views and 31 layout instructions.
Nested durations overlap and must not be summed as independent costs.

This locates occasional slow-frame work in native view creation/mounting. It does
not attribute JS/React component costs, prove there are no other bottlenecks, or
justify changing list/capture lifecycle behavior. Both inspected traces report one
empty power-rail packet, so no power conclusion is made. No mobile runtime
optimization is claimed from these descriptive batches.

Next native work should separately profile capture/save and scroll allocations
with larger fixtures, then test a bounded change against matched A/B builds. Keep
the visible-keyboard and durable-save gates; do not infer a speedup from fewer
frames or from bypassing a readiness check.

## Benchmark identity fix

The host previously checked installed APK hashes before measurement (and after
capture readiness), but not after the measured run. A protocol test reproduced a
false success when the app or runner was replaced during measurement despite
otherwise passing instrumentation and complete artifacts.

`android-interactions.mjs` now resolves the currently installed paths and verifies
both hashes again after collecting native evidence. A changed/missing package,
unavailable identity check, or failed post-run diagnostic collection fails the
report with terminal metadata, retaining traces and native JSON. Schema 4 records
`finalBuildIdentity`. This applies to all scenarios and both metric modes, without
changing the native test APK, app permissions, data, or runtime behavior.

Tests cover app/runner changes, missing packages, disconnects, successful checks,
and resolving a new installation path with identical bytes. These are endpoint
identity checks, not proof no reinstall/data change occurred between them: a
dedicated idle device remains required. All 61 performance-tool tests passed.
The updated host runner then passed three real-device Settings iterations in
`settingsNavigation-vLnVTj`: schema 4, `status=passed`, `finalBuildIdentity.status=passed`,
and both final hashes equal to the baseline identities above. This is a protocol
smoke check, not a speedup measurement. Final UI verification still showed 221
Inbox tasks. The phone was returned to Home and only the Benchmark app was stopped.

## Artifacts

Under `/home/dd/.cache/mindwtr-performance-tmp/settings-first-open/`:

- `mobile-baseline/settingsNavigation-9Z9H3a`: ten traces and native report.
- `mobile-baseline/inboxScroll-gPxHqA`: ten traces and native report.
- `mobile-identity-smoke`: separate device acceptance of the schema-4 host runner;
  not a before/after app performance comparison.

The baseline batches used the earlier schema-3 runner and lack automatic final
identity proof; their status must not be retroactively presented as schema-4
acceptance. Local evidence notes and the exact inspected trace names are under
`/home/dd/.cache/mindwtr-performance-tmp/mindwtr-perfetto/`. APKs, traces, synthetic
data and screenshots remain local, not committed. Reproduction commands and
limitations are in [Performance baselines](performance-baselines.md).
