# Native Android load normalizer at 5,000 tasks, 2026-11-27

Task load-normalizer-20261127-105. Follow-up to [`core:boot` at 5k](native-android-boot-5k-2026-11-16.md), which left the load
normalizer (`store:normalize`) at 88.6 ms of `core:boot`. Raw files: `/home/dd/scratch/logs/load-normalizer/` and
`/home/dd/scratch/load-normalizer-bench/`.

## Result

**`store:normalize` at 5k: 89.7 → 49.9 ms (median of 3 traces). Cold first content at 5k: 529 → 493 ms (median, n = 20 per arm),
p90 540 → 514 ms.** On a 5k library whose rows carry `rev` and `revBy`, as rows saved by the app do, `store:normalize` drops
109.2 → 40.9 ms and first content 549 → 488 ms. The empty start does not move (232 vs 229 ms). The normalized store objects are
unchanged for every platform: same keys, same key order, same values, and the same object identity.

## The change

`normalizeTaskForLoad` (shared core: RN, desktop, native Android and native iOS) ran for every task:

1. a copy of the task without `rev` and `revBy` (object rest);
2. a second copy with the repaired fields (object spread);
3. `sameShallowRecord(task, next)`, which builds `Object.keys` of both objects (about 50 keys each) and, when they match, walks them all.

In host QuickJS at 5k, these cost about 37, 37 and 60 ms of 165 ms. SQLite rows with a null `revBy` never match (the copy drops the
key), so they paid all three. Rows with `rev` and `revBy` usually match, so they paid the full key walk too (253 ms in host QuickJS).

The new code computes every repaired value first, as before. Then it asks, field by field, whether the task already holds each value
as its own property (`storedAs`, the same equality `sameShallowRecord` uses), and whether `revBy` is present exactly when it is kept.
If so, it returns the task. If not, it makes one copy without `rev` and `revBy` and assigns the repaired fields in the old literal's
order. That gives the same keys in the same order as the old spread, so no full key comparison is needed.

The field check is exact for plain data records (own, enumerable data properties): every load source produces those (`JSON.parse`,
`mapSqliteTaskRow`, `structuredClone`, spread copies). It would differ only for a task with getters or non-enumerable properties.

## Judgment calls

- **Object identity.** The handoff asked whether any caller needs the normalized task to be a different object from the mapped row.
  One does notice identity: `rememberRawReadRow` keys the raw SQLite row by the mapped task object, and the save path
  (`getTaskRowEntry`) uses it only when the store holds that same object. The new code returns the input object in exactly the cases
  the old code did, so this is unchanged. The corpus test checks identity for every case.
- **Two lists in one function.** The "already normalized?" check and the copy list name the same fields. One shared list would need a
  per-task array or object and a loop, which costs more in QuickJS. A guard test reads `task-status.ts` and fails unless the check
  and the copy name the same fields (only `textDirection` is exempt: it is copied from the task itself, so its check could never
  fail and was dropped). The frozen corpus also fails if the two drift (mutants below).
- **No log line.** The output is identical, and there is no fast path with a fallback, so the startup log does not change.
- **`JSON.parse` of the read (43 ms) was not started.** It needs a transport change on both sides of the bridge.

## Frozen output

`packages/core/src/task-load-normalizer-corpus.test.ts` with `task-load-normalizer-corpus.json` (216 SHA-256 digests), all recorded
from the `ffc2a881f` code (`UPDATE_LOAD_NORMALIZER_CORPUS=1`; repeated recordings gave the same file). Three cases were added after
review, also recorded from the `ffc2a881f` code; the other 213 digests came out the same. Each digest covers the
normalized output with key order, `undefined`, `NaN` and `-0` written out, whether the output is the input object, which nested
objects are shared with the input, and a check that the input is not changed. The corpus:

- every repaired field (status, dates, project and area, text direction, `rev`, `revBy`, order, `pushCount`, tombstones,
  completion and cancellation, Focus with future starts, relative start, recurrence, reminder minutes, time spent, checklists,
  attachments, unknown keys), each value set and removed, on five base shapes (store task, desktop JSON task, SQLite row with null
  `rev`, SQLite row with `rev`, already normalized), with and without the temporal context;
- 1,200 random mixed shapes, some with shuffled key order;
- special shapes: an own `__proto__` key, `rev` first in key order, Focus on future starts by status, and an already normalized
  task with a bad or missing `createdAt` and an `updatedAt` in the future;
- 41 raw SQLite rows (legacy status, null `rev`, bad JSON in recurrence, checklist and tags, project-archive fields, a done task
  still in Focus with no `focusOrder`) through
  `mapSqliteTaskRow`;
- the 2,000-task performance fixture as objects, as SQLite rows, and after a first load;
- a full store load from a real SQLite file (`node:sqlite`) with legacy task, project, section, area and person rows, loaded twice
  (settings are left out of this digest so a new settings default does not fail it).

