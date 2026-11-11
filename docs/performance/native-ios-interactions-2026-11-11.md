# Native iOS interactions vs RN, 2026-11-11

**Result:** native iOS now starts faster than RN, but it is still slower than RN on every interaction.
Cold start to Inbox content is **853 ms** native vs 1300 ms RN at 5k. Tab switches are **1.4 to 2.8 times** RN's time.
A device trace shows why: SwiftUI rebuilds the new tab's list on every tab switch.

## Setup

- **Phone:** iPhone 12, iOS 17.5.1, sync off, the synthetic `mixed-v1` libraries (5k: `099f2950…`, 1k: `e36f090e…`).
- **Native build:** an optimized marker (timing) build of `0d26937f6` (`-O`, whole module, `NATIVE_PERF_SIGNPOSTS`),
  installed as `tech.dongdongbh.mindwtr.native.dev`.
- **Before:** the native batches of the head-to-head on `2cc35cce3` (`measure-v5` for cold start, `measure-v6` for the rest).
- **RN:** the RN batches of the same head-to-head (`tech.dongdongbh.mindwtr.dev`, release-style build, same seed).
- **Harness:** Appium + WebDriverAgent taps, xctrace `os_log` markers, n = 8 or 9 per row plus one warm-up.
  Packet: `.orchestrator/tasks/ios-perf-ab-20261110-01/packet` (local, not in git).

## Before and after, 5k library (median ms)

| Scenario | Before | After | RN | After / RN |
| --- | ---: | ---: | ---: | ---: |
| Cold start, first frame | 163 | 165 | 163 | 1.01 |
| Cold start, Inbox content | 1141 | **853** | 1300 | **0.66** |
| Warm start, content | 59 | 56 | 46 | 1.22 |
| Tab Focus to Inbox | 259 | 160 | 82 | 1.95 |
| Tab Inbox to Focus | 279 | 232 | 82 | 2.83 |
| Tab Inbox to Review | 116 | 115 | 82 | 1.40 |
| Tab Review to Inbox | 242 | 171 | 113 | 1.52 |
| Editor open, first sheet frame | 181 | 178 | 99 | 1.81 |
| Capture open, first sheet frame | 166 | 153 | 82 | 1.86 |

The 1k batch did not run. Midway, the Mac's `CoreDeviceService` stopped reaching the phone
(`Failed to allocate RSD device`, `0xE8000003`). Restarting that service restored the link.
The scroll hitch metric recorded no data in either run.

The cold start gain comes from `bc7df67e8` (SQLite rows mapped without extra copies), `03ddd74c5` (lazy chrono/fflate,
JSON locale tables) and `1bd5f0d42` (SQLite rows written as JSON bytes). The tab gains come from `0d26937f6`. That commit
skips unchanged state writes, per-row swipe re-reads and Spotlight rebuilds.

## Where a tab switch spends its time

A Time Profiler + `os_log` trace recorded 12 Focus/Inbox taps on the same build (5k).
The analyzer is `.orchestrator/tasks/ios-tab-mount-20261111-01/trace-attrib.py`.

- **Main thread, not the core:** the window from `perf.refresh_start` to `perf.refresh_language` lasts 115.6 ms.
  The main thread is busy for 114.7 ms of it. The JavaScriptCore host thread uses 11 ms.
- **The new tab is built from scratch:** the first SwiftUI update after the tap takes 40 to 56 ms.
  `InboxScreen.primarySurfaceContent` picks one screen with `if/else`, so a tap removes the old tab and creates the new
  tab's `List`.
- **Then each cell is sized:** 10 to 20 small passes of 1 to 3 ms follow, one per new list cell.
- **Mostly SwiftUI's own work:** 68 of the 115 ms has no app function on the stack. App code costs about 20 ms:
  - `TaskCard.body`: about 9 ms.
  - Dictionary bridging and type casts: about 10 ms. `model.items` re-reads the Inbox dictionary on every body run.
  - Row identity getters: about 3 ms.
- **After the data arrives:** `perf.refresh_surface` to `perf.screen_ready` costs another 31 to 98 ms of the same kind of work.

RN's tab bar keeps a visited tab mounted, which is the React Navigation default. So RN does not rebuild the list.

## Next

1. **Keep visited bottom tabs mounted** (task `ios-tab-mount-20261111-01`), then measure the change on the phone.
2. **Narrow what each view observes.** `CoreModel` is one `ObservableObject` with about 867 `@Published` properties.
   Every publish re-diffs every mounted observer. Per-property tracking (`@Observable`) needs iOS 17, but the app's
   minimum is iOS 16. Raising the minimum is a product decision for dd.
3. **Editor and capture open** are about 1.8 times RN; trace them the same way.
