# Android foldable and window-resize validation (#1192)

This work covers the Android portion of #1192. iOS and physical Samsung device
confirmation remain separate. Emulator form factors are not Galaxy hardware.

## Compatibility baseline

- Expo SDK 54, React Native 0.81.5, Expo Router 6; Hermes and the new architecture.
- Android minimum API 24; the local native build resolves compile/target API 36.
- The existing manifest plugin enables resizable activities and `fullUser`
  orientation. It does not require a developer force-resize override.
- AndroidX WindowManager supplies window-relative fold bounds, orientation,
  separation, occlusion, and flat/half-opened state through an optional local
  Expo module. No manufacturer/model lookup or hinge-angle inference is used.
- Window dimensions and fold bounds are logical dp. A nonseparating flat crease
  is not an occluding hinge. Ordinary phones and runtimes without the module
  retain the window-size fallback.
- React Native stops its React surface when an activity is destroyed. Handling
  configuration changes in the manifest alone does not establish restoration
  of drafts, navigation, or scroll state after activity recreation.
- Recovery uses bounded process-memory snapshots after a verified configuration
  teardown. It does not write unfinished text into task data or sync settings.
  Process death or a JavaScript-runtime reload cannot restore these snapshots;
  the existing saved-route and focus-timer behavior still applies.

## Ergonomic behavior

- Narrow or short windows keep bottom navigation. Roomy Android windows use
  64 dp rail targets grouped toward the bottom on the logical start edge.
- The menu opens near its navigation trigger and stays inside an unobstructed
  pane. Quick capture is anchored near the rail on wide screens; its close
  and Android Save controls have 48 dp targets. Full-height rails include the
  reported navigation-bar inset, including the expanded three-button taskbar.
  Android Back dismisses an open menu before navigating the underlying screen.
- Compact tabletop actions prefer the lower pane. If the keyboard leaves too
  little room there, they use the larger unobstructed pane. Editor content is
  scrollable and Save/Close remain outside the hinge.
- Breakpoint changes preserve the navigator tree. Verified same-process
  recreation restores active title/description focus and selection with bounded
  retries. A submitted capture is never restored as a new editable copy while
  its write may still succeed; a late failure waits for a newer capture to close
  before being offered again in the same workspace.

## Reproducible local setup

Keep AVDs, build products, and temporary build space under `/home/dd`. The SDK
used for these checks is `/home/dd/Android/Sdk`; override both `ANDROID_HOME`
and `ANDROID_SDK_ROOT` because the shell profile can point to a different SDK.

The Android Emulator 36.3.10 profiles created for this issue are:

| AVD | Profile | Image | Default display |
| --- | --- | --- | --- |
| `Mindwtr_Fold_1192` | Generic 7.6-inch fold-in with outer display | API 36 Google APIs x86_64, revision 7 | 1768 × 2208, 420 dpi |
| `Mindwtr_Flip_1192` | Generic 6.7-inch horizontal fold-in | Same | 1080 × 2636, 480 dpi |
| `Mindwtr_PixelFold_1192` | Pixel 9 Pro Fold | Same | 2076 × 2152 inner, 1080 × 2424 cover, 390 dpi |
| `Mindwtr_Tablet_1192` | Pixel Tablet | API 35 Google Play tablet x86_64 | 2560 × 1600, 320 dpi |

Launch with `-no-snapshot`; use an explicit ADB serial with multiple emulators.
The profiles report CLOSED (1), HALF_OPENED (2), and OPENED (3).
Use the emulator's `sensor set hinge-angle0` command to exercise actual reported
postures. `wm size` alone exercises resized windows, not fold awareness.
The Pixel profile's `emu fold` / `emu unfold` switches physical displays; the
generic book profile did not switch its app window to a smaller cover display.
Unlock the Pixel cover screen when the emulator's system policy locks it.

Build the separate `tech.dongdongbh.mindwtr.dev` application with
`APP_VARIANT=development`, a clean Expo prebuild, and a fresh Metro process with
`--clear`. After installation, force-stop and launch the app anew. Verify a
visible current-code marker before trusting screenshots. Use synthetic tasks
and no configured sync backend.

Use a bundled `assembleRelease` build of that separate development package for
activity-recreation checks. Expo Dev Client can restart its development UI or
React runtime when the activity changes; that is not production recovery
evidence. A font-scale change triggers activity recreation because `fontScale`
is not suppressed in the manifest. Confirm the process remains alive and check
the `android-activity-session-recovery` diagnostic together with the restored UI.

