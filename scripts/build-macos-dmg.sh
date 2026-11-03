#!/usr/bin/env bash


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
