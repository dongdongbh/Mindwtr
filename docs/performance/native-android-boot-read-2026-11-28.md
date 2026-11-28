# Native Android boot read at 5,000 tasks, 2026-11-28

Task boot-read-json-20261128-109. Follow-up to the [load normalizer pass](native-android-load-normalizer-2026-11-27.md), which left
`JSON.parse` of the SQL read reply (about 43 ms) and `sqlite:decodeTasks` (29 ms) as the next costs. Raw files:
`/home/dd/scratch/logs/boot-read-json/` and `/home/dd/scratch/boot-read-json-bench/`.

## Result

**Cold first content at 5k: 494 → 465 ms (median, n = 20 per arm), p90 513 → 502 ms.** `sqlite:readRows` drops 91.9 → 67.3 ms.
The empty start does not move (235 vs 233 ms). Every SQL read builds the same row objects as before: same keys, same key order, same
values. `sqlite:decodeTasks` is unchanged (29.4 ms); this pass did not change it (see Judgment calls).

## The change

`SqliteBridge.all` (Kotlin) answered each SQL read with one JSON object per row, so a 1,000-row task page repeated all 50 column
names 1,000 times, and about three quarters of the cells were `null`. QuickJS `JSON.parse` read each name as a new string, turned it
into an atom, and added it to the row object.

The bridge now has a second read, `sqlAllArrays` (`SqliteBridge.allArrays`). Its reply is one JSON array: first the column names,
then one array of values per row, in column order. The values are written by the same code as before (`appendValue`). The bundle
(`apps/android-native/bundle/host-sql-rows.ts`) parses the reply and builds each row with a small function made once per column list
(`new Function` returning an object literal). The literal sets the same keys in the same order as `JSON.parse` did:

- a repeated column name keeps its first place and its last value (the old Kotlin writer did this itself; now the literal does);
- a `__proto__` column becomes an own property (written as a computed key);
- integer-like names such as `"1"` come first, as in any JS object.

