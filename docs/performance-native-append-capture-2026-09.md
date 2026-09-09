# Native desktop append-only snapshot saves — September 9, 2026

## Scope

Normal desktop capture still sends a full snapshot through the existing save
queue. The native writer still takes `BEGIN IMMEDIATE`, reloads canonical SQLite
data, performs revision/CAS arbitration, and repairs references before deciding
how to persist the result.

When the result contains the exact existing task sequence followed by unique new
task IDs, and projects, sections, areas, people, and settings are unchanged, it
inserts just the new tasks. Existing tasks and their FTS entries are not rewritten.
The new rows use the existing task column codec with cached statements. Canonical
data is reread and the transaction committed before acknowledgement; recovery JSON
publication keeps its existing post-commit behavior.

This is deliberately not a general differential-save implementation. Changes to
existing tasks, container/settings changes, physical removals, duplicate new IDs,
and representational differences take the full-replacement path. Exact restores
always use that path. Legacy orphan-section markers also force replacement so
sidecar cleanup is not bypassed. An unchanged snapshot without appended tasks is
not optimized here. No sync protocol, schema, JS save scheduling, or UI changed.

The eligibility check is linear in the snapshot size and allocates an ID set.
Large snapshots still incur merge, normalization, serialization and canonical-read
costs; this only removes unnecessary SQL/FTS writes for eligible captures.

## Safety evidence

The initial red test used a SQLite trigger that rejects deletion of an unchanged
task. The old snapshot save failed with `unchanged row rewritten`; the append
path succeeds and both old/new tasks remain searchable.

Differential tests compare the new path against full replacement, including task
fields, parent relationships, orphan tombstones, FTS integrity, and foreign keys.
A second-insert failure rolls back the first inserted row and its FTS entry.
Separate-connection testing preserves a writer that commits after capture's
snapshot was taken, and retrying the same capture after a lost acknowledgement
does not duplicate it. Other cases cover stale revisions, CAS physical deletion,
previously observed IDs removed by restore, duplicate IDs, exact restore, legacy
sidecar cleanup, and a subsequent no-difference save.

`v1.3.0/sqlite-snapshot-append` is emitted to exported Diagnostics once per process
after an eligible transaction commits. Its positive `count` is the number of
retained tasks, not an elapsed-time measurement or proof of recovery JSON success.
It contains no task text, IDs, paths, or credentials.

## Reproducing the isolated native diagnostic

Use the disk-backed workspace and temporary-directory conventions in
[performance baselines](performance-baselines.md). With no competing builds or
tests, run `profile_large_snapshot_save` as an ignored release Rust test, first
with `MINDWTR_SNAPSHOT_APPEND=0` and then `MINDWTR_SNAPSHOT_APPEND=1`. Both runs
use the same test executable, 10,000 synthetic tasks and three additional captures.
The switch exists only in the ignored test; there is no application setting.

Use the v2 save-queue-idle native runner for end-to-end timing. Archive and
hash-check both Benchmark executables, preserve raw reports, and compare matching
fixtures, viewport, runtime, and scenarios. Small batches are descriptive, not
p95 gates or cross-platform claims.

## Local isolated result

With the final test executable, the three 10,000-task snapshot samples had a
median of **1,792 ms** with the append path disabled and **465 ms** enabled
(about 74% less elapsed time). The write/reload phase median fell from 1,442 ms
to 187 ms. All three candidate runs retained the existing 10,000/10,001/10,002
tasks and independent SQLite readers saw the newly committed task counts.
These diagnostic fixtures are inbox-only; they are not the mixed-status UI
fixtures and their timings must not be substituted for end-to-end latency.

Logs are retained locally under
`/home/dd/.cache/mindwtr-performance-tmp/native-contention/`:
`append-profile-final-control.log`, `append-profile-final-candidate.log`, and
`append-final-tests.log`. The full native release library suite passed 662 tests
with two opt-in diagnostics ignored. The existing core/desktop/mobile performance
budgets, schema parity, and nine release-ledger/sanitizer tests passed as well.

## Native UI verification pending

The final Linux Benchmark build succeeded with executable SHA256
`27a01863e331a45c00c90e7f051ef8f0360458ca3810b0dbc8be4e4b5fb6a015`.
Its build log is `append-final-build.log` in the same local artifact directory.
An unrelated CPU-heavy workload remained active on the shared host afterward;
no native UI timing batch was run for this candidate. The isolated 74% result
above is **not** an end-to-end quick-capture speedup claim, and the new Diagnostics
marker has not yet been verified through the native UI.

When the host is idle, run the v2 benchmark against the archived control
`save-idle/desktop-DLA1Tg/10000-1-e7sbcL/mindwtr` (relative to the artifact directory,
SHA256 `52bb573a12d4e2304a9a439ab7de41b51e253086e26d1c2f25eb218378a0b852`), then
the final candidate, with matching conditions. Check the exported Diagnostics
log for a positive `sqlite-snapshot-append` count in the 1,000/10,000-task profiles.
Strict equality intentionally falls back on any existing-row representation
difference; this runtime check matters before claiming real capture improvement.
