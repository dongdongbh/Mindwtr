#!/usr/bin/env bash
# Builds the macOS WidgetKit "Tasks" widget, embeds it into the already-built
# Mindwtr.app bundle, and re-signs the outer bundle (#1054).
#
# Run on the macOS Developer-ID release runner, AFTER `tauri build --bundles app`
# produces Mindwtr.app and BEFORE `tauri bundle --bundles dmg` packages it --
# see .github/workflows/release-macos.yml. The DMG must be built from the app
# this script modifies, not the other way around, or the widget never ships.
#
# Requires an Apple Developer ID signing identity and team ID; skips (exit 0)
# when neither is configured, e.g. an unsigned PR/fork build of the workflow.
# Having only one of the two configured is treated as a broken environment
# (exit 1), not a reason to silently skip.
#
# Usage: scripts/build-macos-widget.sh <path-to-Mindwtr.app> <apple-team-id> <signing-identity> <rust-target-triple>
set -euo pipefail

APP_PATH="${1:-}"
TEAM_ID="${2:-}"
SIGNING_IDENTITY="${3:-}"
RUST_TARGET="${4:-}"
WIDGET_SRC_DIR="apps/desktop/widgets-macos"
HOST_ENTITLEMENTS="apps/desktop/src-tauri/Entitlements.mac.plist"
HOST_EXECUTABLE_NAME="mindwtr"
WIDGET_BUNDLE_ID="tech.dongdongbh.mindwtr.MindwtrWidgets"
WIDGET_EXECUTABLE_NAME="MindwtrWidgets"
APP_GROUP_PLACEHOLDER="__MINDWTR_MACOS_APP_GROUP__"
PLIST_BUDDY="${PLIST_BUDDY:-/usr/libexec/PlistBuddy}"

if [ -z "$APP_PATH" ] || [ ! -d "$APP_PATH" ]; then
    echo "::error::build-macos-widget.sh: missing or invalid app bundle path: '${APP_PATH}'"
    exit 1
fi

if [ -z "$SIGNING_IDENTITY" ] && [ -z "$TEAM_ID" ]; then
    echo "No Developer ID signing identity/team configured; skipping the macOS widget (#1054)."
    exit 0
fi

if [ -z "$SIGNING_IDENTITY" ] || [ -z "$TEAM_ID" ]; then
    IDENTITY_STATE="unset"
    [ -n "$SIGNING_IDENTITY" ] && IDENTITY_STATE="set"
    TEAM_STATE="unset"
    [ -n "$TEAM_ID" ] && TEAM_STATE="set"
    echo "::error::build-macos-widget.sh: signing identity and team ID must both be set or both be empty (identity=${IDENTITY_STATE}, team=${TEAM_STATE}). A fully signed release must not silently ship without the widget."
    exit 1
fi

if [ -z "$RUST_TARGET" ]; then
    echo "::error::build-macos-widget.sh: missing Rust target triple argument (e.g. aarch64-apple-darwin)."
    exit 1
fi

case "$RUST_TARGET" in
    aarch64-apple-darwin) SWIFT_ARCH="arm64" ;;
    x86_64-apple-darwin) SWIFT_ARCH="x86_64" ;;
    *)
        echo "::error::build-macos-widget.sh: unrecognized Rust target triple '${RUST_TARGET}'."
        exit 1
        ;;
esac

APP_GROUP="${TEAM_ID}.tech.dongdongbh.mindwtr"

WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT

APPEX_DIR="$WORKDIR/${WIDGET_EXECUTABLE_NAME}.appex"
mkdir -p "$APPEX_DIR/Contents/MacOS"

