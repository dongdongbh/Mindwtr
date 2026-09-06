#!/usr/bin/env bash
# Builds the macOS WidgetKit "Tasks" widget, embeds it into the already-built
# Mindwtr.app bundle, and re-signs the outer bundle (#1054).
#
# Run on the macOS release runner, AFTER `tauri build --bundles app` produces
# Mindwtr.app and BEFORE the installer (DMG or App Store .pkg) is built from it
# -- see .github/workflows/release-macos.yml and release-macos-appstore.yml.
# The installer must be built from the app this script modifies, never by
# re-running `tauri build`/`tauri bundle`, or the widget silently never ships.
#
# Two distributions, selected by MINDWTR_WIDGET_DISTRIBUTION (default
# "developer-id"):
#
#   developer-id  The notarized DMG. Host entitlements come from
#                 Entitlements.mac.plist, widget entitlements from
#                 Entitlements.widget.plist (sandbox + App Group only). The
#                 App Group is unrestricted on macOS, so no provisioning
#                 profile is involved anywhere.
#
#   appstore      The Mac App Store .pkg. Host entitlements come from
#                 Entitlements.mas.plist, widget entitlements from
#                 Entitlements.widget.mas.plist, which additionally carries the
#                 application-identifier and team-identifier the App Store
#                 requires for every signed bundle. App Store bundles also need
#                 their own provisioning profile, so the widget's profile
#                 (MINDWTR_WIDGET_PROVISIONING_PROFILE, a .provisionprofile for
#                 bundle id tech.dongdongbh.mindwtr.MindwtrWidgets) is copied
#                 to <appex>/Contents/embedded.provisionprofile before the
#                 appex is signed. The host keeps the embedded.provisionprofile
#                 `tauri build` already placed there.
#
# Requires a signing identity and team ID; skips (exit 0) when neither is
# configured, e.g. an unsigned PR/fork build of the workflow. Having only one
# of the two configured is treated as a broken environment (exit 1), not a
# reason to silently skip.
#
# Usage: scripts/build-macos-widget.sh <path-to-Mindwtr.app> <apple-team-id> <signing-identity> <rust-target-triple>
#   <rust-target-triple> is aarch64-apple-darwin, x86_64-apple-darwin, or
#   universal-apple-darwin (each slice compiled separately, joined with lipo).
set -euo pipefail

APP_PATH="${1:-}"
TEAM_ID="${2:-}"
SIGNING_IDENTITY="${3:-}"
RUST_TARGET="${4:-}"
DISTRIBUTION="${MINDWTR_WIDGET_DISTRIBUTION:-developer-id}"
WIDGET_PROVISIONING_PROFILE="${MINDWTR_WIDGET_PROVISIONING_PROFILE:-}"
WIDGET_SRC_DIR="apps/desktop/widgets-macos"
HOST_EXECUTABLE_NAME="mindwtr"
WIDGET_BUNDLE_ID="tech.dongdongbh.mindwtr.MindwtrWidgets"
WIDGET_EXECUTABLE_NAME="MindwtrWidgets"
APP_GROUP_PLACEHOLDER="__MINDWTR_MACOS_APP_GROUP__"
TEAM_ID_PLACEHOLDER="__MINDWTR_MACOS_TEAM_ID__"
PLIST_BUDDY="${PLIST_BUDDY:-/usr/libexec/PlistBuddy}"

if [ -z "$APP_PATH" ] || [ ! -d "$APP_PATH" ]; then
    echo "::error::build-macos-widget.sh: missing or invalid app bundle path: '${APP_PATH}'"
    exit 1
fi

if [ -z "$SIGNING_IDENTITY" ] && [ -z "$TEAM_ID" ]; then
    echo "No signing identity/team configured; skipping the macOS widget (#1054)."
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
    aarch64-apple-darwin) SWIFT_ARCHS="arm64" ;;
    x86_64-apple-darwin) SWIFT_ARCHS="x86_64" ;;
    universal-apple-darwin) SWIFT_ARCHS="arm64 x86_64" ;;
    *)
        echo "::error::build-macos-widget.sh: unrecognized Rust target triple '${RUST_TARGET}'."
        exit 1
        ;;
esac

case "$DISTRIBUTION" in
    developer-id)
        HOST_ENTITLEMENTS="apps/desktop/src-tauri/Entitlements.mac.plist"
        WIDGET_ENTITLEMENTS="$WIDGET_SRC_DIR/Entitlements.widget.plist"
        ;;
    appstore)
        HOST_ENTITLEMENTS="apps/desktop/src-tauri/Entitlements.mas.plist"
        WIDGET_ENTITLEMENTS="$WIDGET_SRC_DIR/Entitlements.widget.mas.plist"
        if [ -z "$WIDGET_PROVISIONING_PROFILE" ] || [ ! -f "$WIDGET_PROVISIONING_PROFILE" ]; then
            echo "::error::build-macos-widget.sh: App Store mode needs MINDWTR_WIDGET_PROVISIONING_PROFILE to point at the widget's .provisionprofile (got '${WIDGET_PROVISIONING_PROFILE}')."
            exit 1
        fi
        ;;
    *)
        echo "::error::build-macos-widget.sh: unrecognized MINDWTR_WIDGET_DISTRIBUTION '${DISTRIBUTION}' (expected developer-id or appstore)."
        exit 1
        ;;
