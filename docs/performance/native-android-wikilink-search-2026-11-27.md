# Native Android `[[` task-link search at 5,000 tasks, 2026-11-27

Task wikilink-search-20261127-108. Follow-up to the editor typing-help task (rc1-gap-editor-20261116-85), which measured
158-183 ms per `[[` search at 5k on the S23 and made the searches run one at a time. Raw files:
`/home/dd/scratch/logs/wikilink-search/` and `/home/dd/scratch/wikilink-search-bench/`.

## Result

**One `[[` search at 5k on the S23: 153.1 → 19.9 ms median, p90 164.0 → 24.3 ms** (Benchmark package, interleaved A/B,
n = 61 and 80 searches). That is under the 50 ms typing budget. The suggestions are the same items in the same order.

## Where the time went

The native editor asks the bundle's `markdownReferences` read on each keystroke after `[[`. The read calls core's
`searchMarkdownReferences` (shared with RN and desktop; native iOS does not call it). On the phone, the core search was 99.7% of the read:
`markdown:references` 153.1 ms inside `core:menuRead` 153.5 ms. The bridge, the labels and the 6-row reply cost about 0.4 ms.

Inside the search, host QuickJS at 5k (same vendored engine, x86-64 `-O2`, query `syn`, median of 9):

| Step | ms |
| --- | ---: |
| Build a candidate object for each live task | 12.1 |
| Score each title (trim, lower case, match) | 8.8 |
| Sort all matches (two `localeCompare` calls per comparison) | 72.3 |

The old code sorted **every** match and then kept the first 6. In the 5k fixture every title contains `syn`, so it sorted all 5,020
rows. QuickJS's `localeCompare` normalizes both strings on each call, so the sort was most of the cost.

## The change

`searchMarkdownReferences` now walks tasks, then projects, once. It keeps only the best `limit` matches in a small sorted list. A new
match is compared with the worst kept one first; most matches stop there. A match that gets in is placed after every kept match
that ties with it, so ties keep their input order, exactly as the old stable sort did. The comparison function is the same code as
before. The search trims each title twice instead of three times. Calls to `localeCompare` at 5k drop from 19,221 to 10,147 in Bun (19,395 in vitest on Node).

`host-markdown-references.ts` now wraps the core search in a `markdown:references` trace section. Both A/B arms carry it.

## Judgment calls

- **No cache.** A per-task search key cache would save only the scoring step (about 9 ms in host QuickJS) and would need
  invalidation on every task write, sync merge and undo. The sort was the cost, and the fix needs no cache. So no cache test was needed.
- **Archived tasks stay in the list.** The search excludes deleted tasks and the edited task only. Archived and done tasks are
  suggested, as before and as in RN; on the 5k fixture the top 6 are archived tasks with a newer `updatedAt`. Changing that is a
  product choice, not a speed fix.
- **Limits.** For a `limit` that is a whole number of 0 or more, `NaN`, a fraction or `Infinity`, the result is the same as before
  (pinned by the corpus). A negative `limit` now returns no items; before, `slice(0, -k)` returned all but the last k. No caller
  passes one (RN 6, Android 6, desktop 8).
- **No log line.** Same results and no fast path with a fallback.

## Same results

`packages/core/src/markdown-reference-search-corpus.test.ts` with `markdown-reference-search-corpus.json` (111 SHA-256 digests),
recorded from the base code (`e064f3f2e`); two recordings were byte-identical. Each digest covers the full result objects with key
order. The corpus:

- three seeded random libraries (40, 300 and 1,200 tasks with 6, 20 and 40 projects): diacritics (precomposed and combining
  `café`, `Ärger`, `Straße`, `İstanbul`, `ǅ`), CJK (`東京`, `タスク`), case, emoji, empty and blank titles, padded titles, equal and
  near-equal `updatedAt`, deleted tasks and projects, excluded tasks and projects;
- 34 queries, each with limits `undefined`, 0, 1, 2, 6, 8, 50, 2.5, `Infinity` and `NaN`, with and without exclusions;
- the 5,000-task performance fixture with 9 queries at limits 6 and 8;
- a tie test: equal titles and times keep their input order, projects before tasks.

