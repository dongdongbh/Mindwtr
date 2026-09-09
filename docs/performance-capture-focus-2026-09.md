# Android quick-capture focus experiment

Status: measured focus/frame improvement on one device; not release-ready until
the first-open keyboard visibility observation is resolved.

## Evidence and scope

The saved `captureOpenClose-NpmRBN` batch uses synthetic data on a OnePlus CPH2655
(Android 16). In iteration 1, native modal creation and title-input focus occur in
different over-budget frames. The focus mount command takes 7.74 ms wall time,
including 4.38 ms Running and 3.23 ms Sleeping. Some work is native window/IME IPC,
so this is not evidence of a JavaScript-only bottleneck.

The existing initial-focus path also waits a fixed 120 ms. The candidate uses the
Android modal's `onShow` event instead. It does not change iOS's animated-sheet
timing, the Add another save path, task writes, or the keyboard inset calculation.
Initial focus must remain cancelled after close, More, hiding, unmounting, and
auto-record capture. Repeated native events must not refocus the title.

## Comparison protocol

Use the isolated `tech.dongdongbh.mindwtr.benchmark` release app, not the store app.
Both control and candidate must be built from the same base commit and dependency
installation. The control for this experiment is `9858c113c8f537a3e88d2c2b7842092831398c17`.
Do not compare the candidate to the older saved APK as if focus were the only change.

Follow [the device baseline procedure](performance-baselines.md). Confirm the phone
is idle, the imported fixture is synthetic, sync is disabled, and the inbox count is
unchanged. The prepared fixture is `mixed-v1-1000-cbfcca2e13cf76a5-plus21captures`
(1,021 tasks, 221 Inbox tasks at the previous inspection; recheck before measuring).

1. Install the control APK with `adb install -r`; verify its installed SHA-256.
2. Run `captureOpenClose` in timing mode with the existing runner.
3. Install the candidate without clearing app data. Check keyboard focus, typing,
   More, pickers, back/close, repeated reopening, and record capture manually.
4. Run the candidate, then repeat in reversed order. Aim for at least 30 measured
   interactions per build, keeping warm-ups, compilation mode, sort, refresh rate,
   fixture, keyboard, network, and thermal conditions consistent.
5. Compare per-frame CPU/overrun distributions and the trace's first title
   `topFocus` event relative to the same open-action marker. The latter includes
   automation dispatch; it is not exact touch-to-display latency. UIAutomator's
   idle waits make the whole `benchmark.capture.open` duration unsuitable as
   app response time.

Keep raw traces, metadata, APK hashes, and thermal snapshots in the local artifact
directory, not git. Record completed results here before calling the change an
improvement. If focus becomes less reliable or frame overruns worsen consistently,
do not ship the candidate merely because it removes a timer.

Device testing began with permission on September 9, 2026 (UTC). After the first
control batch was interrupted by another ADB-launched app, permission was renewed
and all four matched batches completed without that interruption.

### Interrupted control run

The `captureOpenClose-zdtyuX` timing batch requested 15 iterations. Its metadata
verified the control APK hash below and runner hash
`b45c3778aaaf81e525731fc507ea8e059c907ffc1e0e77169cb6c48033e46c86`.
Before measurement, the benchmark UI showed synthetic tasks and Sync off.

The runner failed its focused `Task title` assertion and produced no completed
benchmark JSON. Android ActivityTaskManager records show that at 23:15:06.445
device-local time on September 8, a shell-UID command launched
`tech.dongdongbh.mindwtr.dev/.MainActivity` with an Expo development-client intent
while the benchmark was running. At 23:15:17.219, that separate app opened its
`DevLauncherErrorActivity`. The observed timeout screen therefore belonged to the
development app, not the release benchmark.

Retain this failed batch and its two traces under
`/home/dd/.cache/mindwtr-performance-tmp/capture-focus-ab/captureOpenClose-zdtyuX/`.
It is not a valid performance sample or evidence of a capture-focus regression.
This failed run is excluded from the completed comparison below. No focus
assertion was weakened, and no personal app data was changed.

## Completed comparison: September 9, 2026

