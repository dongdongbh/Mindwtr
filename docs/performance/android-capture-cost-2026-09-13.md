# Android capture control and native cost, September 13, 2026

## Result

Two matched, unchanged capture-open/close batches passed 40 cold/warm visible-IME
checks and ten measured interactions. Cancellation left Inbox at 234. Frame tails
still vary across identical builds: pooled AndroidX frame-duration p95 was
14.27 and 16.98 ms; overrun p95 was +2.45 and +5.45 ms. This is a current control
and bounded attribution result, not an app speedup or a release tail gate.

The prior benchmark hardening and handoff were published on `main` as
`e2234c4fa5461de2a1afb4f22e816a1d82b128ea`.
[CI 34740710185](https://github.com/dongdongbh/Mindwtr/actions/runs/34740710185)
passed every job, including Tauri, mobile, web, performance budgets, and Windows
native checks. Local and remote main SHA parity was verified after publication.

## Matched control

Artifact root: `/home/dd/.cache/mindwtr-performance-tmp/android-capture-cost-20260913/`.
The archived app, runner and dependency/source file manifest from the
[earlier integrity report](android-harness-integrity-2026-09-13.md) were checked
against the published source; every recorded source file matched. No rebuild was
needed for these controls. Before replacement, both installed original APK hashes
were rechecked against their archives.

- Benchmark APK: `98393836deb44edb5a48692be5eabca7f6ef351b3b6b5a44705aa1e0a47fd8ba`.
- Runner APK: `78dc5e76698b5cae5089567fbd15afb7f4c259e0c0943c1cfa038dc4facfe30c`.
- Hermes bundle: `c633cab9a4378281069c02f433c40f75d27a7e645a198d2501550a4f3c0791af`.
- Source map: `d83352533c06d85f7da517507d4ba2ab842fb4605dde7c9ce6130c77f588b83c`.

The physical OnePlus CPH2655 (serial 44882663), Android 16, 1080×2376 portrait,
existing density override 480, Gboard, 1.0 animation scales, 120 Hz peak/adaptive
refresh, online radios, USB charging and low-power Off were retained. Synthetic
Benchmark only; production and Dev apps were untouched. Sync Off and Newest sort
were confirmed before the first preflight, and Newest was reconfirmed before the
second. No task was saved, and no import/restore occurred between these batches.
Neither builds, unrelated tests nor trace processing overlapped measurement.

The runner's dataset label `export-1034-live-e520f20551ff80b1` identifies the
previously restored seed export, not a hash of the current SQLite file. A fresh
full export afterward confirmed 1,034 live tasks, 20 projects, and five tombstones:
one original tombstone plus the four captures removed by the preceding session's
normal restore. Both A/A batches used that same post-restore state. The fresh
export additionally records the diagnostic-logging setting enabled only after
capture measurement, and is archived as `control-export.json` (SHA-256
`421c5a19b1b05aa78fa034fd44d1f768a51384dbdd40a1e7207a166ecef06812`).
Do not equate its bytes with the older seed export.

| Batch | Measured iterations | Frame counts | Frame-duration p50 / p95 ms | Overrun p50 / p95 ms |
|---|---:|---|---|---|
| `aa1/captureOpenClose-8Et5dM` | 5 | 23, 37, 26, 36, 33 | 2.87 / 14.27 | -9.20 / +2.45 |
| `aa2/captureOpenClose-Wg8IDf` | 5 | 36, 37, 21, 36, 23 | 3.02 / 16.98 | -8.61 / +5.45 |

Each batch passed ten cold plus ten warm visible-IME opens, three excluded partial
compilation warm-ups, schema-5 sample/trace validation and final app/runner hash
checks. Each retained five traces. AndroidX reported zero thermal-throttle sleep
seconds. `native-summary.json`, invocation logs, readiness JSON and before/after
display/thermal/battery snapshots retain the raw observations. A fresh launch
afterward confirmed Inbox 234 and the prior synthetic rows.

These are pooled frame observations, not independent interaction latency samples.
Adaptive refresh remains enabled and the sample size is small. The matched starting
sort removes the prior comparison's known sort mismatch; it does not eliminate
normal device variability or establish a reliable p95 regression threshold.

## Bounded trace attribution

An independent Sol agent analyzed two selected slow opening frames from the earlier
September 13 selector-control batches on the same APK pair. These are separate
retained traces, not the new A/A iterations above:

- `MindwtrBenchmark_captureOpenClose_iter000_2026-09-13-05-15-52.perfetto-trace`
- `MindwtrBenchmark_captureOpenClose_iter000_2026-09-13-05-19-31.perfetto-trace`

The first trace's doFrame slice 2404 starts at 164429722985625 ns; DrawFrames slices
3398/3532 reproduce JSON durations 32.080469/33.213750 ms exactly. The second's
doFrame slice 2317 starts at 164648790558927 ns; DrawFrames 3128/3289 reproduce
23.677864/25.223593 ms. Each pair is two render layers of one UI frame. The field
`frameDurationCpuMs` describes these elapsed doFrame-to-layer-draw-end spans;
it is not summed scheduler Running time.

| Nested phase | First trace wall / Running ms | Second trace wall / Running ms |
|---|---|---|
| Fabric `premountViews` | 16.791 / 11.924 | 10.447 / 6.942 |
| One `RCTModalHostView` creation | 9.355 / 4.566 | 7.185 / 3.681 |
| First traversal | 14.305 / 5.771 | 12.452 / 4.245 |
| Relayout Binder dependency | 4.389 / 0.076 | 3.881 / 0.033 |
| Primary RenderThread drawing | 3.234 / 3.183 | 3.490 / 3.309 |

These phases overlap/nest and must not be added. The relayout wait reaches
`system_server`, which performs three SurfaceFlinger surface-creation calls in
each trace. UI thread-state coverage is complete over the selected windows, with
no overlapping/incomplete rows; leading RenderThread gaps remain unclassified.
The JS thread also ran 6.348/9.754 ms during the windows, but these unsampled traces
cannot attribute that work to a React or JavaScript function.

The full report and exact query/error record are in `attribution/report.md` and
`attribution/commands-and-queries.md`. Two verified-fact scratchpads are retained
under `/home/dd/.cache/mindwtr-performance-tmp/mindwtr-perfetto/`, named for the
trace files above. This is selected-outlier attribution, not an exhaustive device
audit. The standard metric and AndroidX aggregate frame counts differ by one;
only individually reconciled samples are compared. Power-rail import warnings
are retained and no power conclusion is drawn.

## Decision and next step

No capture UI optimization is accepted in this pass. Native premount/window
lifecycle is the demonstrated cost; the rejected immediate-focus and Activity-local
presentation experiments remain rejected. A possible next experiment is to reduce
nonessential descendants in the initial 52-item native mount batch, but first
identify which descendants can move without visible popping, missing controls,
accessibility or focus changes. Require a falling native work count/phase cost,
full correctness gates, and an interleaved unsampled A/B/B/A comparison before
promotion. Do not infer such a design from these traces alone.

The reproduced direct-export failure is fixed locally in the separate
[document-provider write investigation](android-document-write-2026-09-13.md).
That report records native JSON/CSV/ZIP readback, implementation validation,
publication status and restoration of the original test APKs and settings.
