# Full-merge allocation and Android capture follow-up

Date: 2026-09-09. Control source: `4de3bc92f`. This is one shared-core
optimization, consumed by desktop and mobile; no persistence adapter, sync
protocol, UI or native package was changed.

## Finding and change

A fresh 30-sample disk-backed storage run at 10,000 synthetic tasks measured
398 ms unchanged full merging and 415 ms one-task merging (medians), versus
61 ms canonical hydration and 10 ms targeted task persistence. These are
warm-cache Bun/SQLite observations, not native bridge or network timings.

A separate Node CPU profile of 30 unchanged 10,000-task merges attributed
6,948 self samples to the task attachment-reconciliation callback, alongside
4,052 garbage-collector samples. The callback always spread the whole task
to attach the result, including when both the result and existing attachments
were `undefined`. Source was resolved against the retained unminified bundle.
Samples identify work, not exact function durations or Android CPU behavior.
Bun 1.3.3's profiler failed to write even a minimal probe; those failed attempts
are not profile evidence.

The merge now returns the normalized winner when its attachment reference
already equals the reconciled result. Otherwise it still creates the patched
object. It does not skip attachment reconciliation, cancellation/recurrence
repair, normalization, conflict arbitration or reference repair. Explicit empty
attachment arrays retain their previous behavior. No new cache, revision shortcut,
write batching or weaker save acknowledgement was introduced.

The regression test failed before the change because identical merged tasks
were new objects. It now requires frozen normalized task/project winners to
retain identity, unchanged data, zero conflicts and convergence on the next merge.
The release diagnostic `v1.3.0/sync-attachment-copy-elision` counts avoided copies;
it does not claim a durable save or completed remote sync.

## Alternating CPU comparison

The initial sequential storage candidate run slowed across unrelated hydration,
JSON and write phases too. Those reports are retained, not treated as a speedup
or discarded as outliers. A later process snapshot showed another Node workload;
this shared workstation was not a controlled release-gate environment.

To reduce drift, two bundles were built with identical imports: one substitutes
the exact control `sync.ts` from Git, the other uses the candidate. Each experiment
alternates order every iteration, warms up five times, then collects 30 samples
per side/size/scenario. Each iteration parses a fresh peer; one-edit changes one
task. Every pair asserts deeply equal **data and merge statistics**. Both use a
no-op log sink. Bundle SHA-256 values and raw observations accompany the reports.

| Bun median, ms | Control run 1 | Candidate run 1 | Control run 2 | Candidate run 2 |
| --- | ---: | ---: | ---: | ---: |
| 1,000 unchanged | 22.33 | 15.13 | 22.40 | 15.42 |
| 1,000 one edit | 22.40 | 14.99 | 24.84 | 14.88 |
| 10,000 unchanged | 228.36 | 158.62 | 228.91 | 166.08 |
| 10,000 one edit | 227.11 | 160.49 | 229.52 | 161.60 |

At 10,000 tasks the paired runs reduce median merge CPU time by roughly 27–31%.
An additional Node 22.23.2 run of the same 30-pair experiment measured
554.20 → 419.13 ms unchanged and 551.07 → 415.03 ms with one edit at 10,000
tasks (about 24–25% lower). At 1,000 tasks the medians were 56.25 → 42.36 ms
and 56.51 → 41.84 ms. This corroborates the direction in a second JS engine;
it does not replace WebKit/Hermes profiling. All 420 pairs across the three
experiments (including warm-ups) produced identical data and merge statistics.
This is a host experiment, not a proportional full-sync or startup improvement.
No p95 release gate, physical-phone sync speedup or native Tauri result is claimed.

## Validation

- 1,216 sync/persistence/attachment/recurrence/diagnostic tests passed across 48
  files; one existing skip. The merge-clock test suppresses Vitest's console
  timestamping while retaining its assertion against extra `Date.now` calls;
  the new diagnostic payload has its own assertion.
- Core, desktop and mobile TypeScript checks passed; scoped core ESLint passed.
- `bun run test:perf` passed all 15 shared-core/desktop/mobile budget tests,
  including full merges through 50,000 tasks and desktop/mobile list rendering.
- The 100-round, three-peer synthetic reliability run passed (600 cycle samples),
  including restart recovery before commit/after acknowledgement, injected write
  failure, stale-snapshot protection, and 100 injected lost remote acknowledgements.
  WAL/FULL durability settings remain unchanged. This is a correctness run, not
  a native/cloud performance comparison.

## Physical Android capture observation

OnePlus CPH2655, Android 16, package `tech.dongdongbh.mindwtr.benchmark`, network
online, sync confirmed Off. Installed app SHA-256:
`f177cf605b62105eb49b8dcb0a18aeb10084a592bd9c7d3b2536987588f1e202`;
runner: `b1f4a0c82b82fda7242c79755e1918aa45ffafe1b914c40386f4106d912b8112`.
Neither changed at the final schema-4 identity check. This APK predates the new
merge optimization and is **not its on-device acceptance test**.

Batch `captureSave-PJWfeV` passed 20 cold/warm keyboard-readiness checks and
10 measured save iterations after three compilation warm-ups. The starting
fixture was `mixed-v1-1000-cbfcca2e13cf76a5-plus21captures` (1,021 tasks,
221 Inbox). After a fresh launch, Inbox was 234, accounting for all 13 captures.
The normal app was untouched; the phone was returned Home and Benchmark stopped.
Thermal status was 0 before/after measurement; initial battery temperature 29.2°C.

There were 533 measured frames, 47 positive overruns; pooled frame CPU p95
12.14 ms and frame-overrun p95 2.37 ms. These are not save-latency percentiles.
In iteration 0 the largest overruns occurred during opening, before Save. The
inspected save-close frame took 9.41 ms wall / 2.87 ms scheduled CPU and met its
deadline. Its 4.85 ms binder call reached `IWindowSession.remove` in system_server
(surface placement/focus work), not SQLite. The runner's Save section includes
automation waits and must not be reported as persistence time.

This bounded trace inspection does not rule out JS, I/O, allocation or contention
problems in other frames. Save-under-sync contention and native durable-ack
latency remain follow-ups; no speculative modal/keyboard change was made.

## Local artifacts

Under `/home/dd/.cache/mindwtr-performance-tmp/capture-storage-followup/`:

- `control/`, `candidate/`: sequential storage reports, including the slow candidate.
- `merge-control.cpuprofile`, `node-control/`: diagnostic CPU profile and matching bundle/map.
- `build-pair.ts`, `merge-entry.ts`, `compare-pair.mjs`, `pair-control/`,
  `pair-candidate/`, `paired-bun-1.json`, `paired-bun-2.json`, `paired-node-1.json`:
  reproducible paired experiments. Control bundle SHA-256
  `9cf1b4e089e28f35cc9c5b8d7b2fbcd013f43db57e54161312c0286db649a1f2`;
  candidate `9124c31c8c3fa8c7aca0f79e540ab7e50b95f2a4c907433d899eb34198524e6b`.
- `mobile/captureSave-PJWfeV/`: native report, ten traces, readiness and identity checks.
- `reliability/synthetic-FYwfrV/report.json`: restart and sync-convergence acceptance.

Trace facts are recorded in the matching `MindwtrBenchmark_captureSave_iter000_2026-09-09-12-07-27.perfetto-trace_analysis.md`
under `/home/dd/.cache/mindwtr-performance-tmp/mindwtr-perfetto/`.
Raw traces, bundles, databases and synthetic data remain local.
