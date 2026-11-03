#!/bin/sh


set -eu
CONFIG_PATH=/usr/share/nginx/html/runtime-config.json
if [ -n "${MINDWTR_DEFAULT_CLOUD_URL:-}" ]; then
    escaped=$(printf '%s' "$MINDWTR_DEFAULT_CLOUD_URL" | sed 's/\\/\\\\/g; s/"/\\"/g')
    printf '{"defaultCloudUrl":"%s"}\n' "$escaped" > "$CONFIG_PATH"
else
    rm -f "$CONFIG_PATH"
fi
