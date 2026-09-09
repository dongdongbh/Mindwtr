# Capture context rendering — September 9, 2026

## Finding and bounded fix

The tab layout passes a fresh `{ openQuickCapture }` wrapper to
`QuickCaptureProvider` when its local state changes. Even when the callback is
unchanged, that wrapper invalidates context consumers, including memoized ones.
The provider now memoizes its value by the callback. A changed callback still
propagates; selected-area defaults and route capture are not frozen.

A render-count regression reproduced three consumer renders for the initial
mount and two wrapper-only updates. After the fix, only the initial render
remains. A second regression verifies callback replacement and forwarding of
initial task properties, text, audio mode, and return route. The existing tab
layout capture tests also pass.

This removes a demonstrated source of unnecessary rendering. It does not imply
that the entire navigation tree avoids rendering, or that native modal opening
and closing are now within their frame deadlines. Modal presentation, keyboard
timing, parsing, task writes, and capture workflow are unchanged.

## Why investigate context identity

The three fresh sampled control traces from the
[profiling-cache investigation](profiling-cache-2026-09.md) contain
React context propagation, property copying/diffing, Fabric commits, and GC
before the native opening frames. Clock alignment places 40, 35, and 40 Hermes
samples in the 50 ms preceding those frames, respectively; none is root-only.
Sampling identifies candidate work, not its exact CPU cost or a causal speedup.

Hermes samples use `steady_clock` timestamps converted to microseconds in the
[pinned profiler](https://raw.githubusercontent.com/facebook/hermes/e0fc67142ec0763c6b6153ca2bf96df815539782/lib/VM/Profiler/SamplingProfiler.cpp)
and [serializer](https://raw.githubusercontent.com/facebook/hermes/e0fc67142ec0763c6b6153ca2bf96df815539782/lib/VM/Profiler/ChromeTraceSerializer.cpp).
The POSIX implementation uses
[`CLOCK_MONOTONIC`](https://raw.githubusercontent.com/llvm/llvm-project/release/18.x/libcxx/src/chrono.cpp).
Using each trace's [clock snapshots](https://perfetto.dev/docs/analysis/sql-tables#clock_snapshot),
the alignment is `sample.ts * 1000 + (snapshot.ts - snapshot.clock_value)` for
MONOTONIC. The offset was 787420877927 ns for iterations 0/1 (52 ns range), and
787420877849 ns for iteration 2 (1 ns range). Filename wall clocks were not used
to assign individual samples to frames.

## Native work remains

In sampled control iteration 2, the opening UI frame lasted 26.13 ms with
16.65 ms of main-thread CPU. Creating the one ModalHost accounted for 8.55 ms
wall time / 3.89 ms CPU; Android window add and relayout Binder transactions
took 2.87 and 2.97 ms. There was no duplicate modal: 52 native objects were
created, including the text input, text, views, and SVG elements.

The closing frame lasted 21.36 ms with 10.03 ms of main-thread CPU. Its removal
batch took 17.09 ms wall time / 6.34 ms CPU, including a 6.21 ms window-removal
Binder transaction. Removing the accessibility connection took 1.96 ms;
system_server spent 0.93 ms contending on a lock held during another window
visibility update. These are measured dependencies, not all attributable to JS.
The JS thread ran for 4.49 ms in that opening frame and 0.91 ms in the closing
frame. Root-only Hermes samples alone were not treated as proof of idle time.

One incomplete Runnable thread-state row overlapped later complete states.
Extending it to the trace end falsely labels the whole frame Runnable. For the
two reported windows, only complete intervals were used and their summed
coverage was checked against the exact frame duration (26131250 and 21363542
ns). General analysis must not silently discard incomplete states without a
coverage check.

The earlier sampler-inactive control traces also contain slow modal opening and
removal frames, so native window cost is not unique to Hermes sampling.
Previously rejected immediate-focus and inline-presentation experiments remain
rejected; see [the focus investigation](capture-focus-2026-09.md).
This is a bounded investigation, not a complete capture latency diagnosis.

## Validation

- All 18 provider/tab-layout capture tests passed, as did mobile typechecking
  and targeted ESLint. The complete performance gate passed: seven core tests,
  two desktop list/timeline tests, and six mobile large-store tests. No build or
  other test suite ran alongside the measured device batch.
- The Benchmark release build passed. The installed APK matched its archive.
  A fresh manual open/close exported `capture-1788988448384-1.cpuprofile`
  (13976 samples, 2832 frames); the title input was focused and the synthetic
  Inbox remained 234. This deliberately held-open preflight is not a timing
  sample.
- All 20 automated cold/warm keyboard-readiness checks passed on the connected
  OnePlus CPH2655 (Android 16).
- Three measured open/close iterations passed after three compilation warm-ups.
  Target and runner APK hashes matched before and after the batch. It exported
  26 new nonempty profiles (20 readiness, three warm-up, three measured), in
  addition to the manual preflight. The raw profiles were preserved; only copies
  of the measured profiles were symbolicated with the matching candidate map.
- The original uninstrumented Benchmark APK was restored with `install -r` and
  its installed SHA-256 verified as
  `3ef80137cd44952a5e4b1943049b1d97b67c63098d86e15e249521731d69061f`.
  A fresh launch still showed the 234-item synthetic Inbox. The Benchmark app
  was then stopped. No normal-app data was changed or cleared.

Local artifact root:
`/home/dd/.cache/mindwtr-performance-tmp/native-contention/capture-context/`.

| Artifact | SHA-256 |
|---|---|
| Candidate sampling APK | `dfd34ec2eccc855ee9a97dbad7584e7025b682a3fe53bbf657521ccd17024533` |
| Matching source map | `377ea0e30bc5fa7ba7ce168390555beeda4800e88c4b831818f20a11f34a1a77` |
| Instrumentation runner | `fab7679a1d7e94859ad037c0aa739c8f88f5dce24c377608db816cc33b819dbe` |

The device batch is `measurement/captureOpenClose-nh4ADw/`. Measured profiles:

| Iteration | Fresh profile | Samples | Root-only samples |
|---|---|---:|---:|
| 0 | `capture-1788988614840-1.cpuprofile` | 1572 | 1493 |
| 1 | `capture-1788988620166-2.cpuprofile` | 1539 | 1466 |
| 2 | `capture-1788988625526-3.cpuprofile` | 1483 | 1399 |

Aligned candidate samples still show React/Fabric/GC work before modal creation:
28, 33, and 38 non-root samples in the preceding 50 ms. Candidate clock offsets
were 787420877875 ns (260 ns range) for iteration 0 and 787420877901 ns (104 ns
range) for iterations 1/2. The modal-creation UI frames lasted 22.16, 28.55, and
13.25 ms; iteration 2 also had a 12.89 ms subsequent modal layout frame.
The measured traces each report one `power_rail_empty_packet` import issue.

| Diagnostic batch | Frame CPU p95 | Frame overrun p95 | Worst frame overrun |
|---|---:|---:|---:|
| Sampled control (three iterations) | 17.97 ms | +7.13 ms | +14.30 ms |
| Sampled candidate (three iterations) | 15.07 ms | +7.03 ms | +16.85 ms |

Sampling-build timing is diagnostic, not a production speed gate. These are
small, non-interleaved batches with varying frame counts (93 control, 78
candidate). Lower aggregate CPU p95 and sample counts do not establish a
repeatable latency improvement; the worst overrun was higher. The validated
benefit of this change is the eliminated wrapper-only context invalidation.
Native window/frame cost remains a follow-up, requiring an uninstrumented,
interleaved comparison before claiming an end-to-end speedup.
