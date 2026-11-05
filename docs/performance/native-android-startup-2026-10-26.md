# Native Android startup and interaction performance, 2026-10-26

Work in progress for task perf-native-20261026-01. Raw files: `/home/dd/scratch/logs/perf-native-20261026-01/`.

## Setup

- Phone: Galaxy S23 `RFCW10JBP0Y`, Android 16. Only the Benchmark build is measured (`tech.dongdongbh.mindwtr.nativeclient.dev.benchmark`,
  minified, profileable, not debuggable), seeded through its debuggable twin. ART at `verify`, as a sideload leaves it.
- Fixture `large-5000`: core's `scripts/performance/fixture.mjs` store with 5,000 tasks, made on 2026-10-01
  (sha256 `9cae3bf1…287c`).
- Every measured batch holds `gates.lock` (no builds or gates) and `s23.lock` (the phone), waits for a 1-minute load under 3, and records load,
  battery, thermal status and refresh rate at its start and end.
- APKs are archived with their hashes under `apks/<tag>/SHA256SUMS`.

## Baseline against the 10-01 budgets (main `0a10ba227`)

15 cold and 15 warm starts per database (`check-startup-device.mjs`, batch `base-startup`).

| Database | Cold TTID median | Cold first content median | Cold first content p90 | Warm first content median |
| --- | ---: | ---: | ---: | ---: |
| `empty`, budget | 160 | 360 | 400 | 100 |
| `empty`, 10-01 | 121 | 288 | 295 | 58 |
| `empty`, now | 122 | 356 | 373 | 62 |
| `large-5000`, budget | 160 | 1050 | 1150 | 100 |
| `large-5000`, 10-01 | 125 | 874 | 888 | 61 |
| `large-5000`, now | 126 | 1038 | 1057 | **103 (fails)** |

That batch started at load 2.3, but the 5-minute load average was 6.0. So it was confirmed with an interleaved A/B in a quiet window.

## Regression since 10-01: confirmed and attributed

Interleaved A/B, large-5000, 4 rounds of 5 cold starts per variant, fresh seed per round, load 0.3–3.2 (`batch-ab1.out`):

| Variant | Commit | Cold first content median | p90 | n |
| --- | --- | ---: | ---: | ---: |
| b0 | `91576e042` (10-01, "one full read at boot") | 890 | 907 | 20 |
| base | `0a10ba227` (main, 10-26) | 1011 | 1023 | 20 |

That is +121 ms (+14%). TTID did not change (131 vs 129 ms).

Perfetto cold-start traces, 2 per variant (`traces/trace1/`). These phase deltas appear in both pairs:

1. **Focus first screen (a50374a5e..4120b7061, 10-22), about +70 ms.** At 10-01 the first screen was the Inbox. Its first window was computed
   inside boot (`js:inboxWindow`, 8 ms). Now the first screen is Focus (as RN), and its read is a separate `core:focus` call after boot:
   100 ms of JS at 5,000 tasks, then the frame. Later Focus reads are cached (4 ms).
2. **Bundle growth across the whole range, about +50 ms.** `assets/core-host.js` grew from 7.85 MB to 9.71 MB (+24%). `js:bundleInit`
   went from 113 to 153 ms, `core:evaluate` from 149 to 202 ms.
3. `core:boot` became 30 ms faster (529 vs 558 ms), which offsets part of the growth.

Not part of the regression, but on the core thread right after first content: `core:widgetsRefresh` runs twice (185 + 146 ms) and
`core:pomodoroPanelRead` runs 3 times (about 50 ms each, 38 SQL reads each, from two row-baseline checks). A tap in the first half second
waits behind them.

Where a large-5000 cold start spends its time now (base-2): process and bind about 115 ms, bundle evaluate 200 ms, `core:boot` 527 ms
(`js:activate` 475 ms, of which 93 ms is 23 SQL reads), `core:focus` 100 ms, first frame about 40 ms.

## RN vs native, head to head (2026-10-26)

