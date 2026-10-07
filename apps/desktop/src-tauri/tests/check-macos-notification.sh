#!/bin/bash
set -euo pipefail

# Run in the dedicated macOS test account. `regression` is synthetic; `test` checks
# real delivery and requires permission. `request` presents the protected prompt.
mode=${1:-regression}
case "$mode" in check|regression|request|test) ;; *) exit 2 ;; esac
source_dir=$(cd "$(dirname "$0")" && pwd)
build_dir=${MINDWTR_NOTIFICATION_TEST_DIR:-"$HOME/worktrees/Mindwtr/notification-bridge-check"}
app="$build_dir/MindwtrNotificationTest.app"
mkdir -p "$app/Contents/MacOS"
cat > "$app/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>tech.dongdongbh.mindwtr.dev</string>
<key>CFBundleExecutable</key><string>NotificationTest</string>
<key>CFBundleName</key><string>MindwtrNotificationTest</string>
<key>CFBundlePackageType</key><string>APPL</string>
</dict></plist>
PLIST
xcrun clang -fobjc-arc -fblocks -Wall -Werror -Wno-deprecated-declarations \
    "$source_dir/macos_notification_bridge.m" -framework AppKit \
    -framework Foundation -framework UserNotifications \
    -o "$app/Contents/MacOS/NotificationTest"
codesign --force --sign - "$app"
if [[ "$mode" == request || "$mode" == test ]]; then
    # LaunchServices supplies the GUI identity required to present macOS permission UI.
    echo "Native result: $build_dir/$mode.log (test must print PASS; request waits for user choice)"
    exec open -n --stdout "$build_dir/$mode.log" --stderr "$build_dir/$mode-error.log" "$app" --args "$mode"
fi
if [[ "$mode" == regression ]]; then
    "$app/Contents/MacOS/NotificationTest" regression
    cp "$app/Contents/MacOS/NotificationTest" "$build_dir/NotificationTest-unbundled"
    exec "$build_dir/NotificationTest-unbundled" unbundled
fi
exec "$app/Contents/MacOS/NotificationTest" "$mode"