esac

APP_GROUP="${TEAM_ID}.tech.dongdongbh.mindwtr"
WIDGET_APPLICATION_IDENTIFIER="${TEAM_ID}.${WIDGET_BUNDLE_ID}"

WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT

APPEX_DIR="$WORKDIR/${WIDGET_EXECUTABLE_NAME}.appex"
mkdir -p "$APPEX_DIR/Contents/MacOS"
WIDGET_BINARY="$APPEX_DIR/Contents/MacOS/${WIDGET_EXECUTABLE_NAME}"

SDK_PATH="$(xcrun --sdk macosx --show-sdk-path)"
SLICES=()
for SWIFT_ARCH in $SWIFT_ARCHS; do
    SLICE="$WORKDIR/${WIDGET_EXECUTABLE_NAME}-${SWIFT_ARCH}"
    echo "Compiling macOS widget Swift sources for ${SWIFT_ARCH} (from ${RUST_TARGET})..."
    swiftc \
        -O \
        -sdk "$SDK_PATH" \
        -target "${SWIFT_ARCH}-apple-macos14.0" \
        -parse-as-library \
        -application-extension \
        -emit-executable \
        -o "$SLICE" \
        "$WIDGET_SRC_DIR"/*.swift
    SLICES+=("$SLICE")
done

if [ "${#SLICES[@]}" -eq 1 ]; then
    mv "${SLICES[0]}" "$WIDGET_BINARY"
else
    echo "Joining ${#SLICES[@]} widget slices into a universal binary..."
    lipo -create "${SLICES[@]}" -output "$WIDGET_BINARY"
fi

echo "Assembling ${WIDGET_EXECUTABLE_NAME}.appex..."
cp "$WIDGET_SRC_DIR/Info.plist" "$APPEX_DIR/Contents/Info.plist"
cp "$WIDGET_ENTITLEMENTS" "$WORKDIR/Entitlements.widget.plist"

# A backup suffix works with both BSD and GNU sed, which keeps the packaging
# path hermetically testable on non-macOS CI hosts too.
sed -i.bak "s/${APP_GROUP_PLACEHOLDER}/${APP_GROUP}/g" "$APPEX_DIR/Contents/Info.plist"
sed -i.bak "s/${APP_GROUP_PLACEHOLDER}/${APP_GROUP}/g; s/${TEAM_ID_PLACEHOLDER}/${TEAM_ID}/g" "$WORKDIR/Entitlements.widget.plist"
rm -f "$APPEX_DIR/Contents/Info.plist.bak" "$WORKDIR/Entitlements.widget.plist.bak"

APP_VERSION="$($PLIST_BUDDY -c 'Print :CFBundleShortVersionString' "$APP_PATH/Contents/Info.plist")"
APP_BUILD="$($PLIST_BUDDY -c 'Print :CFBundleVersion' "$APP_PATH/Contents/Info.plist" 2>/dev/null || echo "$APP_VERSION")"
$PLIST_BUDDY -c "Set :CFBundleShortVersionString ${APP_VERSION}" "$APPEX_DIR/Contents/Info.plist"
$PLIST_BUDDY -c "Set :CFBundleVersion ${APP_BUILD}" "$APPEX_DIR/Contents/Info.plist"
$PLIST_BUDDY -c "Set :CFBundleIdentifier ${WIDGET_BUNDLE_ID}" "$APPEX_DIR/Contents/Info.plist"

if [ "$DISTRIBUTION" = "appstore" ]; then
    # Must land before signing: the profile is part of the sealed bundle, and
    # App Store validation rejects a nested bundle without its own profile.
    echo "Embedding the widget's App Store provisioning profile..."
    cp "$WIDGET_PROVISIONING_PROFILE" "$APPEX_DIR/Contents/embedded.provisionprofile"
fi

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
RESOLVED_HOST_ENTITLEMENTS="$WORKDIR/Entitlements.host.resolved.plist"
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
# has. This runs against the exact app the installer step packages next, so
# a failure here is a failure before the DMG/.pkg (and notarization or App
# Store upload) ever sees a broken build.

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

if [ "$DISTRIBUTION" = "appstore" ]; then
    if [ ! -f "$INSTALLED_APPEX/Contents/embedded.provisionprofile" ]; then
        echo "::error::Widget appex is missing Contents/embedded.provisionprofile (App Store validation rejects a nested bundle without its own profile)."
        exit 1
    fi
    if printf '%s' "$APPEX_ENTITLEMENTS" | grep -q "$TEAM_ID_PLACEHOLDER"; then
        echo "::error::Widget appex: still contains the unresolved placeholder ${TEAM_ID_PLACEHOLDER}."
        exit 1
    fi
    if ! printf '%s' "$APPEX_ENTITLEMENTS" | grep -qF "<string>${WIDGET_APPLICATION_IDENTIFIER}</string>"; then
        echo "::error::Widget appex: does not carry the expected application-identifier ${WIDGET_APPLICATION_IDENTIFIER}."
        exit 1
    fi
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
