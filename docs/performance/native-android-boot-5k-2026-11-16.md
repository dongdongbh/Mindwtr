# Native Android `core:boot` at 5,000 tasks, 2026-11-16

Task native-boot-5k-20261116-81. Follow-up to the [QuickJS upgrade](native-android-quickjs-2026-11-11.md), which left `core:boot` at
326 ms of the 578 ms cold start at 5k. Raw files: `/home/dd/scratch/logs/nb5k/`.

## Result

**Cold first content at 5k: 578 → 518 ms (median), p90 587 → 529 ms.** `core:boot` drops from 324 to 258 ms. The SQL bridge
(`SqliteBridge.all`) built an `org.json` object for every row, then turned the object tree into text. It now writes the JSON text
straight from the row, and asks SQLite for each column's type once instead of twice. The reply text is byte-identical. Empty start does
not move: median 229 ms in both arms over two batches, though its p90 rose (see the A/B).

## Setup

- Galaxy S23 `RFCW10JBP0Y`, Android 16. Benchmark builds only (`tech.dongdongbh.mindwtr.nativeclient.dev.benchmark` and its seed twin).
  ART at `verify`.
- Base `b48861292` (origin/main). APKs, with SHA-256 sums in `apks/<tag>/SHA256SUMS`:
  - `control`: the base, Benchmark APK `b9751f78…4a54`, bundle `63861073…4e02`. Its tree also held this pass's ledger edit (docs only).
  - `fix`: the base plus this commit's code, Benchmark APK `a511dd27…bf50`, bundle `5c3fe2da…d575`.
  - `diag`: the base plus temporary trace sections (see below), Benchmark APK `f92c94dd…9668`. Attribution only.
  - `proof`: `fix` plus a temporary check that also builds every reply the old way and compares the two strings, APK `f4c71f51…0fe0`.
- Fixtures: `empty`, and `large-5000` (`/home/dd/.mindwtr-harness/startup/large-5000.db`, sha256 `9cae3bf1…287c`).
- Interleaved A/B (`ab.sh`, as on 11-11): 4 rounds, order flipped each round. Each round reinstalls the arm, seeds it, runs one first
  start that writes the bytecode cache, then 1 discard and 5 cold samples. n = 20 per arm per fixture. Every sample ran from the
  bytecode cache (`outcome=hit`). Perfetto: 3 traced cold starts per arm at 5k after 3 warm-up starts (`trace.sh`).
- Each batch held `gates.lock` (no builds) and `s23.lock`. Main batch 17:08–17:25, load 2.2 at the start and 3.2 at the end; the
  repeat empty batch and the miss traces 17:59, load 2.9 at the start. Thermal status 0;
  battery 28–33 °C.

## Where `core:boot` goes at 5k (before the fix)

`diag` build, 3 traced cold starts, median ms. The temporary sections: `sqlite:readRows` (the snapshot read in `getDataNow`),
`js:sqlParse` (the `JSON.parse` of each SQL reply in `host-entry.ts`), `sqlite:decodeTasks` (row to `Task`), `sqlite:afterRead`,
`sqlite:rowVersions`, `store:normalize` (`normalizeTaskForLoad` over all tasks), `store:migrations`, `store:set` and its producer.

| Phase | ms | Note |
| --- | ---: | --- |
| `core:boot` | 322.7 | |
| `js:activate` | 285.1 | the store load |
| — `sqlite:readRows` | 147.0 | 5 pages of 1,000 tasks plus the small tables |
| —— `sql:all` (Kotlin: SQLite steps and the JSON reply) | 98.5 | 20 calls |
| —— `js:sqlParse` (`JSON.parse` in QuickJS) | 42.8 | |
| —— the rest (reply string into QuickJS, paging) | 5.7 | |
| — `store:normalize` | 88.9 | 5,000 × `normalizeTaskForLoad`, about 18 µs per task |
| — `sqlite:decodeTasks` | 29.3 | 5,000 × `mapSqliteTaskRow` |
| — `store:migrations` | 8.1 | |
| — `store:set` | 6.5 | producer 4.1 |
| — `sqlite:rowVersions` | 3.1 | |
| — `sqlite:afterRead` | 0.5 | the count checks |
| `js:verifyActivation` | 21.0 | 10.4 of it is the light row read in Kotlin |
| `js:schema` | 7.0 | |
| `js:inboxWindow` | 5.0 | |
| `js:receipts` | 1.2 | |

**Top two costs:** the SQL read of the 5,000 rows (147 ms: 98.5 ms in Kotlin, 42.8 ms `JSON.parse`), and the load normalizer
(88.9 ms). Row decode (29.3 ms) is third.

## The fix

`SqliteBridge.all` (Kotlin) answers every SQL read from core. For each row it built a `JSONObject` (a hash map of about 50 columns),
then serialized the whole `JSONArray`. The object tree existed only to be turned into text. For each column it also called
`isNull` and then `getColumnType`; in `androidx.sqlite` 2.7.1 `isNull` is itself a native `getColumnType` call (checked in the
bytecode). The new code appends each value to one `StringBuilder` and reads the column type once.

