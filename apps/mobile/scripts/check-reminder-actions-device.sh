#!/usr/bin/env bash
# Run from apps/mobile after a development-variant Android prebuild.
# Only the disposable Mindwtr Dev app is installed/modified. No production data is touched.
set -euo pipefail
cd "$(dirname "$0")/.."
export JAVA_HOME="${JAVA_HOME:-/usr/lib/jvm/default}"
export ANDROID_HOME="${ANDROID_HOME:-/opt/android-sdk}"
export ANDROID_SDK_ROOT="$ANDROID_HOME"
export TMPDIR="${TMPDIR:-$HOME/.cache/mindwtr-reminder-check}"
mkdir -p "$TMPDIR"
ADB="${ADB:-/opt/android-sdk/platform-tools/adb}"
SERIAL="${ANDROID_SERIAL:-RFCW10JBP0Y}"
PKG=tech.dongdongbh.mindwtr.dev
python3 - <<'PYCODE'
from pathlib import Path
p = Path('android/app/build.gradle')
s = p.read_text()
assert "applicationId 'tech.dongdongbh.mindwtr.dev'" in s, 'Development prebuild required'
if 'reminder-device-check runner' not in s:
    s += "\n// reminder-device-check runner (generated test harness only)\nandroid { useLibrary 'android.test.runner'; useLibrary 'android.test.base'; defaultConfig { testInstrumentationRunner 'android.test.InstrumentationTestRunner' } }\n"
p.write_text(s)
Path('android/app/src/androidTest/java/com/emekalites/react/alarm/notification').mkdir(parents=True, exist_ok=True)
Path('android/app/src/androidTest/java/com/emekalites/react/alarm/notification/ReminderActionsDeviceTest.java').write_text(Path('scripts/ReminderActionsDeviceTest.java').read_text())
PYCODE
(cd android && ./gradlew :app:assembleDebug :app:assembleDebugAndroidTest -PreactNativeArchitectures=arm64-v8a --max-workers=2)
"$ADB" -s "$SERIAL" install -r android/app/build/outputs/apk/debug/app-debug.apk
"$ADB" -s "$SERIAL" install -r android/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk
"$ADB" -s "$SERIAL" shell pm grant "$PKG" android.permission.POST_NOTIFICATIONS
run_test() {
    "$ADB" -s "$SERIAL" shell am force-stop "$PKG"
    output=$("$ADB" -s "$SERIAL" shell am instrument -w -r -e class "com.emekalites.react.alarm.notification.ReminderActionsDeviceTest#$1" "$PKG.test/android.test.InstrumentationTestRunner")
    printf '%s\n' "$output"
    [[ "$output" == *'OK (1 test)'* ]] || exit 1
}
run_test testNotificationActions
run_test testSeedDurableQueue
run_test testReplayDurableQueue
