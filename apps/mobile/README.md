# Mindwtr Mobile

React Native mobile app for the Mindwtr productivity system.

## Features

### GTD Workflow
- **Inbox Processing** - Guided clarify workflow with 2-minute rule
- **Context Filtering** - Hierarchical contexts (@work/meetings)
- **Dark Mode** - Full dark theme support with system preference
- **Swipe Actions** - Quick task management gestures
- **Smart Tags** - Frequent and recommended context tags
- **Quick Status** - Instant status change via status badge tap
- **Auto-Archive** - Automatically archive completed tasks
- **Android Widget** - Home screen focus/next widget (2x2)
- **AI Assistant (Optional)** - Clarify, break down, and review with BYOK AI
- **Copilot Suggestions** - Context/tag/time hints while typing

### Productivity
- **Global Search** - Search operators (status:, context:, due:<=7d)
- **Saved Searches** - Save and reuse search filters
- **Task Dependencies** - Block tasks until prerequisites complete
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

### 3. Build APK

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

Use this workflow to get repeatable startup numbers and phase-level logs.

### 1. Build a release app with startup markers enabled

```bash
cd apps/mobile
EXPO_PUBLIC_STARTUP_PROFILING=1 npx expo run:android --variant release
```

This enables JS startup markers (`[MindwtrStartup] ...`) while keeping normal builds quiet.
If native Android files already exist, run `npx expo prebuild --clean --platform android` first so config plugins re-apply startup tracing patches.

### 2. Run repeatable startup benchmark loops

From repo root:

```bash
bash apps/mobile/scripts/android_startup_benchmark.sh
```

Useful variants:

```bash
# 15 cold starts
RUNS=15 MODE=cold bash apps/mobile/scripts/android_startup_benchmark.sh

# warm starts (process already cached)
RUNS=15 MODE=warm bash apps/mobile/scripts/android_startup_benchmark.sh

# custom package/activity
PACKAGE=tech.dongdongbh.mindwtr ACTIVITY=.MainActivity bash apps/mobile/scripts/android_startup_benchmark.sh
```

Outputs are written to:

```text
apps/mobile/build/startup-benchmark/<timestamp>-<mode>/
```

Key files:
- `summary.txt`: median/p95/min/max for `ThisTime`/`TotalTime` and startup phase durations.
- `am_start_results.csv`: per-run launch times from `am start -W` plus `launch_state`/`sample_quality`.
- `phase_durations.tsv`: per-phase `durationMs` extracted from startup markers.
- `js_since_start.tsv`: per-phase `sinceJsStartMs` from JS startup markers.
- `run-*.log`: raw filtered logcat per run.
- `run-*-am-start.txt`: raw `am start -W` output per run (use this for missing/timeout samples).

Notes:
- On recent Android versions, `ThisTime` may be omitted; treat `TotalTime` + startup phase markers as primary.
- Runs with `sample_quality` like `missing_total_time_wait_timeout` should be treated as unstable samples, not baseline medians.
- If `LaunchState` is `UNKNOWN (0)` and `TotalTime` is missing, rely on `js.splash_hidden`/`js.app_ready` summaries from `js_since_start.tsv`.
- If `sample_quality` includes `log_quota_dropped`, Android dropped process logs (`LOG_FLOWCTRL`), so missing JS markers are likely a logging artifact. Trust `TotalTime`, and re-run with fewer noisy tags if you need full marker chains.

### 3. Capture Perfetto trace for deep root-cause

While reproducing a slow cold start:

```bash
adb shell perfetto -o /data/misc/perfetto-traces/mindwtr-startup.pftrace -t 12s \
  sched freq idle am wm gfx view binder_driver hal dalvik input res memory
adb pull /data/misc/perfetto-traces/mindwtr-startup.pftrace
```

Then open https://ui.perfetto.dev and correlate `MindwtrStartup` log phases with main-thread blocking, I/O, and GC sections.

## Data Storage

Tasks are stored in AsyncStorage and synced via the shared @mindwtr/core package.

## Project Structure

```
apps/mobile/
├── app/                    # Expo Router pages
│   ├── (tabs)/            # Tab navigation
│   ├── _layout.tsx        # Root layout
│   └── settings.tsx       # Settings page
├── components/            # React components
├── contexts/              # React contexts (theme, language)
├── lib/                   # Utilities
│   ├── storage-adapter.ts # AsyncStorage integration
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

## Data & Sync

### Local Storage
Data is stored in AsyncStorage and automatically synced with the shared Zustand store.

### File Sync
Configure a sync folder in Settings to sync via:
- Dropbox
- Syncthing
- Any folder-based sync service

### WebDAV / Cloud
Mindwtr also supports WebDAV and self-hosted Cloud sync backends. Configure in **Settings → Data & Sync**.

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
