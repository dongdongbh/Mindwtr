#!/usr/bin/env bash
set -euo pipefail

failures=0

read_dimensions() {
  local path="$1"
  local info=""
  info="$(file -b "${path}" 2>/dev/null || true)"
  if [[ "${info}" =~ ([0-9]+)\ x\ ([0-9]+) ]]; then
    printf '%s %s\n' "${BASH_REMATCH[1]}" "${BASH_REMATCH[2]}"
    return 0
  fi
  return 1
}

record_failure() {
  local path="$1"
  local message="$2"
  echo "::error file=${path}::${message}" >&2
  failures=$((failures + 1))
}

image_files() {
  local dir="$1"
  if [ ! -d "${dir}" ]; then
    return
  fi
  find "${dir}" -mindepth 1 -maxdepth 1 -type f \
    \( -iname '*.png' -o -iname '*.jpg' -o -iname '*.jpeg' \) \
    | sort
}

validate_exact() {
  local path="$1"
  shift
  local width=""
  local height=""
  if ! read -r width height < <(read_dimensions "${path}"); then
    record_failure "${path}" "Unable to read image dimensions."
    return
  fi
  local expected=""
  for expected in "$@"; do
    if [ "${width}x${height}" = "${expected}" ]; then
      return
    fi
  done
  record_failure "${path}" "Expected dimensions: $*; actual: ${width}x${height}."
}

validate_exact_dir() {
  local dir="$1"
  shift
  local file=""
  while IFS= read -r file; do
    validate_exact "${file}" "$@"
  done < <(image_files "${dir}")
}

validate_google_play_screenshot() {
  local path="$1"
  local width=""
  local height=""
  if ! read -r width height < <(read_dimensions "${path}"); then
    record_failure "${path}" "Unable to read image dimensions."
    return
  fi
  if [ "${width}" -lt 320 ] || [ "${height}" -lt 320 ] || [ "${width}" -gt 3840 ] || [ "${height}" -gt 3840 ]; then
    record_failure "${path}" "Google Play screenshots must be between 320px and 3840px on each side; actual: ${width}x${height}."
    return
  fi
  local short_side="${width}"
  local long_side="${height}"
  if [ "${width}" -gt "${height}" ]; then
    short_side="${height}"
    long_side="${width}"
  fi
  if [ "${long_side}" -gt $((short_side * 2)) ]; then
    record_failure "${path}" "Google Play screenshot aspect ratio must not exceed 2:1; actual: ${width}x${height}."
  fi
}

validate_google_play_dir() {
  local dir="$1"
  local file=""
  while IFS= read -r file; do
    validate_google_play_screenshot "${file}"
  done < <(image_files "${dir}")
}

validate_msstore_screenshot() {
  local path="$1"
  local width=""
  local height=""
  if ! read -r width height < <(read_dimensions "${path}"); then
    record_failure "${path}" "Unable to read image dimensions."
    return
  fi
  if [ "${width}" -lt 1366 ] || [ "${height}" -lt 768 ]; then
    record_failure "${path}" "Microsoft Store screenshots must be at least 1366x768; actual: ${width}x${height}."
    return
  fi
  local ratio_delta=$((width * 9 - height * 16))
  if [ "${ratio_delta}" -lt 0 ]; then
    ratio_delta=$((-ratio_delta))
  fi
  if [ "${ratio_delta}" -gt 16 ]; then
    record_failure "${path}" "Microsoft Store screenshots must be 16:9; actual: ${width}x${height}."
  fi
}

validate_msstore_dir() {
  local dir="$1"
  local file=""
  while IFS= read -r file; do
    if [ "$(basename "${file}")" = "banner.png" ]; then
      validate_exact "${file}" "1920x1080"
    else
      validate_msstore_screenshot "${file}"
    fi
  done < <(image_files "${dir}")
}

validate_exact_dir "apps/mobile/screenshots/iphone" "1290x2796" "2796x1290"
validate_exact_dir "apps/mobile/screenshots/ipad" "2064x2752" "2752x2064"
validate_exact_dir "apps/desktop/screenshots/mas" "1440x900"
validate_google_play_dir "apps/mobile/screenshots/android/playstore"
validate_msstore_dir "apps/desktop/screenshots/msstore"

if [ "${failures}" -gt 0 ]; then
  echo "Store image asset validation failed with ${failures} violation(s)." >&2
  exit 1
fi

echo "Store image asset validation passed."
