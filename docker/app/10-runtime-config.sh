#!/bin/sh
# Writes the admin-provided runtime defaults for the web app: with
# MINDWTR_DEFAULT_CLOUD_URL set, a fresh browser's sync setup prefills that
# Cloud URL so the user only enters their token (#1125). With
# MINDWTR_REQUIRE_SYNC=1, the app shows a login screen (Self-Hosted URL +
# Access Token) before rendering anything else. Either var being set writes
# the file; neither being set removes it.
set -eu
CONFIG_PATH=/usr/share/nginx/html/runtime-config.json

require_sync=false
if [ "${MINDWTR_REQUIRE_SYNC:-}" = "1" ]; then
    require_sync=true
fi

if [ -n "${MINDWTR_DEFAULT_CLOUD_URL:-}" ] || [ "$require_sync" = "true" ]; then
    default_cloud_url_json=null
    if [ -n "${MINDWTR_DEFAULT_CLOUD_URL:-}" ]; then
        escaped=$(printf '%s' "$MINDWTR_DEFAULT_CLOUD_URL" | sed 's/\\/\\\\/g; s/"/\\"/g')
        default_cloud_url_json="\"$escaped\""
    fi
    printf '{"defaultCloudUrl":%s,"requireSync":%s}\n' "$default_cloud_url_json" "$require_sync" > "$CONFIG_PATH"
else
    rm -f "$CONFIG_PATH"
fi
