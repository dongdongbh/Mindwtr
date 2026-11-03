#!/usr/bin/env bash
set -euo pipefail


tag_input="${1:-${INPUT_TAG:-}}"

if [ -z "${tag_input}" ] && [ -n "${GITHUB_EVENT_INPUTS_TAG:-}" ]; then
  tag_input="${GITHUB_EVENT_INPUTS_TAG}"
fi

if [ -z "${tag_input}" ] && [ -n "${GITHUB_REF_NAME:-}" ]; then
  tag_input="${GITHUB_REF_NAME}"
fi

if [ -z "${tag_input}" ] && [ -n "${GITHUB_REF:-}" ]; then
  tag_input="${GITHUB_REF#refs/tags/}"
fi

if [ -z "${tag_input}" ]; then
  echo "Failed to resolve release tag from input/ref" >&2
  exit 1
fi

tag="${tag_input}"
version="${tag#v}"

if [ -z "${version}" ] || ! echo "${version}" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+([.-][0-9A-Za-z.-]+)?$'; then
  echo "Invalid release tag '${tag}'. Expected format like v1.2.3 or v1.2.3-rc.1" >&2
  exit 1
fi

if [ "${REQUIRE_STABLE_RELEASE_TAG:-0}" = "1" ] && ! echo "${version}" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$'; then
  echo "Invalid stable release tag '${tag}'. Expected format like v1.2.3 without prerelease suffix." >&2
  exit 1
fi

printf 'tag=%s\n' "${tag}"
printf 'version=%s\n' "${version}"

