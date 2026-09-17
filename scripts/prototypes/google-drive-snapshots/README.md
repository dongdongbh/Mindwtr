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
```

The demo and benchmark are synthetic, in-memory, and require no Google account.
The benchmark measures Bun CPU work only, not native desktop or mobile speed.

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
on import, enumerate unrelated Drive files, or access Mindwtr's local store.

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
TypeScript checks passed. Next gates are incremental discovery/validated caching,
a safe history-retention design, and the production integrations listed below.
The experiment is parked on `feature/google-drive-snapshot-prototype` while
#1234 is blocked on production performance and recovery design. It is not merged
into `main`; no existing backend is replaced.

## Explicit limitations

- No automatic garbage collection: all ancestor files remain necessary.
- Naive full-history reads and repeated validation; no change-feed/cache yet.
- No attachments, encryption transition, real OAuth UI or app backend activation.
- No Android/iOS/macOS app testing or claims about background execution.
- One process can simulate independent writers, but does not prove cross-client
  OAuth visibility, process-crash recovery, or complete Drive listing consistency.
- Snapshot identity and parents are experimental and are not a production format.

The production architecture in ADR 0008/0017 is unchanged. A Drive-specific
protocol needs a separate accepted design and performance/recovery gates before
any app integration. Keep only the validated decision or deliberately replace
this experiment; do not silently ship it as an adapter.
