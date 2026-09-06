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

cat > "$STUB_BIN/lipo" <<'STUB'
#!/usr/bin/env bash
printf 'lipo %s\n' "$*" >> "$WIDGET_TEST_LOG"
output=""
while [ "$#" -gt 0 ]; do
    if [ "$1" = "-output" ]; then
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

# Signing records the entitlements it was handed per target; `-d` plays that
# recording back, so the script's post-sign assertions see exactly what it
# signed with (including any unresolved placeholder it failed to substitute).
cat > "$STUB_BIN/codesign" <<'STUB'
#!/usr/bin/env bash
printf 'codesign %s\n' "$*" >> "$WIDGET_TEST_LOG"
target="${!#}"
if [ "${1:-}" = "-d" ]; then
    case "$target" in
        *.appex) cat "$WIDGET_TEST_DIR/widget-entitlements.plist" ;;
        *.app) cat "$WIDGET_TEST_DIR/host-entitlements.plist" ;;
    esac
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
    *.appex)
        cp "$entitlements" "$WIDGET_TEST_DIR/widget-entitlements.plist"
        if [ -f "$target/Contents/embedded.provisionprofile" ]; then
            : > "$WIDGET_TEST_DIR/profile-sealed"
        fi
        ;;
    *.app) cp "$entitlements" "$WIDGET_TEST_DIR/host-entitlements.plist" ;;
esac
STUB

cat > "$STUB_BIN/strings" <<'STUB'
#!/usr/bin/env bash
printf '%s.tech.dongdongbh.mindwtr\n' "$WIDGET_TEST_TEAM"
STUB

