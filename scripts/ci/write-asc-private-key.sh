#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 2 ]; then
  echo "Usage: $0 <asc_private_key_secret> <output_p8_path>" >&2
  exit 1
fi

key_input="$1"
out_path="$2"

if printf '%s' "$key_input" | grep -q "BEGIN PRIVATE KEY"; then

  printf '%b' "$key_input" | tr -d '\r' > "$out_path"
else
  "$(dirname "$0")/decode-base64-to-file.sh" "$key_input" "$out_path"
fi
