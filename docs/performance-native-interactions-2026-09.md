# Native desktop interactions and Android scrolling — 2026-09-09

This round establishes native measurements; it does not claim an application
speedup. Application source was `632ea4496a8491869cd40a9041819449b6eaa503`,
with uncommitted benchmark-tooling changes in a separate worktree. The main
checkout and normal application profiles were not modified.

## Linux desktop

Release Tauri/Wry 0.53.5, Intel i7-8700, Linux 7.1.11-arch1-1, portable synthetic
profiles with sync off. The viewport was 2560 × 1393 CSS pixels, scale factor 2.
Startup marks were enabled; Settings/IPC diagnostic probes were off for the batch.
The shared host was not reserved exclusively, so these are descriptive observations,
not an A/B comparison or release gate.

Executable SHA-256:
`dc8f2c5d410cf757bccfa6323aebaa594bc7ee0927dbefa207e0b998540a4101`.

Ten measured iterations plus one excluded warm-up per fixture:

| Synthetic tasks | Settings median | Integrations median | Capture visible median | SQLite readback median |
|---|---:|---:|---:|---:|
| 0 | 130 ms | 152 ms | 74 ms | 176 ms |
| 1,000 | 241 ms | 78 ms | 144 ms | 404 ms |
| 10,000 | 186 ms | 63 ms | 196 ms | 7,457 ms |

All 30 measured iterations passed exact task-count, captured-content, and reload
checks. Readback uses an independent read-only SQLite connection, not the optimistic
React store or the recovery JSON. Timings include automation overhead. Readback is
checked after visibility and includes the reader's bounded lock wait; it is not a
standalone fsync measurement. No tail latency gate is inferred from ten samples.

The 10,000-task capture readback ranged from 7,128 to 7,892 ms, while visible capture
ranged from 180 to 347 ms. A separate diagnostic warm-up and measured iteration
also reproduced the delay (7,461 and 6,793 ms). Allowlisted IPC tracing observed
`save_data`, not `save_task`; its response-header duration was 2,992 and 2,874 ms.
Those IPC timings exclude later response parsing/callback work and do not account
for the whole capture-to-readback interval.

### Next investigation: capture persistence

Follow-up: [native snapshot statement reuse](performance-native-snapshot-save-2026-09.md)
addresses repeated SQL preparation without changing snapshot semantics.

`createTaskActions.addTask` uses the queued full-snapshot path. Native `save_data`
calls `persist_data_snapshot`, then `merge_json_to_sqlite`, then
`replace_data_in_transaction`. The latter deletes and reinserts the entity tables,
including unchanged tasks. This gives a specific source path to investigate, not
proof that all 7.46 seconds are spent there.

Before optimizing it, separate queue/JavaScript preparation, IPC, SQLite transaction,
and recovery-copy publication costs. Preserve canonical merging, stale-snapshot and
omission guards, foreign-key ordering, FTS consistency, and the durable acknowledgement
boundary. A targeted create or differential snapshot write must pass concurrent
writer and restore tests, not only a throughput test. Do not disable durability or
acknowledge the optimistic UI state as a successful save.

### Benchmark corrections

An early probe clicked Settings before canonical startup completed, producing a
misleading roughly five-second Settings timing. It was discarded. The committed
runner waits for initial canonical interactive readiness before its first refresh,
then waits again before interaction measurements. Otherwise, migration work can
continue behind the refreshed view.

The initial independent SQLite reader also treated transient `SQLITE_BUSY` as a
failure. The runner now gives that reader a bounded five-second busy timeout and
keeps the wait in the observed duration. Failed probes remain in local artifacts;
they are not pooled into the successful batch.

## Android scrolling

OnePlus CPH2655, Android 16, isolated Benchmark package, release/profileable build,
AndroidX Macrobenchmark 1.4.1. Partial compilation used three warm-ups before 15
measured `inboxScroll` iterations. Both installed APK identities matched before
and after measurement.

App SHA-256:
`3ef80137cd44952a5e4b1943049b1d97b67c63098d86e15e249521731d69061f`.

Test APK SHA-256:
`fab7679a1d7e94859ad037c0aa739c8f88f5dce24c377608db816cc33b819dbe`.

The synthetic dataset was labeled `mixed-v1-1000-cbfcca2e13cf76a5-plus34captures`:
the 1,000-task fixture plus captures retained from earlier benchmarks. The synthetic
Inbox was verified on screen, but the exact retained total was not re-exported or
independently hashed during this round. Treat the suffix as an operator label,
not a freshly verified content hash. Sync was off. Network metadata was `online`;
radios were not changed or connectivity independently measured.

Across 3,057 measured frames:

- CPU frame duration: median 4.189 ms, p95 8.606 ms, p99 10.799 ms.
- Frame overrun: median −8.750 ms, p95 −3.189 ms, p99 +0.305 ms.
- 37 frames had positive overrun (1.21%). Frame duration is not input latency.

All 15 iterations passed. Android reported thermal status 0 before and after and
Macrobenchmark reported no thermal-throttle sleep. Battery temperature rose from
30.0°C to 33.5°C; reported CPU temperatures rose substantially. These snapshots
do not establish the absence of throttling throughout the run. The Benchmark app
was stopped afterward; the normal Mindwtr app was untouched.

No before/after Android claim is made. The batch did not measure full sync, merge
CPU on the phone, capture, or memory. Raw Perfetto traces are retained, but their
root-cause analysis has not been completed.

## Evidence and remaining coverage

Local artifact root (not committed):
`/home/dd/.cache/mindwtr-performance-tmp/native-contention/`.

- Desktop batch: `desktop/desktop-mA9Tqo/{0,1000,10000}-report.json`.
- Desktop diagnostic: `desktop/desktop-TT4DIp/10000-report.json`.
- Android metadata, native report, and 15 traces: `mobile/inboxScroll-dhAHXl/`.

The diagnostic run also smoke-tested final process cleanup, sync-off verification,
and report validation. Benchmark-tool tests cover readiness ordering, invalid clocks,
missing samples, invalid identities/counts, and failed capture checks.

Still outstanding: matched before/after capture-save optimization, native large-list
scrolling/editing, typing and navigation during real sync on both platforms, phone
merge attribution, and macOS/Windows native measurements. Portable Linux measurements
cannot substitute for OS keyring or other-platform testing.
