# Native Android interactions after a month of parity passes, 2026-11-28

Task native-interactions-recheck-20261128-111. Raw files: `/home/dd/scratch/logs/native-interactions-recheck-20261128-111/`.

**Verdict: no interaction regressed.** About 370 Android-native commits landed between the 10-26 control and current main
(modal scrims, sheets, chips, Edit/Preview, Contexts, quick capture, link titles, widgets, startup work). No scenario got worse by
more than 15% and outside the control's p90. Startup is much faster. Nothing was changed in the app.

## Setup

- Phone: Galaxy S23 `RFCW10JBP0Y`, Android 16, 120 Hz, thermal status 0, load under 1.3 for the whole run.
- Package: only the Benchmark build `tech.dongdongbh.mindwtr.nativeclient.dev.benchmark` (minified, profileable, not debuggable),
  seeded through its debuggable twin with a fresh install for every round. Sync off.
- Fixture: `large-5000.db` (5,000 tasks, sha256 `9cae3bf1…287c`), the same file as the 10-26 native 5k batch.
- Method: the 10-26 head-to-head harness (`h2h.mjs`, `h2h-analyze.mjs`), unchanged except for its log paths. A new `pool.mjs` pools
  the per-round results per build. The metric definitions are in the
  [10-26 report](native-android-startup-2026-10-26.md#rn-vs-native-head-to-head-2026-10-26).
- Order: interleaved ABBA ABBA (base, main, main, base, base, main, main, base), 4 samples per round, so n = 16 per cell. Each round
  holds `gates.lock` and `s23.lock`. Both APK hashes were checked before and after the run.
- RN was not measured again. The 10-26 RN numbers stay as context.

| Build | Commit | `app-play-benchmark.apk` sha256 | `app-play-benchmarkSeed.apk` sha256 |
| --- | --- | --- | --- |
| base (10-26 control, archived APK) | `0a10ba227` | `fbe3b2a0…7468` | `68338718…697c` |
| main | `0066f898e` | `ee3ca7f8…0bf0ec` | `8d62e066…04df2` |

## Old vs new

Median / p90 in ms, n = 16 per cell, 5k fixture.

| Scenario | base `0a10ba227` | main `0066f898e` | Change |
| --- | ---: | ---: | --- |
| Cold start, first content | 1059 / 1096 | **460** / 489 | −57% |
| Cold start, TTID | 133 / 141 | 135 / 155 | same |
| Warm start, first content | 108 / 118 | **62** / 78 | −43% |
| Tab Focus→Inbox, first frame | 58 / 84 | 52 / 83 | same |
| Tab Inbox→Review, first frame | 36 / 41 | 38 / 49 | +2 ms, inside the control's range (18–44) |
| Editor open, first frame | 22 / 33 | 25 / 29 | +3 ms, inside the control's p90 |
| Editor open, settled | 97 / 111 | 100 / 122 | +3%, inside the control's range (83–120) |
| Capture open, first frame | 25 / 48 | 21 / 40 | same |
| Capture open, keyboard fully shown | 680 / 688 | 666 / 682 | −14 ms |
| Save to list, settled | 407 / 429 | 337 / 345 | −17% |
| Scroll, app-caused deadline misses | 1.6% | 1.3% | same |
| Scroll, frames over the 8.3 ms deadline | 15.3% | 16.4% | inside the round spread |

Notes on the table:
- **The control reproduced 10-26.** Its numbers match the 10-26 native 5k column within a few ms (for example cold first content
  1059 vs 1045, editor settled 97 vs 94, keyboard shown 680 vs 668).
- **Scroll, per round:** frames over the deadline were 10.4–23.6% on base and 13.7–18.4% on main. The pooled 1.1-point difference
  is round-to-round noise. Main drew about 35% more frames for the same 5 flings (10,572 vs 7,852). The cause was not traced.
- **Editor settled, per round:** base medians 90–99 ms, main 99–107 ms. The 3 ms pooled shift is smaller than one round's spread.
- **Tab "settled" is not compared.** It was 386 ms on base because of the tab button's ripple (10-26 note). Since `cf0e0424f` the
  tab items fade when pressed, as RN's do, so main settles at 67–102 ms. That is a look change, not a speed change.
- **Save "settled"** is the system keyboard's hide animation
  ([11-01 report](native-android-save-2026-11-01.md)). The saved row was not in view at this sort on either build (0/16), as on 10-26.
- The visible-keyboard check passed in all 32 capture rounds (`mInputShown=true`).

## Limits

- One phone, one fixture size (5k). The 1k cells were not measured again.
- n = 16 per cell. Tab, editor and save end on animation frames, so small shifts inside 5 ms are below what this method resolves.
- The harness opens the editor from the first Inbox row and capture from the tab bar's "+". Other entry points (Focus rows, the
  Contexts sheet, Edit/Preview inside the editor, link title lookups) were not timed.
- The Benchmark package was left installed with the base build from the last round.
