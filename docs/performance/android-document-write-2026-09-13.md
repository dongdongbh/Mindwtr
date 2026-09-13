# Android document-provider backup writes, September 13, 2026

## Reproduction and cause

The current release Benchmark build reproduced the handoff's direct backup-export
failure twice on the OnePlus CPH2655, Android 16. Selecting the synthetic folder
through Android's Downloads document provider created a zero-byte JSON document,
then opened the share fallback. The original database remained intact and the
fallback contained the full backup; the failure was direct publication to the
chosen provider.

Control source: `e2234c4fa5461de2a1afb4f22e816a1d82b128ea`; source files matched the
archived release APK (`98393836deb44edb5a48692be5eabca7f6ef351b3b6b5a44705aa1e0a47fd8ba`).
The user had authorized the separate Benchmark app and its synthetic data. The
production and Dev apps were not used. Sync was Off. Artifact root:
`/home/dd/.cache/mindwtr-performance-tmp/android-capture-cost-20260913/`.

`export-error.log` was obtained through the app's normal Diagnostics Share log
flow and saved locally with My Files. It reports `ExponentFileSystem.writeAsStringAsync`
rejecting the Downloads `content://…/tree/…/document/…` URI as not writable.
The failed documents at `05-48-40-650Z` and `06-04-27-534Z` are retained in the
Benchmark-owned download folder. No failed run or empty document was overwritten.

The local pinned Expo FileSystem 19.0.21 implementation explains the route:

1. Mindwtr's shared `writeAsStringAsync` first calls `prepareFileTarget`, which
   prepares filesystem parents and calls `ModernPaths.info(uri)`.
2. Android `FileSystemModule.kt` implements that info call with `java.io.File(URI)`.
   It accepts filesystem URIs, so a document-provider `content://` URI fails before
   the modern `File.write` operation can run.
3. The wrapper falls back to the legacy writer. Its `isSAFUri` check only recognizes
   `com.android.externalstorage` authorities, so the Downloads provider receives
   a read-only classification and the write is rejected.

The modern File API already uses ContentResolver streams for document URIs.
The fix skips filesystem parent/path preparation only for `content://` writes and
continues through the existing modern File existence/create/write sequence.
It preserves the exact URI, payload, encoding, native permission enforcement and
legacy fallback on a real modern-write failure. Filesystem-path repair, copy and
move behavior remain unchanged. No native module, dependency, database, sync,
serialization or save-acknowledgement contract changes.

## Regression and diagnostic contract

The regression drives the exported StorageAccessFramework create-and-write path
with a Downloads tree/document URI, a modern info implementation that rejects
non-file URIs, and the observed legacy writer failure. It fails on the old source
and passes with the routing guard. It also checks UTF-8 and Base64 forwarding,
unchanged URI identity, no filesystem-parent preparation or directory repair for
documents, native-write failure propagation, and the existing file-path repair.

The existing successful SAF backup log now carries
`v1.3.0/android-saf-backup-write`; its share fallback does not. The marker proves
the provider write returned successfully, not independent durability or elapsed
latency. The diagnostics ledger records that boundary; no URI, task text or new
sensitive field is logged.

## Device comparison fixture

A nonempty control backup was saved through the existing share fallback, keeping
both the failed empty document and fallback copy. `control-export.json` is
479,156 bytes, SHA-256
`421c5a19b1b05aa78fa034fd44d1f768a51384dbdd40a1e7207a166ecef06812`.
It contains 1,034 live tasks, five task tombstones, 20 projects and no sections,
areas or people. Four tombstones came from the previous session's normal restore
of its test captures. Live status counts are Inbox 234, Next 200, Waiting 200,
Someday 200 and Done 200. Every task title was verified synthetic.

Debug logging was enabled only after capture timing to obtain the error/marker.
The complete control export is the content baseline for this fix, including all
settings and tombstones. Core serialization of that same fixture produced the
local comparison CSV (113,802 bytes) and TaskNotes ZIP (257,302 bytes). Native
validation must compare actual exported data, not merely an on-screen success.

## Validation and restoration

