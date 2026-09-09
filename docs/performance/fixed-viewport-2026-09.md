# Fixed-viewport native comparison — September 9, 2026

The previous [property-order comparison](watcher-property-order-2026-09.md)
could not complete its reverse-order batch: the workstation has landscape and
portrait monitors, and new tiled windows could start on either. A passing batch
was not necessarily comparable with the preceding batch.

The opt-in native runner now sets only its own verified Benchmark window to a
1200 x 800 floating viewport with scale factor 2. It uses the copied executable's
PID to resolve the compositor window, not a title or keyboard focus. Global
display settings and other windows are untouched. The requested viewport is
validated in every iteration, and temporary mid-interaction changes invalidate
the sample even if the original size returns. Five helper tests cover bounds,
cross-batch orientation/scale drift, executable ownership, explicit targeting,
and transient resizing.

## Matched A/B/B/A run

The two existing binaries were reused without rebuilding or dependency changes:

- Control (save-baseline equality):
  `980d04546ae9114da4c687f2fd591a88d8780bdc0675916f5dbf0ace3d742cd8`.
- Candidate (shared property-order reuse):
  `dd51ba95b5bb23e8230feca92bcd3869b82366c90978347bfebf469df577a70f`.

Same 10,000-task synthetic fixture, release Tauri/WebKitGTK, save-idle scenario,
1200 x 800 at scale 2, render probe enabled, CPU sampler and diagnostics disabled.
Order: control A, candidate A, candidate B, control B. Each batch has three
measured runs plus an excluded warm-up. No builds or tests overlapped timing;
the host was shared and light Android UI preparation occurred between samples.

| Median, six measured runs per build | Control | Candidate |
|---|---:|---:|
| Enter to observed DOM | 142 ms | 139.5 ms |
| Capture to independent SQLite readback | 1004.3 ms | 927.3 ms |
| Open Settings, including automation | 165.2 ms | 155.3 ms |

All 12 measured captures and all four warm-ups passed exact-once creation,
independent SQLite readback, queue-idle boundaries, reload survival, and viewport
checks. The roughly 7.7% lower readback median is descriptive evidence, not a
statistical release gate. Visibility is essentially unchanged at this sample
size. Readback includes WebDriver dispatch/polling and is not isolated fsync
time. These runs do not establish tail latency, behavior under sync contention,
or macOS/Windows performance.

Sorted Enter-to-DOM samples (ms):

- Control: 104, 122, 138, 146, 155, 162.
- Candidate: 120, 129, 132, 147, 149, 159.

Sorted capture-to-readback samples (ms):

- Control: 967.906, 975.529, 1000.648, 1007.901, 1028.536, 1048.678.
- Candidate: 910.772, 925.209, 925.474, 929.183, 942.801, 991.856.

## Retained evidence

Under `/home/dd/.cache/mindwtr-performance-tmp/native-contention/`:

- `fixed-viewport-probe/desktop-IkKpR0/`: initial candidate smoke, not pooled.
- `fixed-control-a/desktop-y6VrF7/`.
- `fixed-candidate-a/desktop-4A4aou/`.
- `fixed-candidate-b/desktop-tvIRNE/`.
- `fixed-control-b/desktop-xuLTqp/`.

Each directory includes `10000-report.json` and per-run synthetic profiles.
Runner source is `e744235c4` plus the viewport-tooling changes. Binary hashes,
not the runner revision, establish the application builds being compared.
