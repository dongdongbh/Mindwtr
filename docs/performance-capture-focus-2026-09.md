# Android quick-capture focus experiment

Status: **unsafe optimization withdrawn; working focus timing restored**. The
rebuilt recovery passes 20 cold/warm keyboard checks. Retain the new native
correctness gate; do not claim the rejected candidate's timing gains.

## Evidence and scope

The saved `captureOpenClose-NpmRBN` batch uses synthetic data on a OnePlus CPH2655
(Android 16). In iteration 1, native modal creation and title-input focus occur in
different over-budget frames. The focus mount command takes 7.74 ms wall time,
including 4.38 ms Running and 3.23 ms Sleeping. Some work is native window/IME IPC,
so this is not evidence of a JavaScript-only bottleneck.

The existing initial-focus path waits a fixed 120 ms. The rejected candidate used
the Android modal's `onShow` event instead. It did not change iOS's animated-sheet
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
The control APK was restored in the isolated benchmark package after the
keyboard-readiness comparison below.

**Do not ship on these timings alone:** the first manual candidate open after
reinstallation showed a focused title and cursor but no keyboard. A screenshot
(`capture-focus-manual-open.png`) and input-method dump (`mInputShown=false`,
`mImeWindowVis=0`) confirmed the observation. Subsequent candidate reopening and
a fresh candidate reinstall/launch showed `mInputShown=true`, as did the control
reinstall/launch. This initially intermittent observation was subsequently
reproduced by the cold-launch correctness gate below.

The current benchmark asserts input focus, not keyboard visibility. Before merge,
run the separate visible-IME readiness check described below against both builds.
It covers first capture after cold launch as well as warm reopening. Do not replace focus
with an extra tap that conceals the original behavior. Date-picker and audio/
auto-record device acceptance were not completed in this pass; unit coverage is
not a substitute for those checks. No microphone recording was made.

### Keyboard readiness correctness gate

`CaptureKeyboardReadinessTest#coldAndWarmCapture` runs in the existing isolated
native test APK. It is separate from Macrobenchmark timing: its polling and
correctness checks are not latency measurements. Each cycle force-stops only the
benchmark app, opens capture once after cold launch and once after closing it,
and requires a focused title plus an on-screen input-method window. It also
requires no keyboard before each open, preventing a stale visible-window result
from passing the test, and checks that cancellation leaves the Inbox unchanged.

