#!/usr/bin/env bash
set -euo pipefail

if [[ "$#" -ne 1 ]]; then
  echo "Usage: $0 <apk-or-aab>" >&2
  exit 2
fi

artifact="$1"
if [[ ! -f "$artifact" ]]; then
  echo "Android artifact not found: $artifact" >&2
  exit 2
fi

case "$artifact" in
  *.apk|*.aab) ;;
  *)
    echo "Expected an APK or AAB: $artifact" >&2
    exit 2
    ;;
esac

for tool in unzip readelf; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "$tool is required to verify Android native library alignment" >&2
    exit 2
  fi
done

scratch_dir="$(mktemp -d)"
trap 'rm -rf "$scratch_dir"' EXIT
unzip -q "$artifact" -d "$scratch_dir"

mapfile -t native_libraries < <(
  find "$scratch_dir" -type f \
    \( -path '*/lib/arm64-v8a/*.so' -o -path '*/lib/x86_64/*.so' \) \
    -print | sort
)

if [[ "${#native_libraries[@]}" -eq 0 ]]; then
  echo "No 64-bit Android native libraries found in $artifact" >&2
  exit 1
fi

failed=0
for library in "${native_libraries[@]}"; do
  relative_path="${library#"$scratch_dir"/}"
  mapfile -t load_alignments < <(
    readelf -lW "$library" | awk '$1 == "LOAD" { print $NF }'
  )
  if [[ "${#load_alignments[@]}" -eq 0 ]]; then
    echo "Could not read ELF LOAD segments from $relative_path" >&2
    failed=1
    continue
  fi
  for alignment in "${load_alignments[@]}"; do
    if (( alignment < 16384 )); then
      echo "UNALIGNED $relative_path has ELF LOAD alignment $alignment; expected at least 0x4000" >&2
      failed=1
    fi
  done
done

if [[ "$failed" -ne 0 ]]; then
  exit 1
fi

echo "16 KB ELF alignment verified for ${#native_libraries[@]} 64-bit native libraries in $artifact"
