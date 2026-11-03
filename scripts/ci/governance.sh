#!/usr/bin/env bash


set -euo pipefail

skipped=()


run() {
  local name="$1"
  shift
  local tool
  while [ "$1" != "--" ]; do
    tool="$1"
    shift
    if ! command -v "$tool" >/dev/null 2>&1; then
      if [ -n "${CI:-}" ]; then
        echo "::error::$name needs $tool, which is not installed" >&2
        exit 1
      fi
      echo "SKIP $name: $tool is not installed" >&2
      skipped+=("$name")
      return 0
    fi
  done
  shift
  echo "==> $name"
  "$@"
}

main() {
  cd "$(dirname "${BASH_SOURCE[0]}")/../.."
  run "Locale parity check" bun -- bun run i18n:check
  run "Ubuntu APT preparation regression tests" python3 -- python3 scripts/ci/prepare-ubuntu-apt.test.py
  run "Apple output cleanup regression tests" python3 -- python3 -m unittest discover -s scripts/ci -p test_cleanup_apple_outputs.py
  run "Merged worktree cleanup regression tests" python3 -- python3 -m unittest discover -s scripts/maintenance -p test_cleanup_merged_worktrees.py
  run "Schema and release workflow governance checks" bun python3 -- bun run test:governance
  run "README heading parity check" bun -- bun run docs:check-readme
  run "Store image asset check" file -- bash scripts/ci/validate-store-image-assets.sh
  run "AppStream metainfo locale check" python3 -- python3 scripts/ci/validate-appstream-locales.py
  run "Workflow JSON newline check" node -- node scripts/ci/validate-workflow-json-newlines.js
  package_lock_sync() {
    node scripts/ci/check-package-lock-sync.js packages/core/package.json packages/core/package-lock.json --check-overrides
    node scripts/ci/check-package-lock-sync.js apps/desktop/package.json apps/desktop/package-lock.json --check-overrides
    node scripts/ci/check-mobile-foss-lock-sync.js
  }
  run "Package-lock override sync check" node -- package_lock_sync
  run "EAS CLI lock install check" npm -- npm ci --prefix tools/eas-cli --ignore-scripts --legacy-peer-deps --dry-run
  play_listing_metadata() {
    python3 scripts/ci/prepare-google-play-listing-metadata.test.py
    python3 scripts/ci/prepare-google-play-listing-metadata.py \
      metadata \
      "${TMPDIR:-/tmp}/mindwtr-play-listing-metadata.json"
  }
  run "Google Play listing metadata check" python3 -- play_listing_metadata
  run "Store changelog length check" node -- node scripts/ci/check-changelog-length.js
  app_store_metadata() {
    python3 scripts/ci/validate-fastlane-metadata.test.py
    python3 scripts/ci/validate-watch-bundle.test.py
    python3 scripts/ci/validate-macos-private-apis.test.py
    FASTLANE_METADATA_DIR="${TMPDIR:-/tmp}/mindwtr-fastlane-metadata" scripts/ci/prepare-fastlane-metadata.sh
  }
  run "App Store listing metadata check" python3 -- app_store_metadata
  run "iOS App Intents availability check" node -- node scripts/ci/validate-ios-app-intents-availability.js
  run "Apple property list syntax check" python3 git -- python3 scripts/ci/validate-apple-plists.py

  if [ "${#skipped[@]}" -gt 0 ]; then
    echo "Governance passed with ${#skipped[@]} check(s) skipped for missing tools: ${skipped[*]}" >&2
  fi
}


if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  main "$@"
fi