Order: control A1, candidate B1, candidate B2, control A2. Each batch contains
15 measured interactions plus three compilation warm-ups. All 60 measured
interactions passed focus, close, and unchanged-Inbox assertions. Inbox count was
221 before and after testing. All before/after thermal statuses were 0; battery
temperatures before each batch were 28.9, 29.4, 29.7, and 30.0 degrees Celsius.

Artifacts under `/home/dd/.cache/mindwtr-performance-tmp/capture-focus-ab/`:

| Batch | Directory suffix | Open-marker to focus median | Frame CPU P95 | Frame overrun P95 |
| --- | --- | ---: | ---: | ---: |
| A1 control | `xPPxSJ` | 195.2 ms | 18.14 ms | 7.07 ms |
| B1 candidate | `oTpRq2` | 125.7 ms | 14.20 ms | 1.79 ms |
| B2 candidate | `9kvnFH` | 130.7 ms | 14.31 ms | 3.08 ms |
| A2 control | `CdlGO1` | 192.5 ms | 16.54 ms | 6.80 ms |

Each directory has prefix `captureOpenClose-`. Both builds used runner SHA-256
`b45c3778aaaf81e525731fc507ea8e059c907ffc1e0e77169cb6c48033e46c86`.

Combined control/candidate results:

- Open-marker to first `topFocus` median: **194.8 / 130.5 ms** (64.3 ms shorter).
- Corresponding P95: **222.4 / 157.2 ms**.
- Pooled frame CPU P95: **17.77 / 14.31 ms** (19.5% lower).
- Pooled frame-overrun P95: **7.03 / 2.64 ms**.
- Frames with positive overrun: **15.4% / 7.5%** (816 / 823 frames total).
- Median of per-interaction frame CPU P95: **17.23 / 12.48 ms**.

All 60 traces contained exactly one target-process `topFocus` event overlapping
the runner's `benchmark.capture.open` slice. The analysis uses linear-interpolated
quantiles. Frame samples include both open and close; pooled frames are not
independent interaction samples. The automation marker includes event dispatch,
so this is not exact touch-to-visible-keyboard latency. No claims are made about
other devices, iOS, saving, memory, startup, or the absence of other bottlenecks.

Reproducible local analysis helper:
`/home/dd/.cache/mindwtr-performance-tmp/capture-focus-analyze.cjs`.
Raw per-trace values and aggregate results:
`/home/dd/.cache/mindwtr-performance-tmp/capture-focus-ab-results.jsonl`.

### Manual checks and remaining gate

On the candidate, title text entry (`12345`), More expansion, project-picker
opening, cancellation with Back, closing, and reopening were exercised without
saving. More blurred the title and exposed the options. The Inbox remained 221.
The phone was returned to Home and only the benchmark package was force-stopped.
The candidate APK remains installed in the isolated benchmark package.

**Do not ship on these timings alone:** the first manual candidate open after
reinstallation showed a focused title and cursor but no keyboard. A screenshot
(`capture-focus-manual-open.png`) and input-method dump (`mInputShown=false`,
`mImeWindowVis=0`) confirmed the observation. Subsequent candidate reopening and
a fresh candidate reinstall/launch showed `mInputShown=true`, as did the control
reinstall/launch. This is an unresolved observation, not a proven candidate
regression or proof of reliable keyboard presentation.

The current benchmark asserts input focus, not keyboard visibility. Before merge,
add an explicit visible-IME readiness check and cover first capture after cold
launch as well as warm reopening, then repeat both builds. Do not replace focus
with an extra tap that conceals the original behavior. Date-picker and audio/
auto-record device acceptance were not completed in this pass; unit coverage is
not a substitute for those checks. No microphone recording was made.

## Prepared local artifacts

Both APKs are under `/home/dd/.cache/mindwtr-performance-tmp/`:

- Control: `capture-modal-ready-control.apk`, SHA-256
  `653cbcb2b47a07a2c4aa7af1a2b5010be40f08c0a477c94c363b8d3cc887b846`.
- Candidate: `capture-modal-ready-final.apk`, SHA-256
  `628fbc3eef0e29fae9de5a46e949f8c7d17215ba8aa8fb2ef2d4065c0922e687`.

Both release builds and the mobile typecheck passed. The 57 focused
capture/save/modal/keyboard tests pass, including a late `onShow` after hide
followed by reopening. These checks establish
build and lifecycle behavior, not a device-level latency or jank improvement.
