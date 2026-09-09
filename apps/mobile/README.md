# Mindwtr Mobile

React Native mobile app for the Mindwtr productivity system.

## Features

### GTD Workflow
- **Inbox Processing** - Guided clarify workflow with 2-minute rule
- **Context Filtering** - Slash-delimited contexts with parent matching (@work/meetings)
- **Dark Mode** - Full dark theme support with system preference
- **Swipe Actions** - Quick task management gestures
- **Smart Tags** - Frequent and recommended context tags
- **Quick Status** - Instant status change via status badge tap
- **Auto-Archive** - Automatically archive completed tasks
- **Android Widget** - Home screen focus/next widget (adaptive, 2x2 default)
- **iOS Widget** - Home screen focus/next widget with quick capture
- **Apple Watch Companion** - Audio and text capture, Focus task actions, and linked Pomodoro controls; included starting with the next stable iOS release
- **iOS Quick Actions** - Long-press app icon shortcuts for Add task, Focus, Calendar
- **AI Assistant (Optional)** - Clarify, break down, and review with BYOK AI
- **Copilot Suggestions** - Context/tag/time hints while typing

### Productivity
- **Global Search** - Search operators (status:, context:, due:<=7d)
- **Saved Searches** - Save and reuse search filters
- **Sequential Projects** - Only the first unfinished task is offered as the next action
- **Markdown Notes** - Rich text descriptions
- **Attachments** - Files, images, and links on tasks
- **Reusable Lists** - Duplicate tasks or reset checklists
- **Task View/Edit** - Swipe between Task and View modes
- **Checklist Mode** - Fast list-style checking for checklist tasks
- **Share Sheet** - Capture from any app

### Notifications
- **Due Date Reminders** - Push notifications with snooze
- **Daily Digest** - Morning briefing + evening review prompts
- **Weekly Review** - Reminder to start your weekly review

### Screens
| Screen        | Description                        |
| ------------- | ---------------------------------- |
| Inbox         | Capture and process incoming items |
| Next Actions  | Context-filtered actionable tasks  |
| Agenda        | Daily focus and upcoming tasks     |
| Projects      | Multi-step outcomes                |
| Menu          | Board, Review, Calendar, Settings  |
| Contexts      | Hierarchical filtering (menu)      |
| Waiting For   | Delegated items (menu)             |
| Someday/Maybe | Deferred ideas (menu)              |
| Board         | Kanban drag-and-drop (menu)        |
| Calendar      | Tasks + external events (menu)     |
| Review        | Daily + weekly review (menu)       |
| Settings      | Theme, sync, notifications         |

## Tech Stack

- React Native + Expo SDK 54
- TypeScript
- Zustand (shared with desktop via @mindwtr/core)
- Expo Router (file-based navigation)

## Quick Start

```bash
# From monorepo root
bun install

# Start Expo dev server
bun mobile:start

# Run on Android
bun mobile:android

# Run on iOS
bun mobile:ios
```

## Prerequisites

- Node.js
- Bun package manager
- Expo Go app (for device testing) OR
- Android Studio (for emulator) OR
- Xcode (for iOS Simulator)

## Building APK Locally

To build an Android APK locally (without using Expo cloud builds):

### 1. Install Java JDK

```bash
# Arch Linux
sudo pacman -S jdk17-openjdk

# Set JAVA_HOME (add to ~/.zshrc for persistence)
export JAVA_HOME=/usr/lib/jvm/java-17-openjdk
```

### 2. Install Android SDK

```bash
# Create SDK directory
mkdir -p ~/Android/Sdk/cmdline-tools

# Download and extract command-line tools
cd /tmp
wget https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip
unzip commandlinetools-linux-*.zip
mv cmdline-tools ~/Android/Sdk/cmdline-tools/latest

# Set environment variables (add to ~/.zshrc or ~/.bashrc)
export ANDROID_HOME=~/Android/Sdk
export PATH="$PATH:$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools"

# Reload shell
source ~/.zshrc

# Accept licenses and install components
yes | sdkmanager --licenses
sdkmanager "platform-tools" "platforms;android-36" "build-tools;36.0.0" "ndk;27.1.12297006"
```