The window predicate uses Android's
[UiAutomation interactive-window API](https://developer.android.com/reference/android/app/UiAutomation#getWindows()),
not a particular keyboard's package, text labels, or inferred screen-height
change. The instrumentation service's original flags are restored afterward.
The test does not tap the title, type, save, or change keyboard settings.

Build/install only `:macrobenchmark:assembleRelease` using the baseline recipe.
After confirming the phone is idle, the fixture is synthetic, and sync is off,
invoke the test on the explicit device (substitute the installed control or
candidate hash and a fresh output directory):

```bash
adb -s <serial> shell am instrument -w -r \
  -e class tech.dongdongbh.mindwtr.macrobenchmark.CaptureKeyboardReadinessTest#coldAndWarmCapture \
  -e syntheticDataConfirmed true \
  -e datasetId mixed-v1-1000-cbfcca2e13cf76a5-plus21captures \
  -e expectedApkSha256 <installed-apk-sha256> \
  -e iterations 10 \
  -e additionalTestOutputDir /sdcard/Android/media/tech.dongdongbh.mindwtr.macrobenchmark/<unique-run> \
  tech.dongdongbh.mindwtr.macrobenchmark/androidx.test.runner.AndroidJUnitRunner
```

The test verifies the actual installed target APK hash and rejects debuggable
targets before driving UI. Retain `keyboard-readiness.json` (20 successful
samples for 10 cycles), instrumentation output, runner APK hash, and any failure
screenshot/hierarchy. A nonempty JSON alone is not success: require test output
`OK (1 test)`, status `passed`, and the full requested cold/warm sample count.
If another app interrupts the test, no screenshot or hierarchy of it is saved.

### Keyboard readiness results: September 9, 2026

The runner APK used for all three runs had SHA-256
`b1f4a0c82b82fda7242c79755e1918aa45ffafe1b914c40386f4106d912b8112`.
The test verified each installed target APK against its expected hash. The
fixture and device were unchanged from the timing comparison.

| Order | Build / local artifact directory | Result |
| --- | --- | --- |
| 1 | Candidate / `keyboard-candidate-20260909-1` | Failed first cold capture, 0 completed samples |
| 2 | Control / `keyboard-control-20260909-1` | Passed 10 cold + 10 warm captures, `OK (1 test)` |
| 3 | Candidate / `keyboard-candidate-20260909-2` | Failed first cold capture again, 0 completed samples |

Artifacts and matching `.log` files are under
`/home/dd/.cache/mindwtr-performance-tmp/`. Both failures report
`Focused title has no visible keyboard: cold-0`; the screenshots show the capture
sheet with no keyboard and Android reports `mInputShown=false`, `mImeWindowVis=0`.
The repeat requested only one cold/warm cycle and reproduced the same failure in
12.7 seconds. The control completed all 20 checks in 105.6 seconds. The focused
field assertion alone would have passed in both failed runs.

This establishes a regression in the candidate under the matched test conditions.
Keep commit `072f4de31` off main without the restoration below. A replacement must pass the same
unweakened cold/warm keyboard gate before timing comparisons are accepted. Retain
this test even if the focus experiment is withdrawn.

No production-app data, keyboard settings, or permissions were changed. The
control build was restored to the benchmark package; the phone was returned to
Home. Date-picker/audio acceptance remains deferred because this candidate failed
the earlier readiness gate.

### Diagnosis and recovery

A third immediate-focus run (`keyboard-candidate-diagnosis.log`) reproduced the
failure. The scoped Android input-method log (`keyboard-candidate-ime.log`) records
the show request failing at `PHASE_CLIENT_VIEW_SERVED`, followed by
`Ignoring showSoftInput() ... is not served`. The focus request reaches the input
before Android is ready to serve its input connection. Modal `onShow` is therefore
not a sufficient keyboard-readiness signal in this path.

A bounded follow-up moved focus to the next animation frame and added cancellation
tests. Those tests were red before the change, then all 65 targeted tests passed.
However, its release APK (`capture-modal-frame.apk`, SHA-256
`f5ebf130613f8ea461973c19e9a0ef70396039d105afd808ccf756cd3f0dc6a7`) failed the
unchanged device gate at `cold-1`, after one successful cold/warm pair. Evidence is
in `keyboard-frame-20260909-1/` and its matching `.log`. A frame delay is also not
a reliable readiness signal, so that variant was discarded rather than tuning
additional delays or weakening the test.

The final fix removes the modal-show/frame machinery and restores the previously
working 120 ms initial-focus path. Native modal props and iOS behavior return to
the control implementation. Unit regressions cover Android/iOS timing and
cancellation before the delay fires (close, More, auto-record transition, hide,
and unmount). The native cold/warm test remains as the end-to-end regression gate.

Validation of the restored source:

- 60 targeted capture/modal/keyboard tests passed; mobile typecheck passed.
- Scoped ESLint completed with zero errors and two existing warnings.
- A fresh release build passed. `capture-focus-restored.apk` is byte-for-byte
  identical to the original control (SHA-256 `653cbcb2...887b846` above).
- `keyboard-restored-20260909-1/keyboard-readiness.json` reports `passed`, exactly
  10 cold and 10 warm captures; instrumentation reports `OK (1 test)` in 108.8 s.
- Final Inbox count remains 221. The phone was returned to Home with only the
  benchmark package force-stopped. Personal app data was untouched.

The regression is removed by withdrawing the unsafe optimization, not by claiming
the input-connection race is universally solved with a timer. Any future attempt
to reduce that delay needs a reliable native readiness mechanism and must pass
this gate before its performance results count.

## Automatic acceptance gate and rendering follow-up

The host interaction runner now runs `CaptureKeyboardReadinessTest` automatically
before **either capture scenario, in both metric modes**. It requires ten cold/warm
pairs, successful instrumentation and a complete report matching the installed APK
and declared fixture. Failed/missing/duplicate samples block measurement; failure
evidence is retained. This is separate from timed iterations and does not alter the
restored 120 ms focus behavior. See [the runner protocol](performance-baselines.md#native-interaction-runner).

The complete CLI flow passed on the connected CPH2655 with the restored control
APK and runner `b1f4a0c82b82fda7242c79755e1918aa45ffafe1b914c40386f4106d912b8112`.
Readiness produced 20 passing samples in 108.4 seconds; only then did the normal
compilation warm-ups and one timing iteration run. Metadata reports both readiness
and measurement `passed`, with native JSON and a Perfetto trace retained under
`/home/dd/.cache/mindwtr-performance-tmp/capture-preflight-smoke/captureOpenClose-SmnWtz/`.
This is a harness smoke test using the previously verified APK, not a fresh main
build or a statistically meaningful performance comparison. Cancellation left
Inbox unchanged, and the phone returned to Home. No production package was used.

A bounded re-examination of control batch `captureOpenClose-xPPxSJ`, iteration 0
(`2026-09-09-04-24-51.perfetto-trace`), separated wall time from scheduled CPU:

| Target main-thread frame | Wall time | Running | Sleeping | Runnable |
| --- | ---: | ---: | ---: | ---: |
| Opening, slice 2932 | 19.864 ms | 11.068 ms | 8.508 ms | 0.288 ms |
| Closing, slice 24471 | 14.453 ms | 6.549 ms | 7.717 ms | 0.187 ms |

Opening includes 5.819 ms creating the native modal host, a 2.417 ms mount batch
(1.051 ms updating 52 layout instructions), and 1.928 ms drawing. The opening
window-relayout Binder call takes 2.945 ms; its system-server reply takes 2.894 ms,
including surface creation/placement and focus updates. Closing removes 52 views
in a 10.717 ms slice, including 1.080 ms accessibility-connection removal and
4.567 ms window removal. The latter's 4.502 ms system-server reply includes
surface placement, focus updates, and 0.327 ms monitor contention. Nested slice
durations overlap; they must not be added as independent costs.

These observations point to native window lifecycle work as a candidate for a
future controlled experiment, not a reason to broadly memoize components or change
focus timing. This uninstrumented trace does not expose React render durations;
Hermes/React attribution needs a separately sampled build. Global inspection also
found background system waits and a concurrent ART GC, but does not establish
either as the cause of these two frames. An incomplete initial thread-state record
was bounded by the next recorded state rather than extended across the whole trace.
This is a bounded diagnosis, not an exhaustive system audit or a new speedup claim.

No runtime UI change was made from this follow-up. A window-lifecycle experiment
must preserve modal accessibility, dismissal, keyboard resizing, pickers, recording,
and failed-save behavior, then pass the readiness gate before matched A/B timing.

## Prepared local artifacts

Both APKs are under `/home/dd/.cache/mindwtr-performance-tmp/`:

- Control: `capture-modal-ready-control.apk`, SHA-256
  `653cbcb2b47a07a2c4aa7af1a2b5010be40f08c0a477c94c363b8d3cc887b846`.
- Candidate: `capture-modal-ready-final.apk`, SHA-256
  `628fbc3eef0e29fae9de5a46e949f8c7d17215ba8aa8fb2ef2d4065c0922e687`.

The original release builds and unit checks passed but did not catch the native
keyboard regression. The recovery build and its separate device results above
are the current acceptance evidence; historical performance results remain only
for comparison with rejected experiments.
