#!/usr/bin/env bash
# Builds the Developer ID release DMG by hand from an already-built, and
# widget-embedded, Mindwtr.app -- instead of `tauri bundle --bundles dmg`.
#
# `tauri bundle` always regenerates the .app bundle from the compiled binary
# and re-signs THAT before packaging it into the DMG, which discards whatever
# scripts/build-macos-widget.sh already embedded and signed into the app.
# This script packages the exact app bundle it is given, unmodified, so a
# widget embedded before this step actually ships in the DMG (#1054).
#
# Run on the macOS Developer-ID release runner, AFTER
# scripts/build-macos-widget.sh has embedded and re-signed the app -- see
# .github/workflows/release-macos.yml. Output path and filename match what
# Tauri's own DMG bundler produces, since the Notarize and Collect steps
# downstream expect that exact layout.
#
# Usage: scripts/build-macos-dmg.sh <path-to-Mindwtr.app> <rust-target-triple> [signing-identity]
#
# The signing identity is optional: an unsigned/fork/PR build (no Developer
# ID configured) still needs an (unsigned) DMG artifact, matching what
# `tauri bundle --bundles dmg` produced for that case.
set -euo pipefail

APP_PATH="${1:-}"
RUST_TARGET="${2:-}"
SIGNING_IDENTITY="${3:-}"

if [ -z "$APP_PATH" ] || [ ! -d "$APP_PATH" ]; then
    echo "::error::build-macos-dmg.sh: missing or invalid app bundle path: '${APP_PATH}'"
    exit 1
fi

if [ -z "$RUST_TARGET" ]; then
    echo "::error::build-macos-dmg.sh: missing Rust target triple argument (e.g. aarch64-apple-darwin)."
    exit 1
fi

case "$RUST_TARGET" in
    aarch64-apple-darwin) DMG_ARCH="aarch64" ;;
    x86_64-apple-darwin) DMG_ARCH="x64" ;;
    *)
        echo "::error::build-macos-dmg.sh: unrecognized Rust target triple '${RUST_TARGET}'."
        exit 1
        ;;
esac

TAURI_CONF="apps/desktop/src-tauri/tauri.conf.json"
if [ ! -f "$TAURI_CONF" ]; then
    echo "::error::build-macos-dmg.sh: missing ${TAURI_CONF} (run from the repo root)."
    exit 1
fi
APP_VERSION="$(python3 -c 'import json, sys; print(json.load(open(sys.argv[1], encoding="utf-8"))["version"])' "$TAURI_CONF")"

# Matches Tauri's own DMG bundler naming (Mindwtr_1.2.6_aarch64.dmg /
# Mindwtr_1.2.6_x64.dmg): the Notarize and Collect steps downstream find the
# DMG by globbing this directory, and Collect renames it using this same
# <version>_<arch> shape, so the name has to match exactly.
DMG_DIR="apps/desktop/src-tauri/target/${RUST_TARGET}/release/bundle/dmg"
DMG_NAME="Mindwtr_${APP_VERSION}_${DMG_ARCH}.dmg"
DMG_PATH="${DMG_DIR}/${DMG_NAME}"

mkdir -p "$DMG_DIR"
rm -f "$DMG_PATH"

WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT

STAGING_DIR="$WORKDIR/staging"
mkdir -p "$STAGING_DIR"

echo "Staging ${APP_PATH} for DMG packaging..."
# ditto (not cp -R) preserves symlinks, resource forks, and code signatures
# inside the bundle -- a plain recursive copy can silently corrupt the
# widget appex's signature.
ditto "$APP_PATH" "$STAGING_DIR/$(basename "$APP_PATH")"
ln -s /Applications "$STAGING_DIR/Applications"

echo "Creating ${DMG_PATH}..."
hdiutil create -volname "Mindwtr" -srcfolder "$STAGING_DIR" -ov -format UDZO -fs HFS+ "$DMG_PATH"

if [ -n "$SIGNING_IDENTITY" ]; then
    echo "Signing ${DMG_PATH}..."
    codesign --sign "$SIGNING_IDENTITY" --timestamp "$DMG_PATH"
else
    echo "No signing identity provided; leaving ${DMG_PATH} unsigned."
fi

echo "Built ${DMG_PATH}."
