#!/bin/bash
set -euo pipefail

cd "${CI_PRIMARY_REPOSITORY_PATH:?Xcode Cloud must provide the repository path}"
export CI=1 EXPO_NO_TELEMETRY=1
export LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8
export HOMEBREW_NO_AUTO_UPDATE=1 HOMEBREW_NO_INSTALL_CLEANUP=1


if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" != 22 ]; then
  brew install node@22
  export PATH="$(brew --prefix node@22)/bin:$PATH"
fi
export BUN_INSTALL="$HOME/.cache/mindwtr-xcode-cloud/bun"
export PATH="$BUN_INSTALL/bin:$PATH"
bun_version="$(tr -d '[:space:]' < .bun-version)"
if [ ! -x "$BUN_INSTALL/bin/bun" ] || [ "$("$BUN_INSTALL/bin/bun" --version)" != "$bun_version" ]; then
  curl --fail --silent --show-error --location https://bun.sh/install | bash -s -- "bun-v$bun_version"
fi

export APP_VARIANT=production
export MINDWTR_WATCH_ENABLED="${MINDWTR_WATCH_ENABLED:-false}"
export FEEDBACK_ENDPOINT_URL="${FEEDBACK_ENDPOINT_URL:-https://feedback.mindwtr.app}"
export DONATION_PROMPT_ENABLED="${DONATION_PROMPT_ENABLED:-true}"

bun install --frozen-lockfile
node scripts/ci/validate-ios-app-intents-availability.js
cd apps/mobile
npx --no-install expo prebuild --platform ios --non-interactive --no-install


git restore --source=HEAD --worktree -- ios/ci_scripts


printf 'export NODE_BINARY="%s"\nexport PATH="%s:$PATH"\n' \
  "$(command -v node)" "$(dirname "$(command -v node)")" > ios/.xcode.env.local

cd ios
pod install
test -f Mindwtr.xcworkspace/contents.xcworkspacedata
test -f Mindwtr.xcodeproj/xcshareddata/xcschemes/Mindwtr.xcscheme
echo 'Xcode Cloud bootstrap complete: Mindwtr workspace and shared scheme are ready.'
