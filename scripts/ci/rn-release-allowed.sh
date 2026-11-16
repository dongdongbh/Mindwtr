#!/usr/bin/env bash
set -euo pipefail

version="${1:?usage: rn-release-allowed.sh <version>}"
base="${version#v}"
base="${base%%-*}"
IFS=. read -r major minor patch <<< "${base}"
if ! [[ "${major:-}" =~ ^[0-9]+$ && "${minor:-}" =~ ^[0-9]+$ && "${patch:-}" =~ ^[0-9]+$ ]]; then
  echo "Invalid version '${version}'. Expected 1.2.3, v1.2.3 or v1.2.3-rc.1" >&2
  exit 2
fi
if (( major > 1 || (major == 1 && minor >= 4) )); then
  echo false
else
  echo true
fi
