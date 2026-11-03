#!/usr/bin/env bash


set -euo pipefail

requested="${1:-26}"
case "$requested" in
  26|27) ;;
  *) echo "Unsupported iOS SDK major: $requested" >&2; exit 1 ;;
esac

applications="${MINDWTR_XCODE_APPLICATIONS_DIR:-/Applications}"
selected=""
while IFS= read -r candidate; do
  if [ -d "$candidate/Contents/Developer" ]; then
    selected="$candidate/Contents/Developer"
  fi
done < <(find "$applications" -maxdepth 1 -type d -name "Xcode_${requested}*.app" | sort -V)

if [ -z "$selected" ]; then
  echo "Required Xcode $requested is not installed in $applications. Validation did not run." >&2
  exit 1
fi

export DEVELOPER_DIR="$selected"
xcodebuild -version
sdk_version="$(xcrun --sdk iphoneos --show-sdk-version)"
if [ "${sdk_version%%.*}" != "$requested" ]; then
  echo "Requested iOS SDK $requested, but selected Xcode provides $sdk_version." >&2
  exit 1
fi
swift_version="$(xcrun swiftc --version)"
printf 'Selected DEVELOPER_DIR: %s\niOS SDK: %s\n%s\n' "$DEVELOPER_DIR" "$sdk_version" "$swift_version"
if [ -n "${GITHUB_ENV:-}" ]; then
  printf 'DEVELOPER_DIR=%s\nMINDWTR_VALIDATED_IOS_SDK=%s\n' "$DEVELOPER_DIR" "$sdk_version" >> "$GITHUB_ENV"
fi
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  printf '### Apple toolchain\n\n- Developer directory: `%s`\n- iOS SDK: `%s`\n- Swift: `%s`\n' \
    "$DEVELOPER_DIR" "$sdk_version" "$swift_version" >> "$GITHUB_STEP_SUMMARY"
fi