### 3. Build APK

See "Build (ABI-split APKs)" under Android Environment below for the build commands.

## iOS Builds (EAS)

To build and submit the iOS app via EAS:

```bash
eas build --profile production --platform ios
eas submit --platform ios
```

## Android Environment

> **IMPORTANT**: You must only use `ANDROID_HOME`. Do NOT set `ANDROID_SDK_ROOT` - it is deprecated and causes conflicts.

Add to your `~/.zshrc` or `~/.bashrc`:

```bash
# Android SDK (ONLY use ANDROID_HOME, not ANDROID_SDK_ROOT)
export ANDROID_HOME=$HOME/Android/Sdk
export PATH=$PATH:$ANDROID_HOME/emulator
export PATH=$PATH:$ANDROID_HOME/platform-tools
export PATH=$PATH:$ANDROID_HOME/cmdline-tools/latest/bin
```

### Build (ABI-split APKs)
Mindwtr builds **split APKs per ABI** (arm64-v8a, armeabi-v7a, x86, x86_64) so the arm64 file stays under store size limits like F-Droid/Izzy.

If you already have `apps/mobile/android` on disk, run prebuild so the ABI split config is applied:

```bash
npx expo prebuild --clean --platform android
```

Then build locally (recommended):

```bash
ARCHS=arm64-v8a bash ./scripts/android_build.sh
```

After the build, grab the APKs from:

```
apps/mobile/build/
```

For IzzyOnDroid, upload the versioned arm64 build:

```
mindwtr-<version>-arm64-v8a.apk
```

The build script may also write the raw Gradle output (e.g. `app-arm64-v8a-release.apk`), but you only need the `mindwtr-<version>-arm64-v8a.apk` file for releases.

To change which ABIs are built by default, edit the `architectures` list for `./plugins/abi-splits` in `apps/mobile/app.json`.

### 4. Upload to GitHub Release

After building, upload the APK to GitHub releases using `gh` CLI:

```bash
# Upload to existing release
gh release upload vX.Y.Z build/mindwtr-<version>-arm64-v8a.apk --clobber

# Or create new release with APK
gh release create vX.Y.Z build/mindwtr-<version>-arm64-v8a.apk --title "vX.Y.Z" --notes "Release notes here"

# View releases
gh release list
```

## Running on Device

### Expo Go (Recommended)
1. Install Expo Go on your phone
2. Run `bun mobile:start`
3. Scan QR code with camera (iOS) or Expo Go (Android)

### Development build (Mindwtr Dev)

`expo start` only runs Metro; it never installs anything. A development build is the app itself compiled with `expo-dev-client`, and with the store's package id it would replace the Mindwtr you use and share its data. Build it as the separate **Mindwtr Dev** app instead:

```bash
bun mobile:android:dev     # phone on ADB or a running emulator
bun mobile:ios:dev
```

That sets `APP_VARIANT=development`, which gives the build the name "Mindwtr Dev" and the ids `tech.dongdongbh.mindwtr.dev`, so both apps sit on the phone with their own data. The script runs `expo prebuild --clean` first because a native tree generated for one variant is not rebuilt by `expo run` on its own; run the same clean prebuild (without the variant) before the next store-id build. Afterwards, plain `bun mobile:start` is enough for TypeScript changes: open Mindwtr Dev, it connects to Metro and the "No apps connected" line goes away. Rebuild the dev app only after native changes (dependencies, config plugins, permissions, `app.json`).

Both variants register the `mindwtr://` scheme, so Android asks once which app should open a link. On iOS the dev app shares the widget App Group and the CloudKit container with the store app; it uses CloudKit's Development environment, so iCloud data stays separate, but the two apps overwrite each other's widget payload.

### Android Emulator

#### Option A: Android Studio (Recommended for Emulator)

1. **Install Android Studio:**
   ```bash
   # Arch Linux
   sudo pacman -S android-studio
   # Or use snap:
   sudo snap install android-studio --classic
   ```

2. **Install SDK via Android Studio:**
   - Open Android Studio → Tools → SDK Manager
   - Install: Android SDK Platform, Build-Tools, Emulator