A work-count test fails on the old code: at 5k, `localeCompare` must run fewer than 2.1 calls per candidate (old: 19,395 calls,
limit 10,542).

Mutants, each run against the corpus: inserting before ties instead of after failed 3 of 6 tests; keeping one row too many failed 5;
skipping the title trim failed 3; treating `NaN` as no limit failed 3; keeping deleted tasks failed 3. Walking projects before tasks
passed; that is an equivalent mutant, since a task and a project never tie.

An extra old-vs-new check over 30,000 random cases gave 0 differences in host QuickJS and in Bun (`equiv-entry.ts`).

## Setup

- Galaxy S23 `RFCW10JBP0Y`. Benchmark build only (`tech.dongdongbh.mindwtr.nativeclient.dev.benchmark` and its seed twin).
- Base `e064f3f2e` (origin/main). APKs in `/home/dd/scratch/logs/wikilink-search/apks/<tag>/` with `SHA256SUMS`, checked before
  and after the batch:
  - `control`: the base plus the trace section, Benchmark APK `8038a32a…cce6`, `markdown.ts` `fe00b172…bde3`.
  - `cand`: control plus the core change, Benchmark APK `8262d12d…19dd`, `markdown.ts` `62c6f3f1…92f0`.
- Fixture `large-5000` (`/home/dd/.mindwtr-harness/startup/large-5000.db`, sha256 `9cae3bf1…287c`).
- `ab-search.sh` (run through `batch.sh`, holding `gates.lock` and `s23.lock`): 4 rounds, order flipped each round. Each round
  reinstalls the arm, seeds it, grants notifications and runs one first start. Then `search-device.mjs` opens the first task's
  full-screen description and types `[[`, `s`, `y`, `n`, `t`, `h` (1.2 s apart) twice under a Perfetto trace, deleting the text
  between bursts. Each burst checks that the field holds `[[synth`. Samples are every `markdown:references` slice, so they include
  the searches that run while Backspace deletes the query. The faster arm runs more of those, because fewer keystrokes are merged
  into "search again".
- Batch 18:07–18:17, host load 2.5 at the start, thermal status 0, battery 28–31 °C.

## A/B (per search, ms)

| Arm | n | `markdown:references` median | p90 | min–max | `core:menuRead` median | p90 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| control | 61 | 153.1 | 164.0 | 144.1–170.7 | 153.5 | 164.4 |
| cand | 80 | **19.9** | **24.3** | 13.8–28.3 | **20.3** | **24.7** |

Per round, the control median was 151.9–154.2 ms and the candidate median 19.6–20.3 ms.

## Host microbenchmarks

Same 5,000 tasks from `large-5000.db`, mapped and normalized as on load, 20 projects, one excluded task. Median of 9 rounds
(QuickJS) or 41 rounds (Bun), two interleaved runs each, `bench-entry.ts`.

| Runtime | Query | Before | After |
| --- | --- | ---: | ---: |
| QuickJS | `` (just `[[`) | 67–75 ms | 14–15 ms |
| QuickJS | `syn` | 72–80 ms | 19 ms |
| QuickJS | `task 1` | 29–31 ms | 14 ms |
| QuickJS | `zzz` (no match) | 19–21 ms | 11–12 ms |
| Bun 1.4.4 (JSC) | `syn` | 1.8 ms | 1.2 ms |

Desktop (WebKitGTK, WebView2, WKWebView) and RN (Hermes) were not measured. They call the same function; the Bun numbers
suggest about 1 ms or less at 5k on a JIT engine.

## Limits

- One phone, one fixture. All fixture tasks share one `updatedAt` and every title matches, which is the worst case for the old
  sort. A library where few titles match was already faster before (`zzz`, `task 1` rows).
- The time from a keystroke to the card on screen was not measured; the search was about 99.7% of the read.

## Next

- The remaining 20 ms is the walk over 5,000 tasks: scoring each title (trim, lower case) and one or two `localeCompare` calls per
  match. A search key cache would need invalidation on every task write, sync merge and undo; it is not worth it under the budget.