echo "Compiling macOS widget Swift sources for ${SWIFT_ARCH} (from ${RUST_TARGET})..."
SDK_PATH="$(xcrun --sdk macosx --show-sdk-path)"
swiftc \
    -O \
    -sdk "$SDK_PATH" \
    -target "${SWIFT_ARCH}-apple-macos14.0" \
    -parse-as-library \
    -application-extension \
    -emit-executable \
    -o "$APPEX_DIR/Contents/MacOS/${WIDGET_EXECUTABLE_NAME}" \
    "$WIDGET_SRC_DIR"/*.swift

echo "Assembling ${WIDGET_EXECUTABLE_NAME}.appex..."
cp "$WIDGET_SRC_DIR/Info.plist" "$APPEX_DIR/Contents/Info.plist"
cp "$WIDGET_SRC_DIR/Entitlements.widget.plist" "$WORKDIR/Entitlements.widget.plist"

# A backup suffix works with both BSD and GNU sed, which keeps the packaging
# path hermetically testable on non-macOS CI hosts too.
sed -i.bak "s/${APP_GROUP_PLACEHOLDER}/${APP_GROUP}/g" "$APPEX_DIR/Contents/Info.plist"
sed -i.bak "s/${APP_GROUP_PLACEHOLDER}/${APP_GROUP}/g" "$WORKDIR/Entitlements.widget.plist"
rm -f "$APPEX_DIR/Contents/Info.plist.bak" "$WORKDIR/Entitlements.widget.plist.bak"

APP_VERSION="$($PLIST_BUDDY -c 'Print :CFBundleShortVersionString' "$APP_PATH/Contents/Info.plist")"
APP_BUILD="$($PLIST_BUDDY -c 'Print :CFBundleVersion' "$APP_PATH/Contents/Info.plist" 2>/dev/null || echo "$APP_VERSION")"
$PLIST_BUDDY -c "Set :CFBundleShortVersionString ${APP_VERSION}" "$APPEX_DIR/Contents/Info.plist"
$PLIST_BUDDY -c "Set :CFBundleVersion ${APP_BUILD}" "$APPEX_DIR/Contents/Info.plist"
$PLIST_BUDDY -c "Set :CFBundleIdentifier ${WIDGET_BUNDLE_ID}" "$APPEX_DIR/Contents/Info.plist"

echo "Signing ${WIDGET_EXECUTABLE_NAME}.appex with its own entitlements..."
codesign --force --options runtime --timestamp \
    --sign "$SIGNING_IDENTITY" \
    --entitlements "$WORKDIR/Entitlements.widget.plist" \
    "$APPEX_DIR"

echo "Embedding widget into ${APP_PATH}..."
PLUGINS_DIR="$APP_PATH/Contents/PlugIns"
mkdir -p "$PLUGINS_DIR"
INSTALLED_APPEX="${PLUGINS_DIR}/${WIDGET_EXECUTABLE_NAME}.appex"
rm -rf "${INSTALLED_APPEX:?}"
cp -R "$APPEX_DIR" "$PLUGINS_DIR/"

echo "Re-signing outer app bundle with the resolved App Group entitlement..."
RESOLVED_HOST_ENTITLEMENTS="$WORKDIR/Entitlements.mac.resolved.plist"
sed "s/${APP_GROUP_PLACEHOLDER}/${APP_GROUP}/g" "$HOST_ENTITLEMENTS" > "$RESOLVED_HOST_ENTITLEMENTS"

# Deliberately NOT `--deep`: the appex above already carries its own,
# distinct (sandboxed) entitlements signature. A `--deep` re-sign here would
# blow that away and re-sign it with the host's entitlements instead. Signing
# nested-first, container-last (and non-deep for the container) is the
# standard app-extension signing order (#1054 decision 8).
codesign --force --options runtime --timestamp \
    --sign "$SIGNING_IDENTITY" \
    --entitlements "$RESOLVED_HOST_ENTITLEMENTS" \
    "$APP_PATH"

# --- Post-sign assertions -----------------------------------------------
# The App Group entitlement is unrestricted on macOS (no provisioning-profile
# grant needed), so there is nothing to validate against a profile. What DOES
# need checking is that this script's own work actually landed: the appex is
# really there, and neither the host app nor the appex still carries the
# unresolved placeholder or a group that doesn't match what the other side
# has. This runs against the exact app that `tauri bundle --bundles dmg`
# packages next, so a failure here is a failure before the DMG (and
# notarization) ever sees a broken build.

assert_entitlement_group() {
    local target="$1"
    local label="$2"
    local entitlements
    entitlements="$(codesign -d --entitlements :- "$target" 2>/dev/null || true)"
    if [ -z "$entitlements" ]; then
        echo "::error::${label}: could not read entitlements after signing."
        exit 1
    fi
    if printf '%s' "$entitlements" | grep -q "$APP_GROUP_PLACEHOLDER"; then
        echo "::error::${label}: still contains the unresolved placeholder ${APP_GROUP_PLACEHOLDER}."
        exit 1
    fi
    if ! printf '%s' "$entitlements" | grep -qF "<string>${APP_GROUP}</string>"; then
        echo "::error::${label}: does not contain the expected App Group ${APP_GROUP}."
        exit 1
    fi
}

if [ ! -d "$INSTALLED_APPEX" ]; then
    echo "::error::${WIDGET_EXECUTABLE_NAME}.appex was not found in ${PLUGINS_DIR} after embedding."
    exit 1
fi

assert_entitlement_group "$APP_PATH" "Host app"
assert_entitlement_group "$INSTALLED_APPEX" "Widget appex"

APPEX_ENTITLEMENTS="$(codesign -d --entitlements :- "$INSTALLED_APPEX" 2>/dev/null || true)"
if ! printf '%s' "$APPEX_ENTITLEMENTS" | grep -q "com.apple.security.app-sandbox"; then
    echo "::error::Widget appex is missing the app-sandbox entitlement (mandatory for an appex even in a non-sandboxed host)."
    exit 1
fi

# Cheap regression guard for the host/appex-mismatch failure mode (#1054): if
# APPLE_TEAM_ID is ever dropped from the Build App step's env again, the
# entitlement checks above would still pass (this script computes APP_GROUP
# independently), but the *compiled binary* would still have baked in the
# DEVTEAM placeholder from build.rs, and the widget would silently never see
# real data. Checking the binary's own strings catches that class of drift.
if ! strings "$APP_PATH/Contents/MacOS/${HOST_EXECUTABLE_NAME}" 2>/dev/null | grep -F "$APP_GROUP" >/dev/null; then
    echo "::error::Host binary does not appear to have ${APP_GROUP} baked in -- APPLE_TEAM_ID may be missing from the Build App step's env."
    exit 1
fi

echo "macOS widget embedded, signed, and verified."
