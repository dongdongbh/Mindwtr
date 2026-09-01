#!/bin/sh
# Writes the admin-provided runtime defaults for the web app (#1125): with
# MINDWTR_DEFAULT_CLOUD_URL set, a fresh browser's sync setup prefills that
# Cloud URL so the user only enters their token. Unset or empty removes the
# file and the app falls back to same-origin detection.
set -eu
CONFIG_PATH=/usr/share/nginx/html/runtime-config.json
if [ -n "${MINDWTR_DEFAULT_CLOUD_URL:-}" ]; then
    escaped=$(printf '%s' "$MINDWTR_DEFAULT_CLOUD_URL" | sed 's/\\/\\\\/g; s/"/\\"/g')
    printf '{"defaultCloudUrl":"%s"}\n' "$escaped" > "$CONFIG_PATH"
else
    rm -f "$CONFIG_PATH"
fi