3. **Create Virtual Device:**
   - Tools → Device Manager → Create Device
   - Pick a phone (e.g., Pixel 6) → Select system image (e.g., Android 13)
   - Finish

4. **Run:**
   ```bash
   # List available emulators
   emulator -list-avds

   # Start emulator
   emulator -avd Pixel_API_34 &

   # Run app
   bun mobile:android
   ```

#### Option B: Command-line Only (Already Covered Above)

Use the SDK you installed in the "Building APK Locally" section.

## Android Startup Profiling

Use a separate, profileable **release** build, never an Expo development client for timing baselines.

### 1. Build a release app with startup markers enabled

```bash
cd apps/mobile
export APP_VARIANT=benchmark EXPO_PUBLIC_STARTUP_PROFILING=1 ANDROID_PROFILEABLE=1
bunx expo prebuild --platform android --no-install
bunx expo run:android --variant release
```

Use an isolated checkout when generating native projects. This installs `Mindwtr Benchmark`
(`tech.dongdongbh.mindwtr.benchmark`) beside the store app with separate Android storage.
The EAS equivalent is `eas build --platform android --profile benchmark`. The benchmark
variant is Android-only; do not use it for iOS, where extension App Groups are shared.
Seed synthetic data through the normal import UI, dismiss onboarding, leave Focus/Inbox/Projects
open, and keep sync off. Never import personal data or configure a real sync account.

### 2. Run repeatable startup benchmark loops

From repo root:

```bash
export DATASET_ID=mixed-v1-1000 DEVICE_LABEL=lab-phone NETWORK=offline
RUNS=30 MODE=cold bun run mobile:startup:bench
```

Useful variants:

```bash
# Foreground resume (HOME then launch, not a warm Activity recreation)
RUNS=30 MODE=hot bun run mobile:startup:bench

# Tail comparisons need more observations, on the same quiet device
RUNS=100 MODE=cold WAIT_MS=8000 bun run mobile:startup:bench
```

Outputs are written to:

```text
apps/mobile/build/startup-benchmark/<timestamp>-<mode>/
```

Key files:

- `report.json`: valid-only metric summaries, invalid count, build/device/dataset identity; use this for comparisons.
- `metadata.json`: actual installed APK fingerprint and declared fixture/network/device identity.
- `summary.txt`: raw diagnostic summaries, including invalid runs; not a baseline.
- `am_start_results.csv`: per-run launch times from `am start -W` plus `launch_state`/`sample_quality`.
- `phase_durations.tsv`: per-phase `durationMs` extracted from startup markers.
- `js_since_start.tsv`: per-phase `sinceJsStartMs` from JS startup markers.
- `run-*.log`: raw filtered logcat per run.
- `run-*-am-start.txt`: raw `am start -W` output per run (use this for missing/timeout samples).

Notes:

- Cold readiness requires `js.interactive_ready`; hot resume requires `js.resume_ready`.
  Splash hiding is not proof that canonical data or a screen is ready.
- `MODE=warm` presses BACK to finish the Activity. Modern launchers may background it
  instead; only an observed `LaunchState: WARM` qualifies. A HOT/UNKNOWN result fails,
  rather than silently mixing startup types. Use native Macrobenchmark for controlled
  Activity-recreation experiments when this shell method cannot produce warm starts.
- Crashes, missing metrics/readiness, unexpected launch states, or dropped logs fail the
  command. Investigate failures; do not remove slow or failed runs to improve a median.
- `WAIT_MS` is the bounded post-launch marker window (minimum 1000 ms). Increase it for
  slow devices; use the same window for A/B comparisons. It is not part of the metric.
- The script never clears global logcat or app data. Driving a non-benchmark package
  requires explicit `ALLOW_EXISTING_APP=1`; the recommended workflow never needs it.
- Set `ANDROID_SERIAL` when multiple devices are attached. `BUILD_REVISION` is a declared
  source revision; `artifactHash` fingerprints the installed APK(s) independently.
- See [Performance baselines](../../docs/performance/baselines.md) for exact clock
  semantics, fixture generation, comparisons, and the native-device profiling checklist.

### 3. Capture Perfetto trace for deep root-cause

While reproducing a slow cold start:

