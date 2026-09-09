# Native desktop capture sampling — September 9, 2026

## What reproduced

The preceding [append-save verification](performance-native-append-capture-2026-09.md)
found an intermittent visibility delay but did not capture its stacks. An opt-in
JavaScriptCore sampler now runs alongside the in-page render probe, without
changing application code or save scheduling.

Ten measured native captures plus an excluded warm-up passed at 10,000 synthetic
tasks. Enter-to-DOM times were 125, 144, 144, 148, 156, 161, 164, 164, 168, and
344 ms (sorted, rounded). All used the same candidate executable, fixture,
2560 x 1393 viewport at ratio 2, and Linux Wry 0.53.5 runtime. Every capture
passed exact-once persistence, independent SQLite readback, save-idle boundaries,
and reload survival. Every retained sampling profile contained stack samples.

This is a diagnostic batch, not a before/after speedup or p95 gate. The profiler
adds overhead. It reproduced a slow **in-page** interval, so WebDriver polling
alone cannot explain this sample; it does not prove the same cause for every
earlier slow uninstrumented sample.

## Evidence from the slow sample

Measured run 5 took 344 ms and contained 295 stack samples. The preceding run 4
took 125 ms and contained 106 samples. Comparing those two capture windows:

| Observed stack | Run 4 | Slow run 5 |
| --- | --- | --- |
| `buildChangedEntityBaseline` anywhere in stack | 0 | 87 |
| Virtualizer `measureElement` at top of stack | 12 | 12 |
| `safeParseDate` anywhere in stack | 13 | 16 |

The slow sample includes this call path:

`saveData → buildChangedEntityBaseline → sameEntitySnapshot → computeStableValueFingerprint → sorted normalization / JSON.stringify`

It was resolved against the exact retained release assets, not a rebuild:
`index-DwzDFX3-.js` maps `Pg` to `buildChangedEntityBaseline`, `yl` to
`sameEntitySnapshot`, and `Tn` to `computeStableValueFingerprint`.
`vendor-CrRaJ_uW.js` maps `aH` to the virtualizer's element-size read.
The latter reads `offsetHeight` when no ResizeObserver border-box entry is supplied.

This localizes save-baseline preparation entering the pre-frame critical path.
It does not establish why scheduling allowed it to run before the frame, nor
assign all extra elapsed time to this one function. Samples are not exact
milliseconds, and absent samples are not proof that a function never ran.

## Next bounded fix

Investigate avoiding repeated sorted serialization and fingerprint hashing when
comparing save-baseline entities. Preserve full snapshot equality semantics,
observed IDs, queued-write provenance, concurrent-writer protection, and settings
rebase behavior. Do not defer durable acknowledgement, weaken CAS checks, or
replace equality with revision-only comparison to make the chart faster.

First add a differential correctness test and a large cloned-snapshot benchmark
at `buildChangedEntityBaseline`. Then repeat native sampling and uninstrumented
interleaved measurements against archived executables. Row measurement and date
parsing are still visible costs, but neither explains the extra stack work in
this captured sample; they are not the first fix target.

## Provenance

All artifacts remain local under
`/home/dd/.cache/mindwtr-performance-tmp/native-contention/`:

- `jsc-capture-smoke/desktop-9oSWNi/`: one warm-up and one measured profile.
- `jsc-capture-investigation/desktop-mb2rEo/10000-report.json`: ten measured runs.
- Slow profile: `jsc-capture-investigation/desktop-mb2rEo/10000-5-jUdDoK/`.
- Adjacent ordinary profile: `jsc-capture-investigation/desktop-mb2rEo/10000-4-3BCOrB/`.
- Unprofiled smoke: `jsc-disabled-smoke/desktop-Ls2yS0/`; warm-up and measured
  capture passed with `profiling: none` and no sampling directories created.

Each sample records its raw profile filename in `jscProfile.file`, relative to
that sample directory. Executable SHA256:
`27a01863e331a45c00c90e7f051ef8f0360458ca3810b0dbc8be4e4b5fb6a015`.
Runner checkout was `f82df67a9`, dirty while sampling tooling was developed;
the app executable and its release assets were unchanged.

Fourteen runner/probe/save-idle tests passed, including unavailable sampler hooks,
normal-mode isolation, stop-at-frame cleanup, timeout shutdown, ordered clocks,
invalid intervals, and missing/empty stacks. Retained native profiles also passed
the final sampling-window and stack-data validator. No production code changed.
