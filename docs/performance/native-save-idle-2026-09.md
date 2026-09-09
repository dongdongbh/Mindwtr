# Native desktop save-queue boundary — September 9, 2026

## Measurement correction

Canonical UI readiness does not imply that pending saves have finished. The v2
native interaction runner observes the real shared-store and desktop-adapter
queues rather than using an arbitrary settling delay or forcing a flush.

The profiling-only `window.__mindwtrSaveStatus()` hook exposes counts, generations,
and failure flags. It cannot read task content or trigger a save. Queued snapshots,
immediate writes, in-flight writes, retries, and scheduled canonical reconciliation
prevent readiness. Two idle observations with unchanged generations are required;
missing hooks, failure, malformed state, or timeout invalidate the sample.

The contract covers known local save work at a boundary, not future scheduled
work, other processes, all reconciliation reads, or whole-app quiescence. Sync
remains off. `SAVE_QUEUE_MODE=early-session` retains the old scenario for archived
binaries; it is not comparable to the new `idle` scenario as a speedup measurement.

## Local evidence

Binary SHA256:
`52bb573a12d4e2304a9a439ab7de41b51e253086e26d1c2f25eb218378a0b852`.
Built from integration `7ca4478ca` plus this change's application sources.
Reports record a dirty checkout; executable identity is independently checked.

Artifacts, retained locally:
`/home/dd/.cache/mindwtr-performance-tmp/native-contention/save-idle/desktop-DLA1Tg/`.

Linux Tauri/Wry/WebKitGTK, isolated portable profiles and session buses,
`DEVICE_LABEL=lab-linux-native`, `RUNS=3`, `SIZES=0,1000,10000`.
No build or test workload from this task ran during the native batch. Other
desktop activity was not controlled, so these are small descriptive samples.

All nine measured captures and three excluded warm-ups passed queue boundaries,
visible capture, separate-connection SQLite readback, exactly-once content, and
reload survival. Median automation-inclusive milliseconds:

| Tasks before capture | Settings | Capture visible | SQLite readback |
| --- | ---: | ---: | ---: |
| 0 | 183 | 60 | 172 |
| 1,000 | 181 | 137 | 324 |
| 10,000 | 196 | 173 | 2,408 |

The 10,000-task readback samples ranged from 2,382 to 2,427 ms. Initial import
queue waits were 83–271 ms; pre-capture waits were 57–72 ms. These waits include
the required observation interval and WebDriver latency, not only active saving.
They are recorded separately and excluded from interaction timing. Three samples
cannot establish a p95 gate or a general performance improvement.

## Safety and verification

No save scheduling, retries, SQL, revision arbitration, durable acknowledgement,
watcher marking, or sync behavior changed. Observation is O(1), does not subscribe
to the store, and is not used to gate normal application operations. No new
release diagnostic line is needed for this benchmark-only observation hook;
its evidence is the retained runner report, not a field-tester log.

The regression test first failed with the missing observation API. It now proves
that reading queue status does not flush a debounced save and that in-flight and
immediate saves remain visible until completion. Adapter tests cover pending,
failed, and recovered writes. Harness tests reject missing/failed/malformed queues,
generation changes, permanent pending work, and incomplete v2 reports.

Validation: 208 store tests, 36 desktop adapter tests, 69 benchmark-tool tests,
desktop TypeScript, targeted lint, native release build, and the existing
core/desktop/mobile performance-budget command passed.

## Next optimization target

`replace_data_in_transaction` still deletes and reinserts all rows, including
unchanged tasks and their FTS entries. Cached INSERT statements avoid repeated SQL
preparation but do not remove this work. Before changing it, add a differential
test comparing canonical snapshots, revision/CAS outcomes, FKs, tombstones, FTS,
rollback, and exact restore against the current implementation. Then measure with
this same idle-boundary scenario. Do not substitute an incremental task save for
capture blindly: capture can also create containers or change settings/device ID.
