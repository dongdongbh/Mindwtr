# Android profiling cache isolation — September 9, 2026

## Reproduction and fix

The first property-order diagnostic APK had the native capture-sampling library
and `CAPTURE_PROFILING_ENABLED=true`, but exported no new Hermes profiles during
20 keyboard-readiness checks, three measured capture iterations, or a fresh
manual open/close. The twelve files on the device were from earlier sessions.
Its installed APK hash matched the archive, and the archive's bundle matched the
generated bundle byte-for-byte.

Hermes disassembly showed `beginCaptureProfile` contained only
`LoadConstUndefined` and `Ret`. Forcing `createBundleReleaseJsAndAssets` with
`--rerun-tasks` still produced that empty function. A direct Expo `export:embed`
with `--reset-cache` also returned immediately. A temporary, subsequently removed
probe confirmed Metro received `EXPO_PUBLIC_CAPTURE_PROFILING=1`.

Changing the Metro cache version with the profiling flag forced a fresh transform:
the same capture function then called the native profiler. The committed
configuration isolates four transform variants (neither profiler, startup only,
capture only, both). The opt-in Benchmark Gradle init script also declares the
two environment flags as bundle-task inputs, so a flag change cannot leave that
task up-to-date with the preceding bundle.

This fixes the measurement setup, not capture latency. No capture, persistence,
sync, permission, native entry point, or user-facing setting changed. The
native Benchmark-package and opt-in guards remain unchanged.

## Verification

- The configuration regression test failed before the fix (one shared cache
  version instead of four), then passed. It covers switching back to the normal
  configuration and the exact flag semantics used by each profiler.
- Mobile configuration tests and targeted ESLint passed.
- The Benchmark release build passed. Its compiled capture function contains
  the native start call.
- Switching only the capture flag to `0` reran the bundle task without
  `--rerun-tasks` (one executed task, 28 up-to-date). Its resulting bytecode
  contains no native start call, verifying the reverse cache transition.
- On the connected OnePlus CPH2655, the installed APK hash matched the fixed
  archive. One fresh open/close produced
  `capture-1788986836260-1.cpuprofile`: 10,097 samples and 3,019 stack frames.
  The input was focused, capture closed, and the synthetic Inbox stayed at 234.
  This manually held-open profile proves sampling works; it is not a latency
  benchmark.

- All 80 performance-tool tests passed (576 assertions); all 12 mobile Metro/
  build-variant configuration tests and targeted ESLint also passed.
- The fixed-APK automated run passed all 20 cold/warm keyboard-readiness checks
  and three measured open/close iterations after three compilation warm-ups.
  Both target and runner APK hashes matched before and after the run.
- It exported 26 new nonempty profiles: 20 readiness captures, three warm-ups,
  and three measured captures. The manual preflight is a separate 27th fresh
  profile. None of the twelve pre-existing profiles were used for attribution.
- The original uninstrumented Benchmark APK was restored with `install -r` and
  its installed hash verified. After a fresh launch, an empty capture opened
  and closed, the Inbox remained 234, and no new profile appeared. The
  Benchmark process was then stopped. No normal-app data was changed or cleared.
  The restored APK also contains no native capture-sampling library.

The automated artifacts are in `cache-fixed-measurement/captureOpenClose-I4NQ3I/`.
The raw measured profiles in `cache-fixed-profiles/` are:

| Iteration | Profile | Samples | Stack frames |
|---|---|---:|---:|
| 0 | `capture-1788987013015-1.cpuprofile` | 1591 | 2775 |
| 1 | `capture-1788987018335-2.cpuprofile` | 1542 | 2561 |
| 2 | `capture-1788987023724-3.cpuprofile` | 1564 | 2687 |

Their export timestamps align with the three retained Perfetto iteration traces
at 20:50:13, 20:50:18 and 20:50:24 UTC. Only copies were symbolicated, using the
archived fixed-build source map. App frames resolve to the capture sheet, task
list, and core quick-add/token helpers.

These profiles establish usable attribution, not a new performance improvement.
Root-only samples account for 1476/1591, 1436/1542 and 1474/1564 respectively;
they must not be charged to React rendering or interpreted as verified idle
time without scheduler evidence. React context propagation, Fabric property
diffing/commit calls and young-generation GC appear among non-root samples.
The next investigation should correlate these with the frame/commit windows
in Perfetto before changing rendering or parse caches. No definitive capture
latency root cause is claimed by this report.

## Artifact identities

Local artifact root:
`/home/dd/.cache/mindwtr-performance-tmp/native-contention/android-property-order/`.

| Artifact | SHA-256 |
|---|---|
| First diagnostic APK, sampler inactive in JS | `dcfd9342645d21d6871d91ea6a7f0b4e9c0733a9644a081fe704169868fb6dc9` |
| Fixed diagnostic APK | `3ec5bed66ca3bd44e6a1eb8f09323f157420548b62510d2b72be1566de2b86f5` |
| Fixed diagnostic source map | `5919231ba633ab2237d9fd265fd84ddb2ff2f5ff3cff6b3fa5ee976335ba5826` |
| Original uninstrumented Benchmark APK | `3ef80137cd44952a5e4b1943049b1d97b67c63098d86e15e249521731d69061f` |

The earlier, sampler-inactive batch lives at
`measurement/captureOpenClose-Mf3DNB/`. Its three fresh Perfetto traces are valid
frame evidence, but the stale Hermes files must not be attributed to this APK.
Across 77 frames, CPU-frame p95 was 21.34 ms and frame-overrun p95 was +9.16 ms;
14 frames had positive overrun. Frame duration is not input latency, three
iterations are not a release gate, and no before/after speed claim is made here.
