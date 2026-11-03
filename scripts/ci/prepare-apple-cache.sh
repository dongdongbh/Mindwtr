#!/bin/bash
set -euo pipefail
test "${GITHUB_ACTIONS:-}" = true
fail_cache() { echo "prepare-apple-cache: $*" >&2; exit 1; }
phase="${1:-startup}"
[ "$#" -le 1 ] || fail_cache 'Expected startup or before-archive phase.'
case "$phase" in
  startup) : "${GITHUB_ENV:?}" "${GITHUB_PATH:?}" "${RUNNER_TEMP:?}" ;;
  before-archive) [ "${RUNNER_ENVIRONMENT:-}" = self-hosted ] || exit 0 ;;
  *) fail_cache 'Expected startup or before-archive phase.' ;;
esac

cache_root="${RUNNER_TEMP:-}/mindwtr-native"
if [ "${RUNNER_ENVIRONMENT:-}" = self-hosted ]; then
  cache_root="$HOME/Library/Caches/MindwtrNativeCI"
  minimum_available_kib=$((12 * 1024 * 1024))
  available_kib() {
    local available
    if ! available="$(LC_ALL=C df -Pk "$HOME" | awk '
      NR == 1 { if ($1 != "Filesystem" || $4 != "Available") exit 1 }
      NR == 2 {
        if (NF < 6 || $2 !~ /^[0-9]+$/ || $3 !~ /^[0-9]+$/ || $4 !~ /^[0-9]+$/ || length($4) > 15 || $5 !~ /^[0-9]+%$/) exit 1
        value = $4
      }
      END { if (NR != 2 || value == "") exit 1; print value }
    ')"; then
      fail_cache 'Cannot measure available HOME volume space; refusing cache cleanup.'
    fi
    echo "$available"
  }
  validate_cache_parents() {
    local cache_home="$HOME"
    while [ "${cache_home%/}" != "$cache_home" ]; do cache_home="${cache_home%/}"; done
    [ -n "$cache_home" ] || fail_cache 'Refusing empty owned cache parent.'
    [ ! -L "$cache_home" ] && [ ! -L "$cache_home/Library" ] && [ ! -L "$cache_home/Library/Caches" ] || fail_cache 'Refusing symlinked owned cache parent.'
    [ ! -L "$cache_root" ] || fail_cache 'Refusing symlinked owned cache root.'
  }
  validate_cache_paths() {
    local version child
    validate_cache_parents
    for version in "$cache_root"/*; do
      [[ "${version##*/}" =~ ^[0-9a-f]{16}$ ]] || continue
      [ ! -L "$version" ] || fail_cache 'Refusing symlinked compiler cache.'
      [ -d "$version" ] || continue
      for child in swift simulator archive; do
        [ ! -L "$version/$child" ] || fail_cache 'Refusing symlinked generated cache child.'
        if [ -e "$version/$child" ] && [ ! -d "$version/$child" ]; then
          fail_cache 'Refusing unexpected generated cache child type.'
        fi
      done
    done
  }
  if [ "$phase" = before-archive ]; then


    validate_cache_parents
    if ! xcode_id="$(xcodebuild -version | shasum -a 256 | cut -c 1-16)"; then
      fail_cache 'Cannot identify the current compiler cache.'
    fi
    [[ "$xcode_id" =~ ^[0-9a-f]{16}$ ]] || fail_cache 'Invalid compiler cache identity.'
    current_cache="$cache_root/$xcode_id"
    [ "${MINDWTR_NATIVE_CACHE:-}" = "$current_cache" ] || fail_cache 'Refusing archive cache path that does not match the current compiler.'
    validate_archive_paths() {
      local child
      validate_cache_parents
      [ ! -L "$current_cache" ] || fail_cache 'Refusing symlinked compiler cache.'
      [ -d "$current_cache" ] || fail_cache 'Refusing missing or non-directory compiler cache.'
      for child in simulator archive; do
        [ ! -L "$current_cache/$child" ] || fail_cache 'Refusing symlinked generated cache child.'
        if [ -e "$current_cache/$child" ] && [ ! -d "$current_cache/$child" ]; then
          fail_cache 'Refusing unexpected generated cache child type.'
        fi
      done
    }
    validate_archive_paths

    minimum_available_kib=$((20 * 1024 * 1024))
    before_kib="$(available_kib)"
    after_kib="$before_kib"
    trimmed_entries=0
    if [ "$before_kib" -lt "$minimum_available_kib" ]; then

      validate_archive_paths
      for child in simulator archive; do
        if [ -d "$current_cache/$child" ]; then
          validate_archive_paths
          rm -rf -- "$current_cache/$child"
          trimmed_entries=$((trimmed_entries + 1))
        fi
      done
      after_kib="$(available_kib)"
    fi
    echo "Apple CI archive disk headroom: before_kib=$before_kib after_kib=$after_kib trimmed_entries=$trimmed_entries minimum_kib=$minimum_available_kib"
    [ "$after_kib" -ge "$minimum_available_kib" ] || fail_cache 'At least 20 GiB available on the HOME volume is required before archiving. Completed generated cache cleanup was insufficient; free runner disk space before retrying.'
    exit 0
  fi
  validate_cache_paths
  before_kib="$(available_kib)"
  trimmed_entries=0
  after_kib="$before_kib"
  if [ "$before_kib" -lt "$minimum_available_kib" ]; then


    validate_cache_paths
    for version in "$cache_root"/*; do
      [[ "${version##*/}" =~ ^[0-9a-f]{16}$ ]] || continue
      [ -d "$version" ] || continue
      for child in swift simulator archive; do
        if [ -d "$version/$child" ]; then
          [ ! -L "$cache_root" ] && [ ! -L "$version" ] && [ ! -L "$version/$child" ] || fail_cache 'Refusing symlinked generated cache path.'
          rm -rf -- "$version/$child"
          trimmed_entries=$((trimmed_entries + 1))
        fi
      done
    done
    after_kib="$(available_kib)"
  fi
  echo "Apple CI disk headroom: before_kib=$before_kib after_kib=$after_kib trimmed_entries=$trimmed_entries"
  [ "$after_kib" -ge "$minimum_available_kib" ] || fail_cache 'At least 12 GiB available on the HOME volume is required. Owned generated cache cleanup was insufficient; free runner disk space before retrying.'


  git clean -ffdx -e node_modules/
  export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
  echo "DEVELOPER_DIR=$DEVELOPER_DIR" >> "$GITHUB_ENV"
  gem_home="$HOME/.local/share/gems/ruby-3.3"
  mkdir -p "$gem_home"
  echo "GEM_HOME=$gem_home" >> "$GITHUB_ENV"
  echo "GEM_PATH=$gem_home" >> "$GITHUB_ENV"
  echo "$gem_home/bin" >> "$GITHUB_PATH"
fi


xcode_id="$(xcodebuild -version | shasum -a 256 | cut -c 1-16)"
cache_root="$cache_root/$xcode_id"
mkdir -p "$cache_root/swift" "$cache_root/simulator" "$cache_root/archive"
echo "MINDWTR_NATIVE_CACHE=$cache_root" >> "$GITHUB_ENV"
echo "MINDWTR_SWIFT_CACHE=$cache_root/swift" >> "$GITHUB_ENV"
echo 'LANG=en_US.UTF-8' >> "$GITHUB_ENV"
echo 'LC_ALL=en_US.UTF-8' >> "$GITHUB_ENV"
