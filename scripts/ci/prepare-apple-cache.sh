#!/bin/bash
set -euo pipefail
test "${GITHUB_ACTIONS:-}" = true
phase="${1:-startup}"
[ "$#" -le 1 ] && [[ "$phase" = startup || "$phase" = before-archive ]] || {
  echo 'prepare-apple-cache: Expected startup or before-archive phase.' >&2
  exit 1
}
if [ "${RUNNER_ENVIRONMENT:-}" = self-hosted ]; then
  export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
  python3 "$(dirname "$0")/apple_ci_storage.py" "$phase"
  [ "$phase" != before-archive ] || exit 0
  : "${GITHUB_ENV:?}" "${GITHUB_PATH:?}"
  git clean -ffdx -e node_modules/
  echo 'DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer' >> "$GITHUB_ENV"
  gem_home="$HOME/.local/share/gems/ruby-3.3"
  mkdir -p "$gem_home"
  echo "GEM_HOME=$gem_home" >> "$GITHUB_ENV"
  echo "GEM_PATH=$gem_home" >> "$GITHUB_ENV"
  echo "$gem_home/bin" >> "$GITHUB_PATH"
else
  [ "$phase" != before-archive ] || exit 0
  : "${GITHUB_ENV:?}" "${RUNNER_TEMP:?}"
  xcode_id="$(xcodebuild -version | shasum -a 256 | cut -c 1-16)"
  cache_root="$RUNNER_TEMP/mindwtr-native/$xcode_id"
  mkdir -p "$cache_root/swift" "$cache_root/simulator" "$cache_root/archive"
  echo "MINDWTR_NATIVE_CACHE=$cache_root" >> "$GITHUB_ENV"
  echo "MINDWTR_SWIFT_CACHE=$cache_root/swift" >> "$GITHUB_ENV"
  echo "MINDWTR_APPLE_TEMP=$RUNNER_TEMP" >> "$GITHUB_ENV"
fi
echo 'LANG=en_US.UTF-8' >> "$GITHUB_ENV"
echo 'LC_ALL=en_US.UTF-8' >> "$GITHUB_ENV"
