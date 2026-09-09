# Desktop save-baseline comparison — September 9, 2026

## Change and safety boundary

[Native sampling](performance-native-capture-sampling-2026-09.md) caught stable
fingerprint preparation in the pre-frame path of a 344 ms capture. The desktop
snapshot comparator now first asks core's existing `isDeepJsonEqual` whether two
distinct JSON snapshots are structurally equal. Equal snapshots skip sorted
normalization, serialization, and hashing.

This is a positive-only shortcut. A structural mismatch still goes through the
original stable-fingerprint comparison. In particular, ID-keyed array reorders,
JSON normalization of nonfinite numbers/undefined array entries, and changes to
representation keep their existing behavior. Object identity and undefined-root
handling are unchanged. There is no comparison cache, revision-only shortcut,
field allowlist, or mutation of input objects.

Observed entity IDs, changed originals, queued-write provenance, settings replay,
native CAS/revision arbitration, save scheduling, and durable acknowledgement
remain unchanged. The same helper is used when advancing provenance and rebasing
settings; retaining the fingerprint fallback matters for those callers too.

## Tests and isolated measurement

The initial regression test failed on the old implementation: comparing a small
unchanged cloned snapshot called `JSON.stringify` ten times instead of zero.
It passes after the change. A second deterministic test compares 10,000 cloned
tasks plus one capture with zero serialization calls, retaining every observed
ID and no changed originals. Neither test uses a timing threshold.

A 19-value pairwise matrix compares results with the original fingerprint rule
(361 combinations), including nested property order, missing/undefined/null,
scalar arrays, reordered ID arrays, duplicate IDs, and nonfinite numbers. The
storage baseline/adapter suites pass 45 tests, including concurrent edits,
same-revision conflicts, queue provenance, and settings rebasing. Diagnostic
ledger and sanitizer tests pass; the desktop typecheck, targeted lint, Linux
Benchmark build, and existing core/desktop/mobile performance budgets pass.

`bun scripts/performance/save-baseline.ts` measures the real baseline builder on
the fixed mixed-status 10,000-task fixture after cloning it and appending a task.
One warm-up is excluded. On this host with Bun 1.3.3, seven measured samples had
median **34.03 ms before** and **5.05 ms after** (about 85% less elapsed time).
Both measurements used the dependency set at merged main `9c2b12bfe`; no other
build/test command was running during the recorded comparison. This measures
only in-memory baseline construction, not an end-to-end capture speedup.

## Native follow-up

The candidate Linux executable SHA256 is
`980d04546ae9114da4c687f2fd591a88d8780bdc0675916f5dbf0ace3d742cd8`.
Ten measured captures plus one excluded warm-up at 10,000 tasks passed exact-once
capture, independent SQLite readback, queue-idle boundaries, and reload survival.
All used 2560 x 1393 at ratio 2 and the capture-only JSC sampler/render probe.

Sorted in-page Enter-to-DOM times were 128, 129, 132, 137, 139, 141, 149, 154,
277, and 297 ms. There are still intermittent slow captures; this does not claim
to remove all capture jank. The new build also includes the newer main changes,
so do not present old/new native timing medians as an isolated effect of this fix.

In the 277 ms sample, `buildChangedEntityBaseline` appeared in 11 stacks and
`computeStableValueFingerprint` in one, versus 87 and 78 in the original slow
sample. The structural comparator appeared in seven stacks. These are sampled
call-path counts, not exact milliseconds or a statistical tail comparison.

Remaining sort/stringify stacks lead through the file watcher's `markLocalWrite`
payload preparation. Self-write tracking prevents sync loops; it must remain
correct, including queued payloads and concurrent external writes. That is the
next independent profiling/safety investigation, not part of this change.

Artifacts remain local under
`/home/dd/.cache/mindwtr-performance-tmp/native-contention/`:

- `baseline-equality-jsc/desktop-YHuNJW/10000-report.json`: full ten-run report.
- `baseline-equality-jsc/desktop-YHuNJW/10000-2-BFVlqK/`: 277 ms sampled capture.
- `baseline-equality-jsc/desktop-YHuNJW/10000-6-pGIrIT/`: 297 ms sampled capture.
- `baseline-equality-diagnostics/desktop-jtC0M3/`: separate diagnostic warm-up
  and measured capture; both passed and exported `storage-baseline-equality`
  in their Diagnostics logs. These Settings/IPC-instrumented timings are not
  pooled with the JSC sampling batch.

The runner records checkout `9c2b12bfe` as dirty while this fix was being tested;
the recorded executable hash identifies the actual candidate. Raw stacks refer
to retained release assets `index-BWEy44If.js` and `vendor-CrRaJ_uW.js`.

The release marker `v1.3.0/storage-baseline-equality` proves the positive shortcut
ran, not persistence or a particular latency. See the
[diagnostics ledger](release-notes/diagnostics-ledger.md) for logging conditions.
