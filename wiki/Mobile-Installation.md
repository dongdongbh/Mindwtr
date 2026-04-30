# Mobile Installation

Detailed installation instructions for Android and iOS.

---

## Android

### Google Play (Recommended)

Mindwtr is available on Google Play:
https://play.google.com/store/apps/details?id=tech.dongdongbh.mindwtr

### Download APK (Alternative)

1. Go to [GitHub Releases](https://github.com/dongdongbh/Mindwtr/releases)
2. Download the latest arm64 APK (e.g., `mindwtr-0.4.3-arm64-v8a.apk` or `app-arm64-v8a-release.apk`)
3. Open the APK on your device

> **Note:** Releases include ABI-split APKs. Most modern Android devices are **arm64-v8a**.

### Install from Unknown Sources

If prompted, enable installation from unknown sources:

1. Go to **Settings → Security** (or **Settings → Apps → Special access**)
2. Enable **Install unknown apps** for your browser or file manager
3. Return to the APK and install

### Verify Installation

After installation:
1. Open Mindwtr from your app drawer
2. Grant any requested permissions
3. Start capturing tasks!

---

## iOS

### Current Status

iOS is now available on the App Store:
https://apps.apple.com/app/mindwtr/id6758597144

TestFlight beta is also available:
https://testflight.apple.com/join/7SMJCTSR

### Options

1. **App Store (Recommended)** — Install the stable release
2. **TestFlight** — Install the latest iOS beta build
3. **Simulator builds** — Available in the source code for development
4. **Self-build** — Build and sign the app yourself with Xcode (Apple Developer account required for device signing)

However, maintaining the iOS version on the App Store requires a substantial annual fee (see the Apple Developer Program), which I currently cover out of pocket.

To ensure Mindwtr's continued existence and future development, your support is greatly appreciated! If you find value in the app, please consider supporting the project via GitHub Sponsors or Ko-fi.

### Building for iOS (Developers)

```bash
# Clone repo
git clone https://github.com/dongdongbh/Mindwtr.git
cd Mindwtr

# Install dependencies
bun install

# Run on iOS Simulator
bun mobile:ios

# Or open in Xcode for device builds
cd apps/mobile
npx expo prebuild --platform ios
open ios/*.xcworkspace
```

---

## Data Location

Mobile data is stored in app-internal storage with SQLite as the primary store, plus JSON backup/sync data.

---

## Updating

### Android

1. Download the new APK from [Releases](https://github.com/dongdongbh/Mindwtr/releases)
2. Install over the existing app
3. Your data is preserved

> **Tip:** In the app, go to **Settings → About → Check for Updates** to see if a new version is available.

---

## Uninstalling

### Android

1. Long-press the Mindwtr icon
2. Select **Uninstall** or drag to the trash

### Data Cleanup

Uninstalling removes all local data. If you want to preserve your data:
1. Export a backup first (**Settings → Data → Export Backup**)
2. Save the exported file
3. Uninstall the app

---

## Troubleshooting

### App Crashes on Startup

Try clearing app data:
1. Go to **Settings → Apps → Mindwtr**
2. Tap **Storage → Clear Data**
3. Reopen the app

> **Note:** This will delete all local data. Restore from sync or backup.

### Sync Not Working

See [[Data and Sync]] for sync troubleshooting.

### APK Won't Install

- Ensure you have enough storage space
- Enable installation from unknown sources
- Try downloading the APK again (may have been corrupted)

---

## See Also

- [[Getting Started]]
- [[User Guide Mobile]]
- [[Data and Sync]]
