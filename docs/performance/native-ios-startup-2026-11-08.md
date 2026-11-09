# Native iOS cold start, 2026-11-08

## Setup

- **Phone:** iPhone 12. The app is "Mindwtr Native Dev" (`tech.dongdongbh.mindwtr.native.dev`), installed over the existing app with its data kept.
- **Build:** main `8d0b42aad`, Debug with `-O`, whole module, testability off, and the `NATIVE_PERF_SIGNPOSTS` timing markers.
  - Optimization proof: VERIFIED.
  - Source manifest: `e7f061e2…`.
  - The normal build was put back after the run. Its preservation check passed: only the test libraries were added.
- **Libraries:** `mixed-v1-5000` and `mixed-v1-1000`, each staged as a fresh `NativeUITests/<uuid>` library.
- **Runs:** one checked first launch, then 1 warm-up and 8 measured cold starts per library, recorded with xctrace's App Launch template and os_log.
- **Interruption:** the other scenarios (warm start, tab switch, editor, capture, scroll) stopped when an iOS "Software Update" alert appeared. The runner never answers system alerts. Those scenarios still need a run.

## Cold start

| Library | First frame, median / p90 | Inbox first content, median / p90 | n |
| --- | ---: | ---: | ---: |
| 5k | 158 / 161 ms | 1656 / 1680 ms | 8 |
| 1k | 160 / 162 ms | 854 / 879 ms | 8 |

- **Where the growth sits:** nearly all of it comes before the first screen read. That read is marked `perf.refresh_chrome`.
  - Before it: about 1.53 s at 5k and 0.65 s at 1k.
  - Inbox read and paint after it: about 150 ms.
- **5k Time Profiler:** the main thread is mostly idle.
  - The host queue: `Engine.invoke` about 390 ms, `Engine.start` about 290 ms, `Engine.call` about 228 ms.
  - The SQL bridge: about 200 ms, writing rows as JSON text.
  - JavaScriptCore garbage collection is heavy.

## Attribution

Bun runs JavaScriptCore, the same engine as iOS. A Bun replay of the iOS startup host calls ran against the same libraries. Times below are medians in no-JIT mode.

- **Total to the first screen read:** 518 ms at 1k and 1114 ms at 5k.
- **App lock pair:** `appLockOptions` and `appLockDelayOptions` each loaded the whole library through `getData()` to read one setting.
  - Cost at 5k: 192 ms and 187 ms.
  - Data at 5k: 5.3 MiB of JSON each.
  - Share: about half of the growth from 1k to 5k.
  - Native iOS also runs both reads on every tab tap.
- **`boot`:** 374 ms at 5k, which is the other half. The store needs this load.
  - 72% of its row cells are NULL.
  - A column-and-array row format would cut the bridge JSON by about 68%. It is not built.

## Fix: App lock option reads use the light saved-settings read

- **How the read works now:**
  1. The reads flush any queued save.
  2. They read settings through `readRowBaseline()`, like the AI timeout, Gemini, voice and Board readers.
  3. They keep the store staleness check.
- **Fallback:** they use the full read when another writer has committed, when the light read throws, or when the adapter is not guarded.
- **Unchanged:** reply keys and error strings.
- **Tests** (all three failed before the fix):
  - no full task-table read at 5,000 tasks, with replies equal to the full-read replies;
  - a queued save is flushed before the read;
  - an external commit makes the read fall back.

| Replay mode | Library | To first screen read | `appLockOptions` | `appLockDelayOptions` |
| --- | --- | ---: | ---: | ---: |
| no-JIT | 1k | 522 → 450 ms | 42.5 → 9.6 ms | 39.8 → 1.5 ms |
| no-JIT | 5k | 1109 → 761 ms | 189 → 25.1 ms | 187 → 5.4 ms |
| JIT | 1k | 445 → 423 ms | 20.0 → 5.6 ms | 17.5 → 1.0 ms |
| JIT | 5k | 705 → 560 ms | 79.6 → 14.6 ms | 78.1 → 1.6 ms |

- **Data read by the pair at 5k:** 10.6 MiB before, 417 KiB after.
- **Native Android:** it does not call these two methods, so it is unchanged.
- **Phone measurement of the fix:** owed.
- **RN comparison:** not run, because it needs dd's approval to swap Mindwtr Dev data.
