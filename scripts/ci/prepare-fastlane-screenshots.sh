#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 2 ]; then
  echo "Usage: $0 <ios|macos> <source_root>" >&2
  exit 1
fi

PLATFORM="$1"
SOURCE_ROOT="$2"

if [ -z "${FASTLANE_SCREENSHOTS_DIR:-}" ]; then
  echo "FASTLANE_SCREENSHOTS_DIR is required" >&2
  exit 1
fi

if [ -z "${FASTLANE_METADATA_PATH:-}" ]; then
  echo "FASTLANE_METADATA_PATH is required" >&2
  exit 1
fi

rm -rf "${FASTLANE_SCREENSHOTS_DIR}"
mkdir -p "${FASTLANE_SCREENSHOTS_DIR}"

LOCALES=()
while IFS= read -r locale_path; do
  locale_name="$(basename "${locale_path}")"
  case "${locale_name}" in
    review_information|trade_representative_contact_information)
      continue
      ;;
  esac
  LOCALES+=("${locale_name}")
done < <(find "${FASTLANE_METADATA_PATH}" -mindepth 1 -maxdepth 1 -type d | sort)

if [ "${#LOCALES[@]}" -eq 0 ]; then
  echo "No fastlane locales found under ${FASTLANE_METADATA_PATH}; skipping screenshot preparation." >&2
  exit 0
fi

had_files=0

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

resolve_target_dimensions() {
  local label="$1"
  local source_width="$2"
  local source_height="$3"

  case "${PLATFORM}:${label}" in
    ios:iPhone)
      if [ "${source_width}" -ge "${source_height}" ]; then
        echo "2796 1290"
      else
        echo "1290 2796"
      fi
      ;;
    ios:iPad)
      if [ "${source_width}" -ge "${source_height}" ]; then
        echo "2752 2064"
      else
        echo "2064 2752"
      fi
      ;;
    macos:macOS)
      echo "1440 900"
      ;;
    *)
      echo "Unsupported screenshot target: ${PLATFORM}:${label}" >&2
      exit 1
      ;;
  esac
}

copy_screenshot() {
  local src_path="$1"
  local dest_path="$2"
  local label="$3"
  local source_width=""
  local source_height=""
  local target_width=""
  local target_height=""

  if ! read -r source_width source_height < <(read_dimensions "${src_path}"); then
    echo "::error::Unable to determine screenshot dimensions for ${src_path}." >&2
    exit 1
  fi

  read -r target_width target_height < <(resolve_target_dimensions "${label}" "${source_width}" "${source_height}")

  if [ "${source_width}" -ne "${target_width}" ] || [ "${source_height}" -ne "${target_height}" ]; then
    echo "::error file=${src_path}::${label} screenshot is ${source_width}x${source_height}; expected ${target_width}x${target_height}." >&2
    exit 1
  fi

  cp "${src_path}" "${dest_path}"
}

copy_group() {
  local src_dir="$1"
  local prefix="$2"
  local dest_dir="$3"
  local label="$4"

  if [ ! -d "${src_dir}" ]; then
    echo "Skipping ${label} screenshots (missing directory: ${src_dir})" >&2
    return
  fi

  local files=()
  while IFS= read -r file; do
    files+=("${file}")
  done < <(
    find "${src_dir}" -mindepth 1 -maxdepth 1 -type f \
      \( -iname '*.png' -o -iname '*.jpg' -o -iname '*.jpeg' \) \
      | sort
  )

  if [ "${#files[@]}" -eq 0 ]; then
    echo "Skipping ${label} screenshots (no image files found in ${src_dir})" >&2
    return
  fi

  local index=1
  local file=""
  for file in "${files[@]}"; do
    local base_name
    local stem
    local ordinal
    base_name="$(basename "${file}")"
    stem="${base_name%.*}"
    printf -v ordinal '%02d' "${index}"
    copy_screenshot "${file}" "${dest_dir}/${prefix}-${ordinal}-${stem}.png" "${label}"
    index=$((index + 1))
    had_files=1
  done
}

prepare_ios_locale() {
  local locale="$1"
  local dest_dir="${FASTLANE_SCREENSHOTS_DIR}/${locale}"
  mkdir -p "${dest_dir}"
  copy_group "${SOURCE_ROOT}/iphone" "iphone" "${dest_dir}" "iPhone"
  copy_group "${SOURCE_ROOT}/ipad" "ipad" "${dest_dir}" "iPad"
}

prepare_macos_locale() {
  local locale="$1"
  local dest_dir="${FASTLANE_SCREENSHOTS_DIR}/${locale}"
  mkdir -p "${dest_dir}"
  copy_group "${SOURCE_ROOT}" "mac" "${dest_dir}" "macOS"
}

locale=""
for locale in "${LOCALES[@]}"; do
  case "${PLATFORM}" in
    ios)
      prepare_ios_locale "${locale}"
      ;;
    macos)
      prepare_macos_locale "${locale}"
      ;;
    *)
      echo "Unsupported platform: ${PLATFORM}" >&2
      exit 1
      ;;
  esac
done

if [ "${had_files}" -eq 0 ]; then
  echo "No screenshots were prepared for ${PLATFORM}." >&2
  exit 0
fi

echo "Prepared fastlane screenshots for ${PLATFORM}:"
find "${FASTLANE_SCREENSHOTS_DIR}" -type f | sort
