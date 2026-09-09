# Shared serialization property ordering — September 9, 2026

## Finding and boundary

The [save-baseline follow-up](performance-storage-baseline-equality-2026-09.md)
identified synchronous sorting in desktop self-write marking. A test at the
actual watcher controller reproduced 503 sorts for 500 identical task shapes.
The bounded property-order implementation reduces this to fewer than ten.

The shared core serializer retains up to eight property layouts during one
normalization traversal. A layout hit requires identical property counts and
enumeration order. Only field-name arrays are reused: values are always read
fresh, entity arrays retain their original canonical sorting, and no cache
survives the traversal. Shape changes and eviction fall back to sorting.

This applies to desktop and mobile callers of the shared serializer. It does
not change sync bytes, fingerprint algorithms, normalization rules, field
allowlists, revision arbitration, or persistence. Desktop watcher marks remain
immutable strings with the same expiry, deduplication, queue limit, and matching
rules. External-change retries, editing protection, and durable acknowledgements
are unchanged.

Cloning and delaying serialization was considered but rejected: an isolated
10,000-task probe found structured cloning slower than canonical serialization
on this host. Deferral would also require additional snapshot and queue safety
work. The retained change does not defer any work or retain task references.

## Checks and isolated timing

The watcher regression failed before the fix (503 sorts; limit below ten) and
passed afterward. A compatibility oracle reproduces the original serializer
and checks exact bytes across nested records, more than eight layouts, unusual
field names, integer properties, undefined/null/nonfinite numbers, ID-array
reordering, duplicate IDs, and mutations between calls. Inputs remain unchanged.
An additional watcher test confirms mutation isolation even if logging fails.

`bun scripts/performance/watcher-mark.ts` measures the real controller using the
fixed mixed-status 10,000-task fixture with native calls and timers disabled.
One warm-up is excluded. Initial seven-sample medians on this host were
**9.89 ms before** and **8.56 ms after**. The commands ran without concurrent
builds or tests. These short in-memory measurements are exploratory, not a claim
of an equivalent end-to-end UI improvement.

Before samples (ms): 13.399, 8.403, 9.891, 9.795, 10.146, 11.174, 9.722.
After samples (ms): 8.564, 10.616, 10.473, 7.062, 6.608, 6.773, 9.631.

Validation passed: 284 core sync/compatibility/diagnostic tests (one existing
skip), 89 desktop watcher/storage tests, all 15 core/desktop/mobile performance
budget tests, core typecheck, desktop typecheck through the native build, and
targeted core/desktop lint. The optimized Linux Benchmark build passed. Its
existing bundle-size and unused-Rust-code warnings remain.

## Native follow-up and limits

The control executable is the previously validated save-baseline build:
`980d04546ae9114da4c687f2fd591a88d8780bdc0675916f5dbf0ace3d742cd8`.
The candidate includes this property-order change on `552707a59`, with the same
dependency set:
`dd51ba95b5bb23e8230feca92bcd3869b82366c90978347bfebf469df577a70f`.
Only a comment was relocated in production source after building; executable
logic is unchanged. The runner records the dirty checkout and executable hash.

The first matched before/after batches used three measured runs each plus an
excluded warm-up, 10,000 tasks, 2560 x 1393 at ratio 2, save-idle boundaries, and
the in-page capture render probe (no CPU sampler). Enter-to-DOM medians were
**142 ms control / 145 ms candidate**. Capture-to-independent-SQLite-readback
medians were **1008 ms / 935 ms**, including WebDriver overhead. This is too small
a sample to establish an end-to-end speedup; visibility did not improve in this
pair. A second candidate batch passed with Enter-to-DOM samples 139, 129, 146 ms.
All six candidate captures passed exact-once creation, SQLite readback,
save-queue quiescence, and reload survival.

The planned reverse-order control batch failed on its third run with a WebDriver
`element click intercepted` error before capture. The entire batch is excluded.
Its full retry passed, but launched at 1440 x 2513 instead of 2560 x 1393; the
cross-batch viewport assertion rejected pooling those timings. No display
settings were changed to force a match. The A/B/B/A comparison is therefore
**incomplete**, not a clean regression verdict or a p95 claim.

A separate diagnostic warm-up and measured capture both passed and exported
`v1.3.0/watcher-property-order`. Their timings are not pooled with render-probe
runs. No physical Android measurement was made for this fix; mobile coverage is
the shared-core compatibility tests and mobile performance budget suite.

Artifacts under `/home/dd/.cache/mindwtr-performance-tmp/native-contention/`:

- `property-order-control-a/desktop-bIoRYe/`: first matched control.
- `property-order-candidate-a/desktop-7Fj9De/`: first matched candidate.
- `property-order-candidate-b/desktop-zgtr3b/`: second candidate.
- `property-order-control-b/desktop-GWMKMK/`: retained automation failure.
- `property-order-control-b-retry/desktop-LR7f9l/`: passing portrait retry,
  excluded from landscape comparisons.
- `property-order-diagnostics/desktop-B4t7yJ/`: passing diagnostic checks.

Each directory contains `10000-report.json` plus per-run synthetic profiles.

The release marker `v1.3.0/watcher-property-order` records successful desktop
self-write snapshot preparation. It does not prove a cache hit, durable save,
or a particular latency; see the [diagnostics ledger](release-notes/diagnostics-ledger.md).
