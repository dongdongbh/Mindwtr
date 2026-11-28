# Native Android memory over repeated use at 5,000 tasks, 2026-11-28

Task native-memory-soak-20261128-110. First retained-memory measurement of the native Android app. Raw files:
`/home/dd/scratch/logs/native-memory-soak/` (`runs/*.jsonl` samples, `heap/*.perfetto-trace` heap graphs, `apks/base/` APKs,
R8 mapping and the probe patch).

## Result

**No app leak.** Over 200 cycles of normal use at 5k, the app's own memory stays flat after the first 20 cycles:

- **QuickJS heap** (the core store and bundle): 38,515 KB at cycle 20, 38,497 KB at cycle 200.
- **Java heap** after a forced GC: 7,924 → 8,188 KB (cycles 20 → 200, run without UI dumps).
- **Native heap**: 76.7–79.8 MB the whole time, no trend.
- **Graphics**: 55.0–55.3 MB; **Views** 11 and **Activities** 1 at every sample.

A garbage collector (GC) frees memory that nothing uses any more. "Reachable" Java memory is what the GC cannot free. The reachable
Java heap was 27.77 MB after 20 cycles and 27.38 MB after 200 cycles.

Two things do grow, and neither is app code:

1. **Compose's accessibility delegate** keeps two maps per screen element that has custom accessibility actions. It adds entries
   each time an accessibility client reads a newly composed element. It clears them only when the whole Compose view leaves the
   window. Compose 1.9.0 (our BOM `2025.08.01`) does this, and upstream `androidx-main` still clears the two maps only in
   `onViewDetachedFromWindow`. It grows only while an accessibility client reads the screen. The `uiautomator` dumps our device
   scripts use are such a client; TalkBack is another. In the soak with a UI dump at every step, it cost **about 20 KB of Java heap
   per cycle** (49 map entries per cycle).
2. **Autofill assist channels:** each text-field focus leaves one `AssistStructure$SendChannel` binder that the system still holds
   (exactly 2 per cycle: the capture title and the search field). Each costs about 44 bytes of Java heap plus a small binder object.
   That is about 30 KB over 200 cycles.

Total PSS still rises by about 5 MB over 180 cycles in the run without UI dumps (173.6 → 178.9 MB). Most of it is the `System`
row (12.5 → 15.2 MB). That row is the app's share of memory pages shared with other processes, such as framework code and fonts.
Its growth slows down over the run: +0.8 MB from cycle 20 to 40, then no growth from cycle 140 to 200 (15.2 MB both times). The app's private rows do not
explain it. This report does not attribute it further.

## Setup

- Phone: Galaxy S23 `RFCW10JBP0Y`, Android 16. Battery 79–80% on USB, thermal status 0 at the start and end of every run.
- Package: Benchmark `tech.dongdongbh.mindwtr.nativeclient.dev.benchmark` (minified, profileable), seeded through its debuggable
  twin, ART at `verify`. Source `a6ff148c0` (origin/main) plus the probe below. APKs: Benchmark
  `4953702767e1dbe6483bfe19234d92fa40e9bd012d65bb514126f4a20eb55de1`, BenchmarkSeed
  `cb5d0c460baed76e6189aa313163c007b363151ef18719371b85a35b430ef9e1`. Bundle `core-host.js` CRC `0bf539fd`.
- Fixture `large-5000.db` (sha256 `9cae3bf1…287c`), the same one as the [startup report](native-android-startup-2026-10-26.md).
  Each soak starts from a fresh seed and a cold start. Sync is off.
- Another landing ran gates on the host during the first run. These are memory samples only; no timing claim is made.

### The probe (Benchmark builds only)

The host had no way to read the QuickJS heap. Benchmark builds now register a receiver for the broadcast
`tech.dongdongbh.mindwtr.BENCHMARK_MEMORY_PROBE`. On that broadcast the app runs QuickJS's GC on the engine thread, reads
`JS_ComputeMemoryUsage().memory_used_size`, runs `Runtime.gc()`, and logs `quickjsUsedBytes`. Release builds never register it; a boot
gate pins that guard and the action name the script sends.