chmod +x "$STUB_BIN"/*

# run_case <rust-target> <case-name> [distribution]
run_case() {
    local rust_target="$1"
    local case_name="$2"
    local distribution="${3:-developer-id}"
    local case_dir="$TEST_DIR/$case_name"
    local app_path="$case_dir/Mindwtr.app"
    local log_path="$case_dir/commands.log"
    local profile_path="$case_dir/widget.provisionprofile"
    mkdir -p "$app_path/Contents/MacOS"
    printf '<plist/>\n' > "$app_path/Contents/Info.plist"
    printf 'binary fixture\n' > "$app_path/Contents/MacOS/mindwtr"
    printf 'provisioning profile fixture\n' > "$profile_path"
    : > "$log_path"

    (
        cd "$ROOT_DIR"
        PATH="$STUB_BIN:$PATH" \
        PLIST_BUDDY="$STUB_BIN/PlistBuddy" \
        WIDGET_TEST_DIR="$case_dir" \
        WIDGET_TEST_LOG="$log_path" \
        WIDGET_TEST_TEAM="TEAM123" \
        MINDWTR_WIDGET_DISTRIBUTION="$distribution" \
        MINDWTR_WIDGET_PROVISIONING_PROFILE="$profile_path" \
        bash scripts/build-macos-widget.sh "$app_path" TEAM123 'Signing Fixture' "$rust_target"
    )

    local appex="$app_path/Contents/PlugIns/MindwtrWidgets.appex"
    test -d "$appex"
    test -f "$appex/Contents/MacOS/MindwtrWidgets"
    grep -q 'Set :CFBundleShortVersionString 1.2.5' "$log_path"
    grep -q 'Set :CFBundleVersion 125' "$log_path"
    grep -q 'Set :CFBundleIdentifier tech.dongdongbh.mindwtr.MindwtrWidgets' "$log_path"
    grep -qF 'TEAM123.tech.dongdongbh.mindwtr' "$appex/Contents/Info.plist"
    ! grep -q '__MINDWTR_MACOS_APP_GROUP__' "$appex/Contents/Info.plist"
    grep -qF '<string>TEAM123.tech.dongdongbh.mindwtr</string>' "$case_dir/widget-entitlements.plist"
    grep -q 'com.apple.security.app-sandbox' "$case_dir/widget-entitlements.plist"
    ! grep -q '__MINDWTR_MACOS_' "$case_dir/widget-entitlements.plist"
    grep -qF '<string>TEAM123.tech.dongdongbh.mindwtr</string>' "$case_dir/host-entitlements.plist"
    ! grep -q '__MINDWTR_MACOS_' "$case_dir/host-entitlements.plist"

    local appex_sign_line
    local app_sign_line
    appex_sign_line="$(grep -n '^codesign --force .*\.appex$' "$log_path" | head -n 1 | cut -d: -f1)"
    app_sign_line="$(grep -n '^codesign --force .*\.app$' "$log_path" | head -n 1 | cut -d: -f1)"
    test -n "$appex_sign_line" && test -n "$app_sign_line"
    test "$appex_sign_line" -lt "$app_sign_line"
    ! grep '^codesign --force .*\.app$' "$log_path" | grep -q -- '--deep'

    case "$distribution" in
        developer-id)
            # Developer ID never touches a provisioning profile and signs the
            # host with Entitlements.mac.plist (no sandbox there).
            ! test -e "$appex/Contents/embedded.provisionprofile"
            ! test -e "$case_dir/profile-sealed"
            ! grep -q 'com.apple.security.app-sandbox' "$case_dir/host-entitlements.plist"
            ! grep -q 'com.apple.application-identifier' "$case_dir/widget-entitlements.plist"
            ;;
        appstore)
            cmp -s "$profile_path" "$appex/Contents/embedded.provisionprofile"
            grep -qF '<string>TEAM123.tech.dongdongbh.mindwtr.MindwtrWidgets</string>' "$case_dir/widget-entitlements.plist"
            grep -q 'com.apple.developer.team-identifier' "$case_dir/widget-entitlements.plist"
            grep -qF '<string>TEAM123</string>' "$case_dir/widget-entitlements.plist"
            # Entitlements.mas.plist is the only host file with the sandbox key.
            grep -q 'com.apple.security.app-sandbox' "$case_dir/host-entitlements.plist"
            grep -q 'com.apple.security.files.user-selected.read-write' "$case_dir/host-entitlements.plist"
            # The profile has to be in place when the appex is signed (sealed).
            test -f "$case_dir/profile-sealed"
            ;;
    esac
}

expect_swift_targets() {
    local log_path="$1"
    shift
    local count
    count="$(grep -c '^swiftc ' "$log_path")"
    test "$count" -eq "$#"
    for arch in "$@"; do
        grep -q -- "-target ${arch}-apple-macos14.0" "$log_path"
    done
}

run_case aarch64-apple-darwin arm64
expect_swift_targets "$TEST_DIR/arm64/commands.log" arm64
! grep -q '^lipo ' "$TEST_DIR/arm64/commands.log"

run_case x86_64-apple-darwin x86_64
expect_swift_targets "$TEST_DIR/x86_64/commands.log" x86_64
! grep -q '^lipo ' "$TEST_DIR/x86_64/commands.log"

run_case universal-apple-darwin universal
expect_swift_targets "$TEST_DIR/universal/commands.log" arm64 x86_64
grep -q '^lipo -create .*MindwtrWidgets-arm64 .*MindwtrWidgets-x86_64 -output .*/MindwtrWidgets$' "$TEST_DIR/universal/commands.log"

run_case universal-apple-darwin appstore appstore
expect_swift_targets "$TEST_DIR/appstore/commands.log" arm64 x86_64

# App Store mode without a profile must fail loudly rather than ship a widget
# the App Store would reject.
if (
    cd "$ROOT_DIR"
    mkdir -p "$TEST_DIR/noprofile/Mindwtr.app/Contents/MacOS"
    printf '<plist/>\n' > "$TEST_DIR/noprofile/Mindwtr.app/Contents/Info.plist"
    PATH="$STUB_BIN:$PATH" PLIST_BUDDY="$STUB_BIN/PlistBuddy" \
    WIDGET_TEST_DIR="$TEST_DIR/noprofile" WIDGET_TEST_LOG="$TEST_DIR/noprofile/commands.log" WIDGET_TEST_TEAM="TEAM123" \
    MINDWTR_WIDGET_DISTRIBUTION=appstore \
    bash scripts/build-macos-widget.sh "$TEST_DIR/noprofile/Mindwtr.app" TEAM123 'Signing Fixture' universal-apple-darwin >/dev/null 2>&1
); then
    echo 'expected App Store mode without a provisioning profile to fail' >&2
    exit 1
fi

echo 'macOS widget packaging dry run passed.'
