# Google Drive snapshot experiment (#1234)

**Throwaway prototype, not a supported sync backend.** No app imports this code.
Existing sync providers are unchanged. See also #210 and discussion #1112.

Question: can immutable full `AppData` documents stored in Drive preserve
concurrent/offline writes while reusing Mindwtr's current merge rules, and what
are the discovery/storage/CPU costs?

```sh
bun scripts/prototypes/google-drive-snapshots/demo.ts
bun scripts/prototypes/google-drive-snapshots/demo.ts --smoke
bun test ./scripts/prototypes/google-drive-snapshots/
bun scripts/prototypes/google-drive-snapshots/benchmark.ts
bun scripts/prototypes/google-drive-snapshots/incremental-benchmark.ts
bun scripts/prototypes/google-drive-snapshots/discovery-benchmark.ts
```

The demo and CPU benchmarks are synthetic, in-memory, and require no Google
account. `discovery-benchmark.ts` uses a synthetic feed and a temporary private
SQLite cache beneath `<home>/build-artifacts` (`/home/dd` on the development
machine), removed after execution. None
of these commands measures actual network or native desktop/mobile speed.

## Model

Each immutable file contains one entire document and the IDs of the earlier
snapshots it incorporates. There is no separately updated manifest or head file.
Concurrent branches are retained and merged using existing core rules. Listing
order does not pick the winner. A child must incorporate its named parents;
missing parents, cycles, invalid documents and history limits stop resolution.
An aligned single head produces no new upload.

## Isolated Drive transport

`drive-scratch.ts` is an explicitly opted-in test helper, not general-purpose
storage. It creates at most 16 small files tagged with a fresh private namespace.
It never overwrites files. It searches only that namespace, verifies same-ID
retries against exact uploaded bytes, and deletes only IDs generated and submitted
by that helper after ownership revalidation. It does not load credentials, run
on import, or access Mindwtr's local store. Namespace scans are filtered; the
change feed can include unrelated file metadata, which is ignored without
downloading those files' contents.

The local authenticated runner is intentionally not distributed. Do not insert
tokens or client secrets into these files, commands, issue reports, or fixtures.

## Experiment result (2026-09-17)

**Viable in the tested scenarios; not ready for app integration.** An authenticated
Drive run with seven small synthetic snapshots passed concurrent branch merging,
the existing core conflict winner, a same-ID retry, an offline branch returning,
tombstone preservation, fresh graph recomputation, and an unchanged no-upload
cycle. All seven test files were deleted after exact ownership revalidation;
cleanup reported zero failures. No real task data was read or uploaded.

The complete harness made 69 requests, including ID generation, repeated
verification reads, retry verification, and cleanup. Its cold read/no-op stage
made eight requests and took 2.11 seconds. These are one experiment's timings,
not production sync latency or evidence from separate native clients.

An initial unoptimized Bun CPU baseline with 5,000 synthetic tasks and ten
history files took approximately 9.4 seconds to resolve history and 9.7 seconds
to prepare an unchanged sync, versus 98 milliseconds for one ordinary two-document
merge. The retained history was approximately 13.9 MB. This baseline preceded
the final validator/import and ID-ordering cleanup, and another benchmark briefly
overlapped it; treat it as directional, not a controlled final-code measurement.
It establishes that this naive replay design must not be wired into the apps.

Validation: 23 model/transport tests passed, independent review passed for this
isolated experiment, the terminal smoke demo passed, and targeted strict
TypeScript checks passed. This was the initial baseline; the next section records
the incremental follow-up. Remaining gates include safe history retention/recovery
and the production integrations listed below.
The experiment is parked on `feature/google-drive-snapshot-prototype` while
#1234 is blocked on production performance and recovery design. It is not merged
into `main`; no existing backend is replaced.

## Incremental discovery and caching (step 1)

