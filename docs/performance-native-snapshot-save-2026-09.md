# Native snapshot statement reuse — 2026-09-09

Follow-up to the [native interaction baseline](performance-native-interactions-2026-09.md).
At 10,000 tasks, capture became visible in 196 ms but independent SQLite readback
took 7.46 seconds median. This change addresses one measured part of that delay,
not the entire save pipeline.

## Isolated native result

An opt-in Rust diagnostic runs the actual snapshot read, merge, replacement, and
commit path against a new disk-backed SQLite database with 10,000 synthetic tasks.
The first pre-change run took 2,607 ms: 228 ms reading, 162 ms merging, 2,132 ms
replacing, and 85 ms committing. Initial writer-lock acquisition took 0.01 ms.

`replace_data_in_transaction` compiled each INSERT again for every row. It now
uses the connection's prepared-statement cache for the six repeated INSERTs.
All SQL text, parameter binding, insertion order, FK/FTS triggers, revision
arbitration, and transaction boundaries are unchanged. This is not a differential
snapshot implementation: unchanged entities are still deleted and reinserted.

Three subsequent runs per mode, without overlapping builds:

| Mode | Total save median | Replacement median |
|---|---:|---:|
| Statement cache disabled | 2,461 ms | 2,118 ms |
| Statement cache enabled | 1,901 ms | 1,514 ms |

The median isolated transaction was about 23% faster. The disabled-cache control
uses the same test executable and forces preparation on each call. These are
three-run diagnostic observations on the shared Linux host, not a release gate.
The experimental one-second budget still fails after this change; do not treat
that target as achieved or relax a CI budget to make it pass.

Reproduce from `apps/desktop/src-tauri`, with `TMPDIR` set to a disk-backed scratch
directory on this machine:

```bash
MINDWTR_SNAPSHOT_CACHE=0 cargo test --release --lib profile_large_snapshot_save -- --ignored --nocapture
cargo test --release --lib profile_large_snapshot_save -- --ignored --nocapture
```

The ignored test is opt-in and prints lock/read/merge/replacement/commit intervals.
`MINDWTR_SNAPSHOT_BUDGET_MS` optionally makes an explicitly chosen local diagnostic
budget fail. Normal tests never enforce elapsed-time thresholds here.

## Safety checks

The cached/uncached differential test compares canonical data after repeated
replacement with populated and absent optional values. It checks foreign keys,
FTS checklist/project content, rollback after an injected mid-insert failure, and
successful reuse after the failure and a trigger-schema change. The complete
storage test module also covers concurrent writers, stale snapshots, revision
arbitration, physical omissions/restores, recovery JSON publication, and migrations.
The full release-mode native library suite passed: 657 tests, zero failures,
two explicitly ignored diagnostics/manual cases. The release-marker ledger and
sanitizer checks also passed.

The release diagnostic `v1.3.0/sqlite-snapshot-statements` is emitted once per
process after a normal snapshot commit. It contains only the canonical task count
and the fixed marker. It does not acknowledge JSON publication or claim a speedup.

Local artifacts are under
`/home/dd/.cache/mindwtr-performance-tmp/native-contention/`:
`native-cache-disabled.log` and `native-cache-enabled.log` retain the isolated
measurements. Raw databases, binaries, and diagnostic artifacts are not committed.

A temporary diagnostic build also separated JavaScript preparation from native
invoke. In its measured 10,000-task capture, baseline preparation took 90 ms and
self-write preparation took 46 ms; invoke ran from 2,244 to 4,705 ms on the same
WebView clock. This diagnostic sample is not pooled with ordinary timing runs.
The phase probes were removed before the final release build. Evidence:
`cache-diagnostic/desktop-ZAYu16/10000-report.json` (diagnostic executable
`8a1f5c047cebbf3f05d8b153af520d8ef410044cd0c639ac2f9ad274a84eb77f`).

The final app log also confirms a normal save with the original fixture's task
count before capture. Canonical readiness is not save-queue quiescence: this
runner observes early-session capture and can include startup-scheduled saves.
Do not attribute the whole UI-to-readback difference to the single isolated
transaction or present it as steady-state capture latency. Explicit queue-idle
measurement and differential snapshot writes remain separate follow-ups.

## Final native app checks

The final release executable, with all temporary probes removed, has SHA-256
`b58906bd3a0052a7d389f44351d2f3746bb1d435118a859f72201394d106cce9`.
Three measured iterations plus one warm-up passed at each fixture size:

| Tasks | Settings median | Capture visible median | SQLite readback median |
|---|---:|---:|---:|
| 0 | 122 ms | 64 ms | 167 ms |
| 1,000 | 165 ms | 124 ms | 358 ms |
| 10,000 | 208 ms | 205 ms | 2,555 ms |

All nine measured captures were persisted exactly once and survived reload. The
release marker was verified in the actual exported app-log file. The test driver
and isolated application processes were stopped after the runs.

The archived original executable (`dc8f2c5d410cf757bccfa6323aebaa594bc7ee0927dbefa207e0b998540a4101`)
was rerun with the same harness and 10,000-task fixture before the final candidate.
Its three measured readbacks ranged from 7,159 to 7,753 ms, median 7,710 ms; the
candidate ranged from 2,528 to 2,696 ms, median 2,555 ms. Both used Linux/Wry 0.53.5,
the same 2560 × 1393 viewport at scale factor 2, sync off, and fresh portable
profiles. Builds and tests did not overlap either timing batch. The host was not
reserved exclusively, sample counts are small, and these early-session observations
do not establish a release gate or explain every millisecond of the difference.

Final artifacts: `cache-final/desktop-kKQrZv/{0,1000,10000}-report.json`.
Fresh original control: `cache-control/desktop-ADiYVn/10000-report.json`.
Validation logs: `native-cache-full-tests.log` and `native-cache-perf-tools-tests.log`
(657 native tests and 65 benchmark-tool tests passed).
The existing `bun run test:perf` budgets passed across core, desktop, and mobile;
output is retained in `native-cache-perf-budgets.log`. No budgets were changed.