The API 36 generic clamshell profile reports `HALF_OPENED` through
`dumpsys device_state`, but its WindowManager snapshot contains no folding
features. This exercises the safe window-size fallback; it cannot establish
native horizontal-hinge detection on a Galaxy Z Flip. The generic book profile
does return an occluding, separating feature, including while the IME is open.

The final minified bundled release build passed in 50 seconds. It uses the
separate development package, local debug signing, and the x86_64 emulator ABI;
it is not a store or physical ARM-device artifact. Build log:
`/home/dd/.cache/mindwtr-1192/release-build-closure.log`.
APK: `apps/mobile/android/app/build/outputs/apk/release/app-release.apk`.
SHA-256: `c857d73421e23d2f6cba2aaf69668ccb821d682dac089df989da8cb6c80738c2`.
This exact APK installed and launched successfully on the Pixel Fold emulator;
`closure-final-apk.png` records the final expanded Inbox and reachable rail.

## Runtime matrix

The results and evidence paths below are filled after running the built app.
An install, successful build, or unit test is not a runtime pass.

| Scenario | Result |
| --- | --- |
| Fold cover → inner → cover; portrait and landscape | Pixel Fold release build retained the unfinished task title across repeated physical display changes. Generic Fold editor also survived portrait/landscape rotation. |
| Fold book and tabletop posture; foreground controls avoid active hinge | Generic Fold native separating feature kept the editor and Save/Close controls in one pane, including with IME. Horizontal rail correction additionally covered by geometry/component tests. |
| Flip open and partial fold; short window with IME | Clamshell fallback passed capture/rotation/save. Gboard used its normal landscape extract UI; returning to portrait exposed the intact capture and Save. Native clamshell hinge remains unverified. |
| Projects → task editor; unfinished title/notes and keyboard during resize | Unsaved title and Edit tab survived rotation, fold and genuine recreation. Pixel Fold retained title focus with its keyboard visible after font-scale recreation; typing without retapping appended at the recovered caret. Notes/selection also have component coverage. |
| Quick Capture; unfinished text, resize, save once | Flip synthetic capture survived rotation and saved one task (Inbox 2 → 3). Generic tabletop capture moved above the hinge when its keyboard opened, kept its exact title and focus across genuine recreation in PID 3845, and saved one task (Inbox 2 → 3). Deferred text/audio success/failure and recording-file ownership have regression tests. |
| Inbox, Focus, Review, search, Settings and active timer | Screens opened successfully. Running Pomodoro remained active with decreasing time across release-build recreation; paused after test. Search popup draft recovery is not claimed. |
| Activity recreation, selection, draft, scroll and navigation recovery | Release font-scale changes produced destroy/create events with the same PID; project, selected task, draft and navigation restored. Scroll restoration has component coverage. Diagnostic marker observed. |
| Split-screen divider resize | Pixel Fold paired with Android Settings through system Recents. Dragging the real divider resized the task editor, retained the draft, and kept Save reachable; saved once. |
| Large fonts/display scale, RTL, reduced motion, TalkBack | Font scales 1.2 and 1.5 and disabled system animations exercised. At 1.5, Pixel Fold switched to bottom navigation and Pixel Tablet retained a wider rail. RTL geometry tested automatically; forcing RTL did not mirror this emulator runtime, so no runtime RTL pass. TalkBack traversal and display-density changes remain manual checks. |
| Gesture and three-button navigation, system bars and cutouts | Both modes exercised on Pixel Fold. The final rail Menu target ends at y=1976 before its three-button taskbar starts at y=2015; tablet Menu ends at y=1504 before its system bar at y=1536. Menus open near their triggers above those bars. OEM cutouts remain hardware validation. |
| Ordinary phone, tablet and older-API fallback | API 35 Pixel Tablet launched the release app, showed expanded navigation, and saved one synthetic capture (Inbox 2 → 3). Generic Flip exercised narrow phone geometry. Minimum API 24 runtime was not available. |
| Galaxy Z Fold/Z Flip hardware and Samsung pop-up windows | Not available locally |

Evidence is local under `/home/dd/.cache/mindwtr-1192`:

- `fold-draft-ime.png`, `fold-book-editor.png`, `fold-tabletop-editor.png`:
  native hinge avoidance in the development build.