The accepted implementation was validated before publication on
`perf/android-capture-cost-20260913`, based on `e2234c4fa`. That base is published
and passed [CI 34740710185](https://github.com/dongdongbh/Mindwtr/actions/runs/34740710185).
The checks below record local and physical-device validation of the pre-commit
candidate. Consult the source commit and handoff for subsequent CI/publication.

- Red run: three wrapper regressions failed against the old source, including
  both encodings reaching the rejecting legacy writer before modern writing.
- Final focused mobile tests passed 22/22; mobile TypeScript passed. Changed-file
  ESLint passed with five pre-existing warnings and no errors. Release diagnostic
  sanitizer tests passed 2/2, diagnostics-ledger tests passed 7/7, and the diff
  whitespace check passed. Full commands/results are in `write-fix/result.md`.
- Independent Sol review found no blocking issue in the source/tests/ledger.
  The remaining provider-readback boundary was verified on the physical device.
- The arm64 Benchmark release build passed with the same dependencies, startup
  profiling enabled, capture sampling disabled, and native profileability enabled.
  The generated test variant kept version 1.3.0/code 139 so the original test APK
  could be restored without an uninstall; tracked release versioning was unchanged.

Candidate identity (archived in `candidate/manifest.json` with source hashes and diff):

| Artifact | SHA-256 |
|---|---|
| Benchmark APK | `d53588d9fae190882ec9e3e5ca38780a6a7f534d840b35fa080e0fb65f82b9c0` |
| Hermes bundle, also matched inside APK | `c16a87a0c02536453468c36dc18d9a5dee374e48b2be012416c983e1dbe72cdf` |
| Source map | `5a8b718e2c6796fb4b8619466aceaee2d54cea6abb20df05d045fc9a102de36b` |
| Unchanged control runner | `78dc5e76698b5cae5089567fbd15afb7f4c259e0c0943c1cfa038dc4facfe30c` |

Installed candidate/runner hashes matched these archives. The app exported each
format through the same Downloads provider into its owned synthetic folder.
Each returned to Data without opening share fallback. Files were independently
pulled from shared storage and checked against the control-derived reference:

| Export | Bytes | Independent readback |
|---|---:|---|
| JSON | 479,156 | Byte-identical to the complete control backup, including settings and all five tombstones; SHA-256 `421c5a19b1b05aa78fa034fd44d1f768a51384dbdd40a1e7207a166ecef06812`. |
| CSV | 113,802 | Byte-identical to the core-generated reference; 1,034 live rows; SHA-256 `bcecd8a9dddb365fea59b5da0c46e5501cccd18ce453e94eff930fcc5e64729d`. |
| TaskNotes ZIP | 257,302 | Valid CRCs and all 1,034 entry names/payloads identical to the reference. Only per-entry export timestamps differ; APK-written ZIP SHA-256 `b8db06fa60174a75025b00bd3b5c217793c82226a2e6da5d45debc65ad6f42bf`. |

`native-export-validation.json` records these checks. `candidate-export.log`,
saved through normal Share log to local My Files, contains the success marker at
06:16:51.519, 06:17:29.393 and 06:18:00.142 UTC for JSON, CSV and ZIP respectively.
Control share-fallback completions have no marker. Picker time is included between
start/completion logs; those intervals are not export-performance measurements.
This establishes successful readback on this device/provider, not power-loss
durability, all providers, iOS behavior, or a capture speedup.

A temporary local test-runner log receiver was built and briefly installed while
locating the local share destination. It was never selected or used; its source
was removed and the control runner restored before candidate validation. No
timing batch used it. The diagnostic log was saved through My Files instead.
The discarded probe and build record remain in `probe/`; no native helper is part
of the accepted source diff.

Finally, both original test APKs were reinstalled and their installed hashes
matched the initial archives: Benchmark
`3ef80137cd44952a5e4b1943049b1d97b67c63098d86e15e249521731d69061f`, runner
`fab7679a1d7e94859ad037c0aa739c8f88f5dce24c377608db816cc33b819dbe`.
A fresh original-app launch confirmed Inbox 234, Newest sort, Sync Off and debug
logging restored to false. Both packages were then stopped. No task was saved,
imported or restored during this continuation. Screen dimensions/density, animation,
refresh, keyboard, radio and low-power settings matched the initial values;
`environment-end.json` and `after-*.txt` retain the verification. Synthetic failed
and successful exports remain in the owned folder. Production and Dev apps were
untouched.

This investigation is separate from the
[matched capture control and attribution](android-capture-cost-2026-09-13.md),
which made no capture UI optimization or speedup claim.
