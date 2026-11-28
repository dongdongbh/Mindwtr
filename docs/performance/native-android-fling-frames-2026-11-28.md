# Native Android fling frames at 5k, 2026-11-28

Task native-fling-frames-20261128-112. Raw files: `/home/dd/scratch/logs/native-fling-frames-20261128-112/`.

**Verdict: the extra frames are more scrolling, not wasted drawing.** Main draws about 35% more frames than the 10-26 control
for the same 5 scripted flings because main's Inbox keeps scrolling. The control's Inbox stops at row 50, where its **More**
button sits, so its last two flings hit the list end and stop in 355 ms. Main loads the next 50 rows by itself (since
`7647451e4`), as RN's FlatList scrolls the whole list, so every fling runs its full length. Both builds draw at 120 Hz while the
list moves, and neither draws a frame after the list stops. Nothing was changed in the app.

## Setup

- Phone: Galaxy S23 `RFCW10JBP0Y`, Android 16, 120 Hz, thermal status 0.
- Package: only the Benchmark build `tech.dongdongbh.mindwtr.nativeclient.dev.benchmark`, seeded fresh for each build. Sync off.
- Fixture: `large-5000.db` (sha256 `9cae3bf1…287c`). Its Inbox has 1,000 tasks.
- APKs: the archived ones from the interactions re-check (task 111). Both SHA256SUMS files checked OK before the run.

| Build | Commit | `app-play-benchmark.apk` sha256 | `app-play-benchmarkSeed.apk` sha256 |
| --- | --- | --- | --- |
| base (10-26 control) | `0a10ba227` | `fbe3b2a0…7468` | `68338718…697c` |
| main | `0066f898e` | `ee3ca7f8…0bf0ec` | `8d62e066…04df2` |

- Gesture: the task 111 scroll step, unchanged. Five `input swipe 540 1700 540 700 150` with 900 ms between them, from the top
  of the Inbox, under a Perfetto trace with the SurfaceFlinger frame timeline.
- Traces: the 32 task 111 scroll traces (16 per build, 7 s each), plus 4 new traces (2 per build, 13 s each, so about 6 s of idle
  time follow the last fling). After each new trace, a UI dump recorded the visible rows and any **More** button.
- Analysis: `analysis/seg.mjs` splits each trace into the 5 gestures (input events closer than 300 ms are one gesture). For each
  gesture it counts the app's frames, the fling length (input end to the last frame before a 100 ms gap), the frames after that
  gap, and the median frame interval. `analysis/like.mjs` compares flings 1 and 2 only.

## Results

All 36 traces, pooled (18 per build):

| | base `0a10ba227` | main `0066f898e` |
| --- | ---: | ---: |
| App frames | 8,811 | 11,899 (+35%) |
| Time the list moved | 75.0 s | 100.9 s (+35%) |
| Frames per second while moving | 117.5 | 118.0 |
| Median frame interval | 8.33–8.38 ms | 8.33–8.37 ms |
| Frames per fling, flings 1 and 2 | 130.5 | 130.8 |
| Frames per fling, flings 4 and 5 | 59.8 | 133.8 |
| Fling length, flings 4 and 5 | 355 ms | 970 ms |
| Frames after the list stopped | 0 | 0 |
| App surfaces in the frame timeline | 1 (MainActivity) | 1 (MainActivity) |

Fling lengths per trace were the same in every round. Base: about 960, 960, 750, 355, 355 ms. Main: about 960 ms for all five.

- **The list end.** After the 5 flings, the UI dump on base showed rows "Synthetic task 210" to "Synthetic task 245" and the **More**
  button at the bottom (the 50th row). Main showed "Synthetic task 370" to "Synthetic task 410" and no **More** button, past the
  first 50-row window. Screenshots: `phone/<build>/fling-<n>-end.png`.
- **The refresh rate did not change.** Both builds draw one frame every 8.33 ms while the list moves.
- **No idle drawing.** In the 13 s traces the app drew no frame for the 6.1–6.7 s after the last fling stopped, on both builds. In
  all 180 gestures, no frame came after the 100 ms gap that ends a fling.
- **No second surface.** Each trace has one app layer. The status bar's few frames (17–25) are the system's.
- **Recomposition was not traced.** The Benchmark build is minified and has no composition tracing. The frame counts make it
  unnecessary: a composable that redraws with nothing changing would draw frames after the list stops, and there are none.

## Judgment

The handoff names this a valid outcome: the extra frames are the same scroll, carried on for longer. Main's behavior matches RN.
RN's Inbox is one FlatList over all tasks, with no **More** button. Removing frames here would mean stopping the scroll early,
which would break RN parity. No fix was made.

## What this means for scroll comparisons

- **The 10-26 and task 111 scroll rows compared different motion.** The control's last two flings were end-of-list stops (the
  stretch overscroll), which are short and cheap. Main's were full flings.
- **Like for like, flings 1 and 2 only** (both builds scroll freely; 4,187 vs 4,182 frames over 32 traces): app-caused misses
  1.0% on base and 1.5% on main; frames over 8.4 ms 19.9% and 16.0%. Per trace, app-caused misses were 0.8–1.5% on base and
  1.1–1.9% on main. That is about one more missed frame in every two flings. It was not traced; it is small and the per-trace
  ranges overlap.
- **Future scroll A/Bs** should use flings that do not reach a list end on either build, or compare per gesture.

## Limits

- One phone, the 5k fixture, the Inbox only. Other lists that load windows by themselves (Waiting For, Someday, Reference and
  others) were not traced; they use the same loader.
- The phone check ran while other work loaded the host. Frame counts and intervals are measured on the phone, so host load does
  not change them. No host-timed latency was measured.
- The Benchmark package was left installed with the main build.