```bash
adb shell perfetto -o /data/misc/perfetto-traces/mindwtr-startup.pftrace -t 12s \
  sched freq idle am wm gfx view binder_driver hal dalvik input res memory
adb pull /data/misc/perfetto-traces/mindwtr-startup.pftrace
```

Then open https://ui.perfetto.dev and correlate `MindwtrStartup` log phases with main-thread blocking, I/O, and GC sections.

## Data Storage

Tasks are stored in SQLite via `@op-engineering/op-sqlite` and synced via the shared @mindwtr/core package. AsyncStorage remains only as the legacy-JSON migration source and a marker. See [`docs/ARCHITECTURE.md`](../../docs/ARCHITECTURE.md).

## Project Structure

```
apps/mobile/
├── app/                    # Expo Router pages
│   ├── (drawer)/           # Drawer navigation
│   │   └── (tabs)/         # Tab navigation, includes settings.tsx
│   ├── _layout.tsx         # Root layout
│   └── capture-modal.tsx   # Quick-capture modal
├── components/            # React components
├── contexts/              # React contexts (theme, language)
├── lib/                   # Utilities
│   ├── storage-adapter.ts # SQLite storage adapter
│   └── storage-file.ts    # File operations for sync
├── global.css             # NativeWind entry CSS
├── tailwind.config.js     # Tailwind configuration
├── metro.config.js        # Metro bundler config
├── babel.config.js        # Babel config with NativeWind
└── nativewind-env.d.ts    # TypeScript declarations
```

## NativeWind (Tailwind CSS)

The mobile app uses NativeWind v4 for Tailwind CSS styling.

### Configuration Files

| File                  | Purpose                               |
| --------------------- | ------------------------------------- |
| `tailwind.config.js`  | Tailwind theme and NativeWind preset  |
| `global.css`          | Tailwind directives entry point       |
| `babel.config.js`     | NativeWind babel preset               |
| `metro.config.js`     | CSS processing with `withNativeWind`  |
| `nativewind-env.d.ts` | TypeScript types for `className` prop |

## Sync and Data

### Local Storage
Data is stored in SQLite and automatically synced with the shared Zustand store.

### File Sync
Configure a sync folder in Settings to sync via:
- Dropbox
- Syncthing
- Any folder-based sync service

For frequent multi-device edits, WebDAV is recommended over folder sync tools.
If you use Syncthing, prefer `Send & Receive` + `Watch for Changes`, keep scan intervals short, and run **Sync** before switching devices.

### WebDAV / Cloud
Mindwtr also supports WebDAV and Cloud sync backends in **Settings → Sync**:
- `Self-hosted` (existing `/data` endpoint + token)
- `Dropbox` OAuth (App Folder)

#### Dropbox OAuth setup
1. Create a Dropbox app with **Scoped access** + **App folder**.
2. Enable scopes: `files.content.read`, `files.content.write`, `files.metadata.read`.
3. Add redirect URI: `mindwtr://redirect`.
4. Set env var before starting Expo:
   - `DROPBOX_APP_KEY=<your-dropbox-app-key>`
5. Restart app and connect in **Settings → Sync → Cloud → Dropbox**.
6. Use a development/release build for OAuth. Expo Go is not supported for Dropbox OAuth redirects.

Dropbox backend syncs:
- `/Apps/Mindwtr/data.json`
- `/Apps/Mindwtr/attachments/*` (file attachments)

## Troubleshooting

### Metro Cache Issues

```bash
# Clear cache and restart
bun start --clear

# Or manually clear
rm -rf .expo node_modules/.cache
```

### NativeWind Not Working

1. Ensure `global.css` is imported in `app/_layout.tsx`
2. Check `babel.config.js` has NativeWind preset
3. Restart Metro with cache clear

### Build Errors

```bash
# Reinstall dependencies
cd /path/to/Mindwtr
rm -rf node_modules apps/mobile/node_modules
bun install
```

## Resources

- [Expo Documentation](https://docs.expo.dev/)
- [NativeWind Documentation](https://www.nativewind.dev/)
- [Tailwind CSS](https://tailwindcss.com/)
- [React Native](https://reactnative.dev/)