Mutants, each run against the corpus: dropping the `pushCount` repair failed 66 of 150 tests; dropping the `focusOrder` check from
the "already normalized?" test failed 2; dropping the `revBy` re-add failed 82; dropping the `revBy` key check failed 5; swapping
the `rev` and `revBy` key order failed 82; dropping the legacy `planned` status failed 8. Review found two single checks the first
corpus missed: the `createdAt` check (now fails `special object shapes`) and the `isFocusedToday` check for a finished task (now fails
the SQLite row and store load cases). A reviewer fuzz of 600,000 random inputs found 0 differences from the old code.

`task-normalize-load-work.test.ts` now pins that the normalizer makes no `sameShallowRecord` call (it was one per task).

## Setup

- Galaxy S23 `RFCW10JBP0Y`. Benchmark build only (`tech.dongdongbh.mindwtr.nativeclient.dev.benchmark` and its seed twin).
- Base `ffc2a881f` (origin/main). APKs in `apks/<tag>/` with `SHA256SUMS`:
  - `control`: the base, Benchmark APK `e6f4214b…55fa`, bundle `87cb6276…2111`.
  - `cand`: the base plus this change, Benchmark APK `06497237…613a`, bundle `929ef66d…9420`.
- Fixtures: `empty`; `large-5000` (`/home/dd/.mindwtr-harness/startup/large-5000.db`, sha256 `9cae3bf1…287c`, all `rev` and
  `revBy` null); `synced`, a copy with `rev` 1–7, `revBy` `device-0..2` and `pushCount` 0 on every task
  (`large-5000-synced.db`, sha256 `7b5ecae2…5b4c`).
- Interleaved A/B (`ab.sh`, as on 11-16): 4 rounds, order flipped each round; each round reinstalls the arm, seeds it, runs one first
  start, then 1 discard and 5 cold samples (ART at `verify`). n = 20 per arm per fixture. Every start loaded the shipped bytecode
  (`outcome=hit`). Perfetto: 3 traced cold starts per arm after 3 warm-up starts (`trace.sh`).
- Each batch held `gates.lock` and `s23.lock`. Batch 1 (large, empty, traces) 13:15–13:27, load 2.8 at the start; batch 2 (synced)
  13:28–13:35, load 0.6. Thermal status 0, battery 27–34 °C.

## A/B (first content, ms)

| Fixture | Arm | Median | p90 | min–max | TTID median |
| --- | --- | ---: | ---: | ---: | ---: |
| large-5000 | control | 529 | 540 | 516–568 | 140 |
| large-5000 | cand | **493** | **514** | 469–525 | 139 |
| synced | control | 549 | 562 | 525–611 | 134 |
| synced | cand | **488** | **513** | 465–517 | 138 |
| empty | control | 232 | 256 | 220–258 | 132 |
| empty | cand | 229 | 238 | 221–261 | 130 |

## Phases (3 traces per arm, median ms)

| Phase | large control | large cand | synced control | synced cand |
| --- | ---: | ---: | ---: | ---: |
| `core:boot` | 259.7 | **221.9** | 287.7 | **220.6** |
| `js:activate` | 230.7 | 192.2 | 250.6 | 182.8 |
| `store:normalize` | 89.7 | **49.9** | 109.2 | **40.9** |
| `sqlite:readRows` | 91.5 | 91.9 | 93.2 | 93.2 |
| `sqlite:decodeTasks` | 29.1 | 29.8 | 29.4 | 29.4 |

`sqlite:readRows` and `sqlite:decodeTasks` do not move; they serve as the control.

## Host microbenchmarks

Same 5,000 rows from `large-5000.db`, mapped by `mapSqliteTaskRow`, then normalized. Median of 15 rounds (QuickJS) or 41 rounds
(Bun), three interleaved runs each, `bench-entry.ts`.

| Runtime | Rows | Before | After |
| --- | --- | ---: | ---: |
| QuickJS (same vendored source, x86-64 `-O2`) | null `rev` | 128–132 ms | 63 ms |
| QuickJS | with `rev` and `revBy` | 252–254 ms | 79–87 ms |
| Bun 1.4.4 (JSC) | null `rev` | 6.9 ms | 4.9 ms |
| Bun 1.4.4 | with `rev` and `revBy` | 10.4–11.2 ms | 1.8–3.5 ms |

Desktop (WebKitGTK, WebView2, WKWebView) and RN (Hermes) were not measured. Both run the same function on load; the Bun numbers
suggest a few ms at 5k on a JIT engine.

## Limits

- One phone. n = 20 per A/B cell, 3 traces per arm.
- The synced fixture is synthetic (every task has `rev` and `revBy`); real libraries mix both shapes.
- One core test (`native-host-contract-project-task-order.test.ts`, "pages 53+ rows") failed once in the full core suite under load
  with `STALE_REVISION` and passed 3 of 3 runs alone. It reads the store directly and pages by a time-based revision; it does not
  run the load normalizer on its rows.

## Next

- **`JSON.parse` of the read, about 43 ms at 5k.** Fewer, larger strings or typed columns would need a bridge change.
- **`sqlite:decodeTasks`, about 29 ms.** `mapSqliteTaskRow` parses up to seven JSON columns per row and then normalizes status,
  recurrence and relative start, which the load normalizer reads again.
