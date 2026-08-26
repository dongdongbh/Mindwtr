#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TEST_DIR="$(mktemp -d)"
trap 'rm -rf "$TEST_DIR"' EXIT

STUB_BIN="$TEST_DIR/bin"
mkdir -p "$STUB_BIN"

cat > "$STUB_BIN/xcrun" <<'STUB'
#!/usr/bin/env bash
printf 'xcrun %s\n' "$*" >> "$WIDGET_TEST_LOG"
printf '/tmp/fake-macos-sdk\n'
STUB

cat > "$STUB_BIN/swiftc" <<'STUB'
#!/usr/bin/env bash
printf 'swiftc %s\n' "$*" >> "$WIDGET_TEST_LOG"
output=""
while [ "$#" -gt 0 ]; do
    if [ "$1" = "-o" ]; then
        output="$2"
        break
    fi
    shift
done
mkdir -p "$(dirname "$output")"
: > "$output"
STUB

cat > "$STUB_BIN/PlistBuddy" <<'STUB'
#!/usr/bin/env bash
printf 'PlistBuddy %s\n' "$*" >> "$WIDGET_TEST_LOG"
case "$2" in
    'Print :CFBundleShortVersionString') printf '1.2.5\n' ;;
    'Print :CFBundleVersion') printf '125\n' ;;
esac
STUB

cat > "$STUB_BIN/codesign" <<'STUB'
#!/usr/bin/env bash
printf 'codesign %s\n' "$*" >> "$WIDGET_TEST_LOG"
target="${!#}"
if [ "${1:-}" = "-d" ]; then
    sandbox=""
    case "$target" in
        *.appex) sandbox='<key>com.apple.security.app-sandbox</key><true/>' ;;
    esac
    printf '<plist><array><string>%s.tech.dongdongbh.mindwtr</string></array>%s</plist>\n' "$WIDGET_TEST_TEAM" "$sandbox"
    exit 0
fi
entitlements=""
while [ "$#" -gt 0 ]; do
    if [ "$1" = "--entitlements" ]; then
        entitlements="$2"
        break
    fi
    shift
done
case "$target" in
    *.appex) cp "$entitlements" "$WIDGET_TEST_DIR/widget-entitlements.plist" ;;
    *.app) cp "$entitlements" "$WIDGET_TEST_DIR/host-entitlements.plist" ;;
esac
STUB

cat > "$STUB_BIN/strings" <<'STUB'
#!/usr/bin/env bash
printf '%s.tech.dongdongbh.mindwtr\n' "$WIDGET_TEST_TEAM"
STUB

chmod +x "$STUB_BIN"/*

run_case() {
    local rust_target="$1"
    local expected_arch="$2"
    local case_dir="$TEST_DIR/$expected_arch"
    local app_path="$case_dir/Mindwtr.app"
    local log_path="$case_dir/commands.log"
    mkdir -p "$app_path/Contents/MacOS"
    printf '<plist/>\n' > "$app_path/Contents/Info.plist"
    printf 'binary fixture\n' > "$app_path/Contents/MacOS/mindwtr"
    : > "$log_path"

    (
        cd "$ROOT_DIR"
        PATH="$STUB_BIN:$PATH" \
        PLIST_BUDDY="$STUB_BIN/PlistBuddy" \
        WIDGET_TEST_DIR="$case_dir" \
        WIDGET_TEST_LOG="$log_path" \
        WIDGET_TEST_TEAM="TEAM123" \
        bash scripts/build-macos-widget.sh "$app_path" TEAM123 'Developer ID Fixture' "$rust_target"
    )

    local appex="$app_path/Contents/PlugIns/MindwtrWidgets.appex"
    test -d "$appex"
    grep -q -- "-target ${expected_arch}-apple-macos14.0" "$log_path"
    grep -q 'Set :CFBundleShortVersionString 1.2.5' "$log_path"
    grep -q 'Set :CFBundleVersion 125' "$log_path"
    grep -q 'Set :CFBundleIdentifier tech.dongdongbh.mindwtr.MindwtrWidgets' "$log_path"
    grep -qF 'TEAM123.tech.dongdongbh.mindwtr' "$appex/Contents/Info.plist"
    ! grep -q '__MINDWTR_MACOS_APP_GROUP__' "$appex/Contents/Info.plist"
    grep -qF 'TEAM123.tech.dongdongbh.mindwtr' "$case_dir/widget-entitlements.plist"
    grep -q 'com.apple.security.app-sandbox' "$case_dir/widget-entitlements.plist"
    grep -qF 'TEAM123.tech.dongdongbh.mindwtr' "$case_dir/host-entitlements.plist"

    local appex_sign_line
    local app_sign_line
    appex_sign_line="$(grep -n '^codesign --force .*\.appex$' "$log_path" | head -n 1 | cut -d: -f1)"
    app_sign_line="$(grep -n '^codesign --force .*\.app$' "$log_path" | head -n 1 | cut -d: -f1)"
    test -n "$appex_sign_line" && test -n "$app_sign_line"
    test "$appex_sign_line" -lt "$app_sign_line"
    ! grep '^codesign --force .*\.app$' "$log_path" | grep -q -- '--deep'
}

run_case aarch64-apple-darwin arm64
run_case x86_64-apple-darwin x86_64

echo 'macOS widget packaging dry run passed.'