`incremental.ts` now implements a read-only discovery cycle using Drive's
[change feed](https://developers.google.com/workspace/drive/api/guides/manage-changes).
The first cycle captures a token **before** scanning the namespace, then replays
every change page to cover the listing window. Later cycles read the feed and
fetch only IDs reported as changed, including known IDs whose immutable content
must be rechecked. Unrelated file bodies are never downloaded. Missing history,
permission loss, changed snapshot contents, incomplete pagination, or a malformed
graph fail without acknowledging progress; no snapshot is deleted or overwritten.

The validated snapshots and final cursor are saved together through
`checkpoint-store.ts`, using one SQLite transaction with full synchronous writes
and revision compare-and-swap. A stale competing writer cannot replace a newer
checkpoint even if both have the same cursor. New files are mode `0600`, and the
store requires an owner-private directory. The cache holds synthetic snapshot
data, not credentials; it is not encrypted or wired to an app database.

`createCachedSnapshotResolver` reuses in-memory normalization and parent-coverage
checks only for unchanged, eligible documents. It retains all graph safety
checks and the original merge order. Clock rollback or timezone changes, future revision/lifecycle
timestamps, focused tasks starting after today, and time-dependent repairs take
the uncached path. Ordinary titles, IDs, and future scheduling-only dates do not
disable reuse. Persisted cache data never carries trusted proof flags;
a fresh process validates the complete history again. Losing the cache triggers
a new complete scan; corruption is reported rather than silently reset.

Validation so far: 90 tests passed across the prototype and original capability
probe, including SQLite reopen, competing-writer CAS, injected write failure,
cache-loss rebuild, pagination/window closure, and advancing-clock oracle parity.
A live read-only API smoke made two requests (start token + changes) and received
a final cursor without creating any files. A complete live incremental round trip
and native-device testing are still pending; the older seven-file experiment
does not validate this new path end to end.

### Measured follow-up

Synthetic Bun measurements, 5,000 tasks and ten initial history files:

| Discovery case (real SQLite, synthetic feed) | Elapsed | Snapshot bodies fetched |
|---|---:|---:|
| Initial scan | 8.55 s | 10 |
| Warm unchanged cycle | 0.91 s | 0 |
| One new snapshot | 2.07 s | 1 |
| Reopened cache (eleven files) | 8.77 s | 0 |

Warm time is the median of three advancing-clock cycles; the other discovery
cases are single measurements. All eleven history files were retained. This
includes local JSON loading/validation and SQLite work but **no network latency**.
The narrower resolver benchmark measured 8.79 s uncached versus 0.49 s warm
(three-sample medians); counters confirmed reuse rather than fallback. These
are experimental development-machine timings, not native-device budgets.

Warm discovery improves, but cold/restart replay and growing local history remain
too expensive. Do not call the production performance gate passed. History
retention/recovery remains a separate design task; no age-based deletion was added.

## Explicit limitations

- No automatic garbage collection: all ancestor files remain necessary.
- Cold scan/restart still validates all history. Warm cycles still load and
  serialize cached history locally; caching does not eliminate history growth.
- The cache is capped at 128 snapshots and 64 MiB; the scratch remote transport
  remains capped at 16 files and 1 MiB per upload. Hitting a cap fails closed.
- No safe recovery from missing remote history, no compaction/checkpoint protocol,
  and no interrupted-publication recovery. This step only commits read progress.
- No attachments, encryption transition, real OAuth UI or app backend activation.
- No Android/iOS/macOS app testing or claims about background execution.
- One process can simulate independent writers, but does not prove cross-client
  OAuth visibility, process-crash recovery, or complete Drive listing consistency.
- Snapshot identity and parents are experimental and are not a production format.

The production architecture in ADR 0008/0017 is unchanged. A Drive-specific
protocol needs a separate accepted design and performance/recovery gates before
any app integration. Keep only the validated decision or deliberately replace
this experiment; do not silently ship it as an adapter.