The reply for the 5k task pages shrinks from about 4.96 MB to 1.63 MB of text (the fixture's 46 columns).

`host-entry.ts` uses `sqlAllArrays` when the host has it, else `sqlAll`. Native iOS (Swift) has no `sqlAllArrays`, so it keeps the
object reply. The Kotlin host still registers `sqlAll`, so an older bundle on a newer host also works. One log line,
`v1.4.0/sql-array-rows`, reports how many array replies a process sent (once per process, after first content).

## Correctness

- **Frozen corpus.** `SqliteBridgeArrayRowsTest` (Kotlin) writes 10 SQL reads both ways (`all`, the old reply, and `allArrays`) over
  a 200-row table with random NULLs, text (empty, quotes, slash, control characters, U+2028, emoji, bad JSON, JSON arrays and
  objects), integers above 2^53 and at the 64-bit limits, reals, `-0`, a BLOB, booleans, repeated and special column names
  (`__proto__` twice, `constructor`, `toString`, `"1"`, `"10"`, `""`, `a"b`, `é`) and empty results. It fails unless both replies
  equal the committed `bundle/host-sql-rows.corpus.json`. `host-sql-rows.test.ts` (Bun) then checks that the rows built from each
  array reply have the same SHA-256 digest as `JSON.parse` of the old reply. Each digest covers the prototype, every own key in order,
  its attributes, the value's type and value, and `-0`. The 10 digests (`host-sql-rows.digests.json`) were recorded from the old reply.
- **Mutants.** Dropping the `__proto__` case fails 2 of 3 Bun tests; a JSON round trip of each row (loses `-0`) fails 1; skipping
  the first row fails 2; caching builders by column count instead of the names fails 1. In Kotlin, writing a repeated column's
  first value fails 2 of 4 tests. One mutant (`?? null` on each value) survived; it is equivalent, because a parsed JSON value is
  never `undefined`.
- **Store load.** `host-sql-arrays-boot.test.ts` boots the bundle on one SQLite database twice, once with only `sqlAll` and once with
  `sqlAllArrays` too. The loaded tasks, projects, sections, areas and settings are the same JSON text, and the second boot never calls
  `sqlAll`. Forcing the fallback or skipping a row fails it.
- **On the phone (`proof` build).** For every `SELECT` reply, the build also read the old reply and compared the two row lists (same
  dump as the digest). Three starts per fixture (the first start after a fresh seed, then two cold starts, each followed by 25 s of
  post-start work): 5k at least 150, 70 and 70 replies (25,202 rows in the first start); empty at least 150, 60 and 60 replies.
  **0 mismatches.**
- Boot gates pin the guarded `sqlAllArrays` callback (callback count 56 → 57) and the routing line in `host-entry.ts`.

## Setup

- Galaxy S23 `RFCW10JBP0Y`, Benchmark build only (`tech.dongdongbh.mindwtr.nativeclient.dev.benchmark` and its seed twin). ART at
  `verify`. The `cand` Benchmark build stays installed.
- Base `a6ff148c0` (origin/main). APKs in `apks/<tag>/` with `SHA256SUMS`, checked again after the batch (all OK):
  - `control`: the base, Benchmark APK `da4a0a10…d6b`, bundle `98911b85…a929`.
  - `cand`: the base plus this change, Benchmark APK `fd2dacaa…e44f`, bundle `8bb00add…c6bf`.
  - `proof`: `cand` plus the temporary reply comparison, Benchmark APK `82cf3be6…677d`. Correctness only, not timed.
- Fixtures: `empty`, and `large-5000` (`/home/dd/.mindwtr-harness/startup/large-5000.db`, sha256 `9cae3bf1…287c`).
- Interleaved A/B (`ab.sh`, as on 11-27): 4 rounds, order flipped each round; each round reinstalls the arm, seeds it, runs one first
  start, then 1 discard and 5 cold samples. n = 20 per arm per fixture. Every start ran the shipped bytecode (`outcome=hit`).
  Perfetto: 3 traced cold starts per arm at 5k after 3 warm-up starts (`trace.sh`).
- One batch held `gates.lock` and `s23.lock`, 01:36–01:50; load 2.9 at the start and 1.3 at the end. Thermal status 0, battery
  27–32 °C.

## A/B (first content, ms)

| Fixture | Arm | Median | p90 | min–max | TTID median |
| --- | --- | ---: | ---: | ---: | ---: |
| large-5000 | control | 494 | 513 | 464–540 | 140 |
| large-5000 | cand | **465** | **502** | 449–528 | 136 |
| empty | control | 235 | 258 | 221–272 | 135 |
| empty | cand | 233 | 249 | 222–289 | 132 |

## Phases at 5k (3 traces per arm, median ms)

| Phase | control | cand |
| --- | ---: | ---: |
| `core:boot` | 220.1 | **197.4** |
| `js:activate` | 190.8 | 168.2 |
| `sqlite:readRows` | 91.9 | **67.3** |
| — of it `sql:all` (Kotlin, 12 calls) | 43.0 | 32.3 |
| — the rest (reply into QuickJS, parse, row build) | 48.9 | 35.0 |
| `sqlite:decodeTasks` | 29.4 | 29.4 |
| `store:normalize` | 49.7 | 49.3 |
| `js:verifyActivation` | 14.9 | 14.4 |

Both sides of the bridge gain: Kotlin writes a third of the text (−10.7 ms), and QuickJS receives and parses less (−13.9 ms).

## Host QuickJS

The same five 1,000-row pages from `large-5000.db`, the vendored QuickJS built for x86-64 (`qjsbench`), median of 21 rounds, three
runs: `JSON.parse` of the object reply 60.4–61.4 ms; array reply parsed and rows built 50.4–51.3 ms. Parsing the array reply alone
takes about 27 ms; building 5,000 objects of 46 properties takes about 21 ms with the literal. A loop that sets each property by name
was slower than the old parse (79 ms), and a constructor with `this[...]` assignments too (34 ms against 22 ms for the literal).

## Judgment calls

- **Android-only seam.** The change sits in the Kotlin bridge and the Android bundle's SQL client. Shared core
  (`sqlite-adapter.ts`) still receives row objects, so RN, desktop and native iOS are not touched, and no shared read gains a key.
- **A new bridge call, not a changed one.** `sqlAll` keeps its reply. The bundle checks for `sqlAllArrays`, so native iOS and an older
  host keep working, and an older bundle on this host still gets object replies. That is the fallback, so the pass adds the
  `v1.4.0/sql-array-rows` log line and ledger entry.
- **Every read uses the array reply, not only the task pages.** One code path. Building a row function costs about 176 µs for 55
  columns and 10 µs for one, once per column list; the cache holds at most 256 lists.
- **NULLs stay in the reply.** In the array reply a `null` is four bytes and cheap to parse. Leaving cells out would need a second
  pass to put the keys back in order.
- **`sqlite:decodeTasks` was checked, not changed.** In host QuickJS, `mapSqliteTaskRow` takes about 70 ms per 5,000 rows: about 24 ms
  is the 55-property task literal (inherent), 20 ms is `tags` and `contexts` (`fromJson` plus `toStringArray`, against 5.7 ms for the
  two bare `JSON.parse` calls), 7.6 ms the reminder lead and policy checks, 5 ms two status normalizations. A dedicated string-array
  reader could save about 9 ms on the host, about 4 ms on the phone. That is shared core and needs the RN, desktop and iOS suites, so
  it is left as the next lead.

## Limits

- One phone. n = 20 per A/B cell, 3 traces per arm.
- The proof check covered startup and its post-start work, not every screen or sync.
- The fixture has 46 task columns; a migrated library has a few more, so its reply shrinks slightly more.
- Desktop and RN do not use this bridge.

## Next

- **`sqlite:decodeTasks`, 29 ms:** a string-array reader for `tags` and `contexts` (about 4 ms, shared core).
- **`store:normalize`, about 49 ms,** and the Kotlin `sql:all` of the read, about 32 ms (SQLite steps and text writing).
