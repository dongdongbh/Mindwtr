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

## Native UI verification

The final Linux Benchmark build succeeded with executable SHA256
`27a01863e331a45c00c90e7f051ef8f0360458ca3810b0dbc8be4e4b5fb6a015`.
Its build log is `append-final-build.log` in the same local artifact directory.
After competing build work stopped, the v2 benchmark ran against the archived control
`save-idle/desktop-DLA1Tg/10000-1-e7sbcL/mindwtr` (relative to the artifact directory,
SHA256 `52bb573a12d4e2304a9a439ab7de41b51e253086e26d1c2f25eb218378a0b852`), then
the final candidate, with matching conditions. Both used Linux Wry 0.53.5,
Intel i7-8700, a 2560 x 1393 viewport at ratio 2, and fixture
`mixed-v1-10000-c5d46363f404ddd5`, with sync off and no diagnostic probes.

The run order was control, candidate, candidate, control, with three measured
samples and one excluded warm-up per batch. Pooled 10,000-task results:

| Capture timing | Control median (range) | Candidate median (range) |
| --- | --- | --- |
| Automation-observed task visibility | 187 ms (166–355) | 301 ms (188–428) |
| Capture through independent SQLite readback | 2,532 ms (2,457–3,015) | 1,081 ms (1,042–1,191) |

Durable-readback latency fell about 57% in these six samples per binary. This
includes UI visibility and automation overhead; it is not isolated SQL time.
The visibility median was worse, not better. That remains an open investigation,
not an accepted rendering regression or a UI speedup claim. These small local
batches cannot establish a p95 gate, whole-app speed, or other-platform behavior.

All standard samples passed exact-once capture, independent SQLite readback,
save-queue-idle checks, and reload survival. The candidate also passed all three
measured samples plus warm-up at 0 and 1,000 tasks. Every candidate 1,000/10,000-task
profile in the all-size batch emitted the exported `sqlite-snapshot-append`
Diagnostics marker with the expected positive retained-task count. This confirms
the real native UI reached the optimized path, not merely an isolated Rust test.

Raw reports remain under the local artifact root above:

- `append-ui-control/desktop-8hkhNN/10000-report.json`
- `append-ui-candidate/desktop-Nmv95D/{0,1000,10000}-report.json`
- `append-ui-candidate-repeat/desktop-kJdyvL/10000-report.json`
- `append-ui-control-repeat/desktop-pDE9QT/10000-report.json`

The first opt-in render-probe batch,
`append-render-control/desktop-RL3R8W/10000-report.json`, was correctly invalidated
when the viewport changed mid-batch. Its partial samples must not be pooled into
the standard results or a matched diagnostic comparison.

## Capture visibility follow-up

The runner now offers `NATIVE_RENDER_PROBE=1` to separate in-page Enter-to-DOM
timing from WebDriver dispatch and polling. It does not modify the application
bundle or save scheduling. Its observer adds overhead and its animation-frame
timestamp is not a compositor presentation measurement.

A fresh control/candidate/candidate/control sequence passed with three measured
samples and one excluded warm-up per batch. All four reports matched the runtime,
CPU, OS, device, dataset, build type, viewport, scenario, network, and profiling
metadata; the viewport stayed at 2560 x 1393, ratio 2. Pooled diagnostic results:

| Capture timing | Control median (range) | Candidate median (range) |
| --- | --- | --- |
| In-page Enter to DOM appearance | 140 ms (134–173) | 138 ms (123–158) |
| In-page Enter to animation-frame callback | 140 ms (134–173) | 138 ms (123–158) |
| Automation-observed task visibility | 187 ms (174–217) | 170 ms (160–195) |
| Capture through independent SQLite readback | 2,432 ms (2,368–2,534) | 1,043 ms (981–1,110) |

The earlier large visibility difference did not reproduce in these instrumented
batches. This does not prove that WebDriver caused it or rule out intermittent
application delays; no trace captured the slow path. There is no consistent
rendering regression established here, so no speculative UI change was made.
Do not combine these diagnostic samples with the uninstrumented results above.
The independent durability improvement reproduced, and every diagnostic capture
passed the same exact-once, save-idle, SQLite-readback, and reload checks.

Diagnostic artifacts under the same local root:

- `append-render-control-stable/desktop-9cHXC0/10000-report.json`
- `append-render-candidate-stable/desktop-6HZL7n/10000-report.json`
- `append-render-candidate-repeat/desktop-NNvoXW/10000-report.json`
- `append-render-control-repeat/desktop-Y3Ohfu/10000-report.json`

These reports record checkout revision `1e2cad79a` with a dirty worktree because
the runner probe and result notes were under development. The hash-checked
application executables remained unchanged. Ten runner/probe/save-idle tests
passed, including invalid clock ordering, hidden/nonmatching rows, first-Enter
capture, observer cleanup, and serialized execution inside a browser-like context.

The next rendering investigation should capture a consistently slow in-page
sample before changing React or save scheduling. The current shared-desktop,
six-sample cohorts remain descriptive evidence, not release latency gates.
