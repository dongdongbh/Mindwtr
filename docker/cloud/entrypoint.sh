#!/usr/bin/env sh
set -eu

source_path="${MINDWTR_CLOUD_AUTH_TOKENS_FILE:-}"
if [ -n "$source_path" ]; then
  if [ "$(id -u)" != "0" ]; then
    echo "File-backed Cloud authentication requires the Docker secrets overlay." >&2
    exit 1
  fi

  handoff_dir=/run/mindwtr-cloud
  handoff_path="$handoff_dir/auth-tokens"
  install -d -o root -g bun -m 0750 "$handoff_dir"
  install -o bun -g bun -m 0400 "$source_path" "$handoff_path"
  export MINDWTR_CLOUD_AUTH_TOKENS_FILE="$handoff_path"
fi

if [ "$(id -u)" = "0" ]; then
  exec su-exec bun:bun "$@"
fi
exec "$@"
