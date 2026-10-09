#!/usr/bin/env bash
set -euo pipefail

repo="$(cd "$(dirname "$0")/../../.." && pwd)"
app="$repo/apps/ios-native"
export TMPDIR="$app/.build/tmp"
mkdir -p "$TMPDIR"
cd "$repo"
node apps/ios-native/scripts/build-bundle.mjs
node apps/ios-native/scripts/build-bundle.mjs --crypto-test
node apps/ios-native/scripts/build-bundle.mjs --attachment-upload-test
node apps/ios-native/scripts/check-task-date-codec.mjs
swiftc -parse-as-library "$app/App/NativeCalendarEventEditor.swift" \
  "$app/Tests/AppLifecycle/CalendarEventEditorLifetimeChecks.swift" \
  -o "$app/.build/calendar-editor-lifetime-check"
"$app/.build/calendar-editor-lifetime-check"
python3 apps/ios-native/scripts/check-project-download-fixture.test.py
export MINDWTR_CORE_BUNDLE="$app/Resources/core-host.js"
export MINDWTR_CRYPTO_TEST_BUNDLE="$app/.build/crypto-test-host.js"
export MINDWTR_ATTACHMENT_UPLOAD_TEST_BUNDLE="$app/.build/attachment-upload-test-host.js"
export TZ=America/New_York
# CI pipes this output through tee. Flush each XCTest line so a timeout does
# not leave a buffered, misleading last test in the uploaded evidence.
test_command=(swift test --package-path "$app" --jobs 2)
if command -v stdbuf >/dev/null 2>&1; then
  test_command=(stdbuf -oL -eL "${test_command[@]}")
fi
"${test_command[@]}"
xcodebuild -project "$app/MindwtrNative.xcodeproj" -scheme MindwtrNative \
  -configuration Debug -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath "$app/.build/DerivedData" -jobs 2 CODE_SIGNING_ALLOWED=NO build