The text stays the same by construction: keys and non-ASCII or escaped strings go through `JSONObject.quote`, real numbers through
`JSONObject.numberToString`, the same calls the tree used. Plain printable ASCII text without `"`, `\` or `/` is written as is, which
is what `quote` returns for it. A repeated column name keeps its first place and its last value, as `JSONObject.put` did.

- **On-device byte check (`proof` build):** every SQL reply was built both ways and compared, over two cold starts per fixture, each
  followed by 25 s of post-start work (widgets, Pomodoro, reminders). 5k: 167 and 61 replies (12.3 and 6.4 MB of JSON); empty: 150 and 50 replies.
  **0 mismatches.** `RETURNING` statements were skipped (running them twice would write twice).
- **Unit test:** `SqliteBridgeRowsTest` pins the exact text for every column type (null, integer above 2^53, real, blob, text with
  quotes, slash, control characters, non-ASCII and U+2028), a repeated column name, and an empty result.
- Kotlin only: RN, desktop and native iOS do not use this bridge.

## A/B (first content, ms)

| Fixture | Arm | Median | p90 | min–max | TTID median |
| --- | --- | ---: | ---: | ---: | ---: |
| large-5000 | control | 578 | 587 | 561–613 | 138 |
| large-5000 | fix | **518** | **529** | 506–551 | 136 |
| empty | control | 227 | 239 | 212–246 | 132 |
| empty | fix | 229 | 255 | 219–267 | 130 |
| empty, repeat batch | control | 231 | 242 | 207–256 | 129 |
| empty, repeat batch | fix | 227 | 263 | 215–275 | 133 |

The 5k gain shows in every round: the slowest `fix` sample (551) is faster than the control median (578).

At empty the medians match (pooled n = 40: 229 and 229), but the `fix` p90 is higher (pooled 260 vs 242). The excess sits in one place:
the first sample of each round, which is the third start after the install. There `fix` has median 255 ms (n = 8) and control 235 ms.
The other 32 samples per arm are 227 vs 228 ms (p90 236 vs 239). This pass did not find the cause. The new log line runs after first
content (logcat order), so it is not on the measured path; at empty a start reads only a few rows. Earlier batches on 11-11 also had
slow first samples, in either arm.

Phases at 5k after the fix (3 traces per arm, median ms):

| Phase | control | fix |
| --- | ---: | ---: |
| `core:boot` | 323.7 | **258.2** |
| `js:activate` | 287.4 | 227.6 |
| `sqlite:readRows` | (147.0 in `diag`) | 90.7 |
| — of it `sql:all` (Kotlin) | (98.5 in `diag`) | 41.9 |
| `store:normalize` | (88.9 in `diag`) | 88.6 |
| `sqlite:decodeTasks` | (29.3 in `diag`) | 29.4 |
| `js:verifyActivation` | 20.9 | 14.8 |

The Kotlin side of the 5k read drops from 98.5 to 41.9 ms. `core:evaluate` and `js:bundleInit` vary between traces (65–93 and
13–24 ms) in both arms.

## Cache-miss start (first start after an install)

`cachemiss.sh`, `fix` build: per sample, uninstall, seed, ART at `verify`, then the first cold start (no bytecode cache, logcat
`outcome=absent`), then one more cold start (cache hit). n = 6 per fixture.

| Fixture | Miss median | min–max | Hit median (same installs) | Miss cost |
| --- | ---: | ---: | ---: | ---: |
| empty | **869** | 858–888 | 232.5 | +637 |
| large-5000 | **1535** | 1498–1558 | 520 | +1015 |

What the miss costs (one Perfetto trace per fixture, `traces/miss/`): `core:evaluate` takes 711 ms (empty) and 680 ms (5k), against
65–93 ms from the cache. That is the bundle parse and compile, about 600 ms, the same at both sizes.

At 5k the miss start also paid a one-time save: `js:activate` took 592 ms instead of about 228, with 28 SQL writes (197 ms) and the
JS that prepares them. The writes run inside the store load. The fixture was written by core under Bun and had never been opened by the app, so
this is most likely the load migrations saving their result (not checked further). An update over a library the app has already opened would not pay this unless the update adds a
migration. The recovery checkpoint (`VACUUM INTO`, 88 ms at 5k) runs on another thread while the bundle is parsed.

## Trace sections kept

Three stay as permanent sections, because together they name 85% of `js:activate` at 5k: `sqlite:readRows` (around the snapshot read
in `SqliteAdapter.getDataNow`), `sqlite:decodeTasks`, and `store:normalize` (in `fetchData`). Each runs once per full load and costs
nothing when no tracer is attached. The others (`js:sqlParse`, `sqlite:afterRead`, `sqlite:rowVersions`, `store:migrations`,
`store:set`) were removed: each is under 10 ms, or `js:sqlParse` can be read as `sqlite:readRows` minus its `sql:all` slices.

## Limits

- One phone. n = 20 per cell for the A/B, 3 traces per arm, n = 6 per cache-miss cell.
- The cache-miss start here follows a fresh seed: it includes the first recovery checkpoint and, at 5k, the one-time migration save
  (see above). An app update over a library the app has already opened pays neither.
- The empty-fixture tail difference (first sample of each round) is not explained.
- The `proof` check covered startup and its background work, not every screen or sync.
- A first start at 5k writes about 15,250 rows to JS (logcat `rows=`): the boot read (5,000), the activation check's light read (5,000),
  and about 5,000 more from post-start reads that this pass did not attribute.

## Next

- **The load normalizer, 88.6 ms at 5k.** `normalizeTaskForLoad` builds a second full copy of every task right after
  `mapSqliteTaskRow` built the first, and `sameShallowRecord` never keeps the first: SQLite rows carry `revBy` and `textDirection` keys
  the copy drops. A fix must keep the output byte-identical for RN, desktop and native iOS (shared core) and needs a frozen-output
  corpus first, as the reminder-plan pass did.
- **`JSON.parse` of the read, about 43 ms.** A different transport (fewer, larger strings, or typed columns) would be a bigger change.
- **The cache-miss start.** About 600 ms of bundle parse after every install or update (empty 869 ms first content). Options to
  measure first: shipping the bytecode cache in the APK (it is keyed on the engine version and bundle hash), or a smaller first bundle.