I first tried `am send-trim-memory` as the GC trigger. Android 16 refuses a second trim at the same level ("Unable to set a higher
trim level than current level"), so it cannot trigger a sample every 20 cycles.

### The soak script

`apps/android-native/scripts/measure-memory-soak-device.mjs <serial> <label> <out-dir> [cycles] [every] [checked|replay]`.
One cycle is: Focus tab, the quick-access tab (Review on this library), Inbox tab, five flings down and five back up, open the first
task in the editor and go back, open quick capture and close it, Menu › Waiting For and back, then Search, type a query, and go back.
Every `every` cycles it sends the probe broadcast, waits for the probe line, and reads `dumpsys meminfo` (App Summary and Objects).
It fails if the app process changes.

- `checked` verifies every step with a UI dump (44.5 s per cycle).
- `replay` checks cycle 1 step by step and records its taps. Later cycles replay the taps without UI dumps (about 28 s per cycle).
  Before each replayed step it checks that the app is in front. If it is not, it reopens the same process and goes on; more than 10
  such recoveries fail the run. Cycle 2 saves a screenshot after each step.

## Memory over cycles

Samples after a forced GC (QuickJS GC + `Runtime.gc()`), in KB. Run `replay-200` (UI dumps only in cycle 1 and at samples):

| Cycle | Total PSS | Java heap | Native heap | QuickJS used | Graphics | System | Local binders |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 0 | 156,757 | 5,884 | 82,880 | 38,335 | 47,336 | 5,885 | 27 |
| 20 | 173,620 | 7,924 | 79,144 | 38,515 | 55,208 | 12,500 | 89 |
| 40 | 174,672 | 7,976 | 79,464 | 38,515 | 55,040 | 13,304 | 122 |
| 60 | 173,876 | 8,176 | 77,672 | 38,515 | 55,160 | 13,944 | 156 |
| 80 | 175,195 | 8,024 | 78,876 | 38,515 | 55,272 | 14,191 | 171 |
| 100 | 176,017 | 8,180 | 78,944 | 38,515 | 55,080 | 14,737 | 213 |
| 120 | 177,124 | 8,124 | 79,708 | 38,494 | 55,320 | 14,936 | 249 |
| 140 | 177,272 | 8,260 | 79,816 | 38,495 | 55,152 | 15,200 | 287 |
| 160 | 177,293 | 8,056 | 79,720 | 38,499 | 55,120 | 15,321 | 340 |
| 180 | 178,242 | 8,184 | 78,824 | 38,497 | 55,248 | 15,138 | 396 |
| 200 | 178,861 | 8,188 | 79,648 | 38,497 | 55,208 | 15,213 | 414 |
| 200 + 60 s idle | 178,753 | 8,020 | 79,744 | 38,497 | 55,208 | 15,213 | 415 |

The app left the front 6 times, each time at the same point: the replayed tap on the first row came while the list was still
moving, so no editor opened and the replayed Back left the app. The script reopened the same process each time (cycles 5, 13, 154,
166, 172, 188).

Run `base-200` (`checked`, a UI dump at every step), same build and fixture:

| Cycle | Total PSS | Java heap | Native heap | QuickJS used | Graphics | System | Local binders |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 0 | 156,032 | 5,892 | 81,896 | 38,335 | 47,336 | 5,544 | 27 |
| 20 | 171,514 | 8,444 | 77,352 | 38,512 | 49,664 | 15,950 | 117 |
| 60 | 174,751 | 9,464 | 78,304 | 38,512 | 49,656 | 17,219 | 184 |
| 100 | 176,018 | 10,864 | 77,512 | 38,512 | 49,696 | 18,030 | 233 |
| 140 | 178,333 | 11,488 | 78,684 | 38,512 | 49,696 | 18,537 | 326 |
| 200 | 178,864 | 11,996 | 78,732 | 38,495 | 49,808 | 19,060 | 432 |

Here the Java heap grows steadily: +3.55 MB from cycle 20 to 200, about 20 KB per cycle.

## Attribution (Perfetto heap graphs)

Heap graphs (`android.java_hprof`) were taken after 20 checked cycles (`base-20`), after `base-200`, and after `replay-200`. Classes
are deobfuscated with the build's R8 mapping.

| Reachable after | Java heap reachable | Compose a11y map entries (`SparseArrayCompat`) | `AssistStructure$SendChannel` |
| --- | ---: | ---: | ---: |
| 20 checked cycles | 27.77 MB | 982 | 40 |
| 200 checked cycles | 31.43 MB | 9,821 | 400 |
| 200 replayed cycles | 27.38 MB | 16 | 366 |

Between 20 and 200 checked cycles, the five growing classes are `int[]`, `Object[]`, `long[]`, `MutableObjectIntMap` and
`SparseArrayCompat`: +3.86 MB together, 8,839 new entries. They hang off the two fields `actionIdToLabel` and `labelToActionId` of
`AndroidComposeViewAccessibilityDelegateCompat`. Everything else together shrank by 0.2 MB. Without UI dumps the maps stay at 16
entries.

## Cold start, native vs RN (context, not a target)

Fresh seed of the same fixture, cold start, 10 s settle, `dumpsys meminfo` without a forced GC, 3 rounds each:

| App | Total PSS (KB), rounds | Median | Java heap | Native heap | Graphics |
| --- | --- | ---: | ---: | ---: | ---: |
| Native Benchmark (this build) | 204,016 / 200,218 / 204,184 | **204,016** | 42,032 | 90,352 | 49,140 |
| RN Benchmark (`b27d017a0`, archived 10-26 APKs) | 281,167 / 284,424 / 276,505 | **281,167** | 40,848 | 59,048 | 61,232 |

Native uses about 27% less at cold start. Its Java heap after a GC is only about 6 MB. Most of the 42 MB at start is garbage from
the 5k load, which the next GC frees.

## Judgment calls

- **Sample GC trigger:** a Benchmark-only broadcast receiver, not `am send-trim-memory` (refused after the first trim on Android 16)
  and not `am dumpheap` (a full heap dump per sample is slow and changes the heap it measures).
- **Fixture:** `large-5000.db`, the fixture of the startup and boot reports, so the numbers line up with them.
- **No fix.** The only steady Java growth is in Compose's accessibility delegate. It needs an accessibility client, and upstream
  still clears it only when the view leaves the window. Removing our custom accessibility actions would hurt TalkBack users, and
  clearing Compose's internal maps by reflection would be fragile. At about 20 KB per cycle with a client reading every screen,
  1,000 such cycles would cost about 20 MB.
- **Replay mode** exists because the UI dumps themselves made the growth. A memory soak that dumps the UI at every step measures
  the accessibility delegate, not the app.

## Limits

- One phone, one fixture, one build. Two full runs of 200 cycles, sampled every 20 cycles.
- The `System` PSS row (shared pages) grows by about 3 MB over each run and levels off near the end. It is not attributed.
- Replay mode taps fixed coordinates. Six times a row tap missed and the app was reopened in the same process.
- Search typing dropped the first letter of the query when the keyboard was not yet up. The search still ran on the rest.
- Not measured: sync, attachments, a long idle session, the editor with typing, larger fixtures, TalkBack itself.
- The RN number uses the archived 10-26 RN Benchmark APKs. They replaced the RN Benchmark that was on the phone (1.3.7, 11-01).

## Next

- If TalkBack users with long sessions matter, report the Compose map growth upstream with this heap graph, or retest on a newer
  Compose that clears the maps for removed elements.
- Attribute the `System` row with `showmap` before and after a run, if shared memory ever matters.