- `release-draft-before-recreate.png`, `release-draft-after-recreate.png`,
  `release-timer-after-recreation.png`: bundled release recreation checks.
- `pixelfold-split-live.png`, `pixelfold-split-resized.png`: actual split-screen
  divider movement with the same unfinished task.
- `release-lifecycle-events.log`, `release-diagnostics.log`: Android lifecycle
  and `v1.3.0/android-activity-session-recovery` proof. Logs contain synthetic
  local data only; sync was not configured.
- `verified-focus-before.png`, `verified-focus-after.png`: exact unfinished
  title and visible IME retained across Activity replacement in PID 7051.
- `verified-cover-draft.png`, `verified-inner-draft-return.png`: the same draft,
  including text entered at the restored caret, across physical display changes.
  Cover locking is controlled by Android; keyboard focus after unlocking is not
  claimed as preserved.
- `verified-emulator-5556-menu.png`, `verified-emulator-5558-menu.png`: bottom
  rail/menu placement clear of the system bars on Pixel Fold and Pixel Tablet.
- `verified-tabletop-keyboard.png`, `verified-tabletop-capture-recreated.png`:
  capture controls above the horizontal hinge with the actual keyboard open.
- `verified-tabletop-inbox.png`: the recovered capture saved exactly once.
- `complete-cover-tabs.png`, `complete-cover-menu.png`: reachable bottom tabs
  and menu on the physical cover display.
- `complete-menu-open.png`, `complete-menu-back-dismissed.png`: Android Back
  closes the menu while keeping the underlying Inbox screen.
- `verified-runtime-diagnostics.log`: native folding-feature count and
  `compact-tabletop` layout, plus successful activity navigation recovery.

Pixel Fold screenshots require an explicit physical display ID from
`dumpsys SurfaceFlinger --display-id` passed to `screencap -d`. Earlier generic
`screencap` captures from that AVD are not used as visual evidence.

## Automated checks

- Final full-suite run after all review fixes: **268 files / 2,725 tests passed**
  with one worker and the emulators stopped (534.42 seconds). Log:
  `/home/dd/.cache/mindwtr-1192/mobile-final-suite.log`. No timeout or performance
  budget was relaxed.
- The full mobile Vitest run exercised 268 files / 2,693 tests. Under concurrent
  native compilation and two running emulators, 2,687 passed; two tests timed
  out and four exceeded performance budgets. All three affected files passed
  when rerun with one test worker: 60 tests, including the real WebDAV client,
  storage fallback, and 5,000-task interaction budgets. No timeout or budget
  was relaxed. Logs: `mobile-suite.log` and `mobile-rerun.log` in the local
  evidence directory `/home/dd/.cache/mindwtr-1192`.
- Focused bridge/manifest tests verify optional-native behavior, historical
  activity lookup, and configuration merging. They are JavaScript tests; the
  Android module currently has no Kotlin unit-test suite.
- The new geometry/state tests cover absent native support, flat versus
  separating folds, IME-shortened windows, RTL, large text, and activity-session
  draft restoration. Emulator results remain separate from these simulated
  component tests.
- The final audio/quick-capture regression run passed 66 tests across two files,
  including pre-write teardown, delayed success/failure, pending-file ownership,
  multiple failed captures, and source cleanup after transcription. Focus
  restoration passed 48 tests across two files; native wrapper/manifest checks
  passed 14 tests. These are overlapping focused runs, not additive totals.
- Mobile TypeScript and scoped ESLint passed (zero errors; an existing test
  warning remains). The release-diagnostics checks passed all nine tests.
  Public mobile documentation passed `bun run check` in `mindwtr-web`, including
  documentation parity and production builds. No publication was performed.

Physical Galaxy testing must record the actual model, One UI/Android version,
postures, and cover-screen continuation setting. Respect the system's return-to-
cover policy. Dedicated mini cover-screen applications are outside this issue.

## Platform references

- [Android window size classes](https://developer.android.com/develop/ui/compose/layouts/adaptive/use-window-size-classes)
- [Android fold awareness](https://developer.android.com/develop/adaptive-apps/guides/foldables/make-your-app-fold-aware)
- [Samsung app continuity](https://developer.samsung.com/galaxy-z/app-continuity.html)

The native references inform the React Native adapter; they do not imply that
Compose APIs are available directly in JavaScript.
