#!/usr/bin/env bash
set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/../.."

failed=()
for file in apps/android-native/bundle/*.test.ts apps/ios-native/bundle/*.test.ts; do
  echo "== $file"
  bun test "$file" || failed+=("$file")
done

if [ "${#failed[@]}" -gt 0 ]; then
  printf 'FAILED %s\n' "${failed[@]}" >&2
  exit 1
fi
