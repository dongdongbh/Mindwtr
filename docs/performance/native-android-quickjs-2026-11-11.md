# Native Android QuickJS engine upgrade, 2026-11-11

Task quickjs-upgrade-20261111-52. The native Android app now builds QuickJS from source: bellard `3d5e064` (VERSION 2026-06-04) under wrapper 3.2.0's JNI and Java API (`apps/android-native/android/third_party/quickjs-wrapper`, local patches in its `PATCHES.md`). Before, the app used the Maven wrapper 3.2.0 with QuickJS 2024-02-14. Raw files: `/home/dd/scratch/logs/qjsup/`.

## Result

**The empty cold start now meets its 360 ms budget: first content 360 → 221 ms (median), p90 379 → 233 ms.** Large-5000 drops 796 → 578 ms. The gain comes from bundle evaluation, as the engine measurement (task quickjs-measure-20261111-51) predicted.

## Setup

- Phone: Galaxy S23 `RFCW10JBP0Y`, Android 16. Benchmark builds only (`tech.dongdongbh.mindwtr.nativeclient.dev.benchmark`: minified, profileable, seeded through its debuggable twin). ART at `verify`.
- Arms, archived with SHA-256 sums under `apks/<tag>/SHA256SUMS`:
  - `control`: `main` 64eb64c35, Benchmark APK `fdd29c50…0f58`.
  - `quickjs2`: branch `quickjs-upgrade` 31d71071e, Benchmark APK `9969023a…8125`.
  - Both carry the same bundle (body hash `91f77e64…9f53`).
- Interleaved A/B (`ab.sh`): 4 rounds, order flipped each round (AB, BA, AB, BA). Each round reinstalls the arm fresh, seeds it, and runs one first start that writes the bytecode cache. Then it runs 1 discard and 5 cold samples (n = 20 per arm per fixture). Every sample ran from the cache (`outcome=hit`, logcat). Then 3 memory samples: a cold start, 15 s settle, `dumpsys meminfo` (n = 12).
- The batch held `gates.lock` (no builds) and `s23.lock`. Load was 1.1 at the start and 3.3 at the end.
- Fixtures: `empty`, and `large-5000` (`/home/dd/.mindwtr-harness/startup/large-5000.db`).

## Cold start (ms)

| Fixture | Arm | First content median | p90 | min–max | TTID median |
| --- | --- | ---: | ---: | ---: | ---: |
| empty | control | 360 | 379 | 352–425 | 130 |
| empty | quickjs2 | **221** | **233** | 206–250 | 128 |
| large-5000 | control | 796 | 812 | 782–850 | 130 |
| large-5000 | quickjs2 | **578** | **605** | 569–613 | 136 |

An earlier batch on the same control (before the rope-string fix, which does not touch the empty path) gave empty 358 → 224 ms, so the result repeats.

## Phases (Perfetto, 3 traced cold starts per arm, median ms)

| Fixture | Arm | `core:evaluate` | `js:bundleInit` | `core:boot` |
| --- | --- | ---: | ---: | ---: |
| empty | control | 202.6 | 138.3 | 25.6 |
| empty | quickjs2 | 70.1 | 14.9 | 15.8 |
| large-5000 | control | 197.8 | 138.4 | 411.3 |
| large-5000 | quickjs2 | 82.1 | 14.6 | 325.6 |

`js:bundleInit` falls by about 124 ms; it was the old engine's linear search of captured variables (`get_var_ref`). Core's own JS also runs faster: `core:boot` at 5k drops by 86 ms.

## Memory (PSS 15 s after a cold start, n = 12, median MiB)

| Fixture | Arm | Total PSS | Native heap | Java heap |
| --- | --- | ---: | ---: | ---: |
| empty | control | 146.0 | 28.3 | 17.2 |
| empty | quickjs2 | 149.3 | 30.4 | 18.3 |
| large-5000 | control | 130.8 | 59.5 | 6.1 |
| large-5000 | quickjs2 | 135.6 | 66.5 | 6.2 |

The new engine costs 3–5 MiB of PSS (native heap +2 MiB empty, +7 MiB at 5k). The bytecode cache grows from 8.0 MB to 9.2 MB.

## Bug found by the A/B

The first new build never showed first content at 5k: `NOT_READY: null cannot be cast to non-null type kotlin.String`. The new engine keeps long joined strings as ropes (`JS_TAG_STRING_ROPE`). The wrapper's `toJavaObject` had no case for that tag, so a large reply reached Kotlin as `null`. The fix (31d71071e) sends ropes down the string branch, and a boot gate pins it. The engine harness and the empty fixture could not show this; only a large library through the real JNI did.

## Limits

- One phone. n = 20 per cell for timing, 3 traces per cell, 12 memory samples per cell.
- The cache-miss start (first start after an install) was not timed here. The harness measured parse at 581 → 504 ms.