Same phone, same fixtures (core's `mixed-v1` 1k and 5k), sync off. Both are Benchmark builds:
- RN: `tech.dongdongbh.mindwtr.benchmark`, release, profileable, main `b27d017a0`.
- Native: main `0a10ba227`.

Each app is seeded fresh. There is one batch per app and fixture, interleaved: native 5k, RN 5k, RN 1k, native 1k. Each scenario has n=8, and each
interaction is traced on its own (`h2h.mjs`, `h2h-analyze.mjs`, raw files in `h2h/`).
- **First frame:** from the tap's input event in the app to the end of the app's first frame.
- **Settled:** to the end of the app's last frame before a 250 ms pause.
- **Keyboard shown:** to the last frame of the system's IME insets animation (`system_server`).

| Scenario (median / p90 ms) | Native 5k | RN 5k | Native 1k | RN 1k |
| --- | ---: | ---: | ---: | ---: |
| Cold start, first content | **1045** / 1202 | 1312 / 1383 | **517** / 536 | 1020 / 1049 |
| Cold start, TTID | **125** / 156 | 393 / 415 | **123** / 147 | 395 / 416 |
| Warm start, first content | **106** / 116 | 842 / 871 | **80** / 95 | 462 / 470 |
| Tab Focus→Inbox, first frame | **70** / 78 | 323 / 379 | **47** / 84 | 302 / 332 |
| Tab Inbox→Review, first frame | **30** / 51 | 468 / 507 | **33** / 89 | 207 / 219 |
| Editor open, settled | **94** / 128 | 230 / 246 | **102** / 134 | 221 / 235 |
| Capture open, first frame | **24** / 33 | 128 / 139 | **37** / 47 | 125 / 172 |
| Capture open, keyboard fully shown | **668** / 704 | 741 / 757 | | |
| Save to list, settled | 415 / 427 | **173** / 188 | 335 / 353 | **127** / 156 |
| Scroll, frames over the 8.3 ms deadline | **10.1%** | 60.6% | **10.2%** | 61.9% |
| Scroll, app-caused deadline misses | 1.8% | **1.1%** | 1.6% | **1.2%** |

Native is behind in two places: **save** (2.4x RN) and, slightly, **app-caused scroll misses**.

**Correction (2026-11-01):** save is not a gap. Native's save "settled" is the keyboard's hide animation. The saved row shows
sooner on native (124 vs 189 ms at 5k). See [native Android save, 2026-11-01](native-android-save-2026-11-01.md).

Metric notes:
- **Capture "settled" is not compared.** Native re-lays out with the keyboard on every frame of its animation, and RN lays out once. So
  native's app frames run to about 726 ms while the keyboard itself was fully shown earlier on native (668 vs 741 ms).
- **Native's tab "settled" (about 388 ms at both sizes) is the tab button's ripple.** Native's content frame is at about 100 ms. RN's settled
  times (434 / 493 ms) follow its slower first frames.
- **The first scroll rule (23.5% vs 10%) counted system-attributed jank** (SurfaceFlinger, display HAL, prediction), so the table shows
  app-caused misses and frames over the deadline instead. Both apps render at 120 Hz.
- `savedRowVisible` was 0/8 on both apps: the new row is not in view after a save at this sort. That check is being fixed.

## Fixes and their measured effect (running table)

Cold start to first content at large-5000 on the S23. Each row is an interleaved A/B on archived APKs (fresh seed per round,
ART at `verify`, quiet window), against the row above it. n = samples per side.

| Commit | Change | Cold first content median (p90) | Delta | n | Batch |
| --- | --- | ---: | ---: | ---: | --- |
| `0a10ba227` | main (baseline) | 1012 (1035) | | 20 | `ab-h1p` |
| `24a200dc6` | Widget publisher builds nothing again for the same inputs (H2) | not on the first-content path | | | |
| `1bb0508c5` | Focus builds derived project summaries only for review projects (H1') | 960 (998) | **−52** | 20 | `ab-h1p` |
| `1a1559e8e` | Widget build waits for a quiet core (H2b) | 962 (972) | (first tap, below) | 20 | `ab-h3a` |
| `bc88442b6` | Load normalizer builds each task once (H3a) | **823** (847) | **−139** | 20 | `ab-h3a` |

**Cumulative at 5k: cold first content 1012 → 823 ms (−189 ms, −19%).** This is below the 10-01 budget run's 874 ms, and well below RN's
1312 ms (37% less).

H2 removes a duplicate 146 ms widget build from core's thread right after first content. Its effect is on the first tap, measured
separately (below).

### First tap right after first content (H2b)

Cold start at large-5000, a tap on the first Focus row 1150 ms after launch (first content lands at 1000–1100 ms), traced. Latency runs
from the tap's input event to the editor's settled frame. Interleaved ABBA, 5 taps per round (`firsttap-ab.sh`, batch `ft-h2b`, load 0.4–1.5).

| Variant | Commit | Editor settled median (p90) | First frame | n |
| --- | --- | ---: | ---: | ---: |
| h2 | `24a200dc6` (widget memo) | 348 (413) | 10–13 | 8 |
| h2b | `1a1559e8e` (H1' + widget build waits for a quiet core) | **121** (230) | 10–13 | 10 |

That is about −225 ms on the first tap. h2→h2b also contains H1' (first content about 45 ms earlier). The bulk matches the 186 ms
widget build that no longer runs ahead of the tap's read. Widgets still publish: the build starts once core has been quiet for 300 ms,
at most 2 s after it was asked for (`WidgetRefreshGateTest`).

### Save to the visible row (S1)

After a command, core reads what is on screen first (`AfterCommandReads`, `b7110026c`). Save-only runs, newest-first fixture (so the new row
is in view), ABBA with 4 saves per round (`save-ab.sh`, batch `save-s1`):

| Variant | Save settled median (p90) | Visible list read ends | Row visible check | n |
| --- | ---: | ---: | ---: | ---: |
| h3a (`bc88442b6`) | 363 (390) | 331–344 ms | 8/8 | 8 |
| s1 (`b7110026c`) | **338** (344) | **297 ms** | 8/8 | 8 |

The visible list now reads right after the save (`core:menuRead` follows `core:captureSubmit`). The hidden Focus (50 ms), Projects (50 ms)
and Pomodoro (45 ms) reads follow it. "Settled" is now bounded by the sheet and keyboard animation after the row lands. What remains
of save's gap to RN (173 ms) is `core:captureSubmit` itself, 230–250 ms at 5k; the S2 probe splits it.

## Notes on the load normalizer (H3a)

- `post_process` (235 ms at 5k) was almost all `normalizeTaskForLoad` (230.5 ms). The 19 load migrations together took 4.1 ms (probe2).
- The fixture's tasks never come back by identity. Raw rows lack `rev`, `pushCount` and `revBy`. After a save round trip, only rows with an
  empty `revBy` are still rebuilt (the mapped row carries the key, which the normalizer drops); rows with a non-empty `revBy` come back by
  identity. So the gain comes from building each task once, not from the identity return.
- Equivalence: a frozen copy of the parent's code in `task-normalize-load.test.ts` (corpus, a 2,000-task library, store-level
  byte-identical load, mutation of each normalized field). The Opus review fuzzed 2.04 million load calls with 0 differences.

## Rejected, withdrawn or not done

- **Rejected: skip hidden-list reads after a write ("stale until shown").** A tab switch would show rows that were not re-read, so a tap
  could act on a stale row. S1 only reorders the reads.
- **Rejected for now: merge queued Pomodoro reads.** A merge window wide enough to help would use a presentation captured before a later
  request. It saves about 50 ms.
- **Withdrawn: "rawReadRow bypasses #766's identity cache."** Raw rows are registered only by `getData({ rawTasks: true })`. Store tasks
  use #766's cache, and the per-save recheck of raw-read objects is pinned by a test.
- **Metric corrections:**
  - Capture "settled" counts native's per-frame keyboard layout, so keyboard-shown is the comparison.
  - Tab "settled" on native is the button ripple.
  - The first jank rule counted system-attributed jank.
- **Not done yet:** the S2 save split. Startup budgets are not changed in this
  pass: warm first content at 5k failed its 100 ms budget at 103 ms on the baseline, and it has not been re-measured after the fixes.

### First save after a cold start (S2a)

The first save in a process did about 180 ms of one-time work at 5k:
- building every task's save row: 108 ms, because #766's row cache is empty after a load;
- fingerprinting the load's raw rows as the save's baseline: 72 ms.

The probe builds attributed both (`runs/probe3-save`, `runs/probe4-save`). S2a does both while the engine is quiet after first
content, in 500-row slices, through the same row cache and the same fingerprint rule the save uses. The warmed fingerprints are used only
for the same read object with no write since (two guard tests, each failing when its guard is removed).

Interleaved ABBA, 16 saves per side at large-5000, save-only runs (`save-s2a`, `ab-s2a`, `ft-s2a`):

| Metric | base2 (`d1a87597c`) | s2a | n |
| --- | ---: | ---: | ---: |
| `core:captureSubmit` (the save) | 230–272 ms | **64–95 ms** | 16 / 16 |
| Visible list read ends after the tap | 271–334 ms | **113–152 ms** | 16 / 16 |
| Save "settled" (bounded by the sheet and keyboard animation) | 336 / 340 | 338 / 332 | 8 / 8 |
| Cold first content median (p90) | 825 (841) | 835 (859), ranges overlap | 20 / 20 |
| First tap after first content, settled | 68–78 | 71–83 | 7 / 8 |
| Warm slices per cold start | | 21, mean 8.5 ms, max 11–17 ms, 179 ms total | 10 starts |

So a call that arrives during the warm waits at most about 17 ms (one slice). The new row now appears about 130 ms after Save, vs RN's
173 ms settled.

## Memory, RN vs native (large-5000)

`mem.mjs` runs the same session on both apps: a fresh seed of `large-5000-newest.db`, a cold start, then `dumpsys meminfo` after each
step. Native is base2 (`d1a87597c`); RN is `b27d017a0` with the benchmark-scheme patch. QuickJS (native) and Hermes (RN) both count in
Native Heap. Medians of 3 rounds, in MiB; rounds differ by at most 8 MiB (`runs/mem-base2`, `runs/mem-rn`).

| After | Native total PSS | RN total PSS | Native heap (native / RN) | Java heap (native / RN) | Code (native / RN) |
| --- | ---: | ---: | ---: | ---: | ---: |
| Start (+10 s) | **193** | 284 | 91 / 60 | 29 / 40 | 16 / 55 |
| Inbox scroll | **197** | 377 | 87 / 131 | 22 / 46 | 16 / 55 |
| Editor open and close | **194** | 402 | 87 / 137 | 18 / 54 | 16 / 55 |
| Capture and save | **191** | 338 | 87 / 101 | 23 / 26 | 17 / 56 |
| 30 s idle | **185** | 330 | 88 / 100 | 16 / 19 | 17 / 56 |

Native uses about half of RN's memory after any interaction, and stays flat over the session (185–197 MiB). Its largest part is the
QuickJS heap (87–91 MiB), which holds the 5,000-task store and the bundle. RN starts lower on native heap (60 MiB) but grows by about
75 MiB once the lists render.

