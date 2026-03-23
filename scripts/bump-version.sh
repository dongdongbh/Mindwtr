#!/usr/bin/env bash
# Version bump script for Mindwtr monorepo
# Usage: ./scripts/bump-version.sh 0.2.5
#        ./scripts/bump-version.sh  (prompts for version)

set -e

if [ -n "$1" ]; then
    NEW_VERSION="$1"
else
    echo "Current versions:"
    grep '"version"' package.json apps/*/package.json packages/*/package.json apps/mobile/app.json apps/desktop/src-tauri/tauri.conf.json 2>/dev/null | head -10
    echo ""
    read -p "Enter new version (e.g., 0.2.5): " NEW_VERSION
fi

if [ -z "$NEW_VERSION" ]; then
    echo "Error: Version cannot be empty"
    exit 1
fi

# Bump Android versionCode in apps/mobile/app.json
bump_android_version_code() {
    local app_json="apps/mobile/app.json"
    if [ ! -f "$app_json" ]; then
        echo "Warning: $app_json not found, skipping Android versionCode bump"
        return 0
    fi

    APP_JSON_PATH="$app_json" node - <<'NODE'
const fs = require('fs');
const path = require('path');

const appJsonPath = process.env.APP_JSON_PATH
  ? path.resolve(process.env.APP_JSON_PATH)
  : path.resolve(process.cwd(), 'apps/mobile/app.json');
const content = fs.readFileSync(appJsonPath, 'utf8');
const json = JSON.parse(content);

if (!json.expo) {
  console.warn('Warning: app.json has no "expo" object, skipping versionCode bump');
  process.exit(0);
}

const android = json.expo.android || {};
const current = Number(android.versionCode || 0);
const next = Number.isFinite(current) && current >= 1 ? current + 1 : 1;

json.expo.android = { ...android, versionCode: next };

fs.writeFileSync(appJsonPath, JSON.stringify(json, null, 2) + '\n');
console.log(`Bumped Android versionCode: ${current || 0} -> ${next}`);
NODE
}

# Use Node.js script for safe JSON updates
node scripts/update-versions.js "$NEW_VERSION"
bump_android_version_code

update_snapcraft() {
    local snapcraft_file="snap/snapcraft.yaml"
    if [ ! -f "$snapcraft_file" ]; then
        echo "Warning: $snapcraft_file not found, skipping Snapcraft updates"
        return 0
    fi

    SNAPCRAFT_FILE="$snapcraft_file" NEW_VERSION="$NEW_VERSION" node - <<'NODE'
const fs = require('fs');
const path = require('path');

const filePath = path.resolve(process.env.SNAPCRAFT_FILE);
const version = process.env.NEW_VERSION;
let content = fs.readFileSync(filePath, 'utf8');

content = content.replace(/^(version:\s*)['"]?[^'"\n]+['"]?/m, `$1'${version}'`);
content = content.replace(
  /^(\s*source:\s*).*/m,
  `$1apps/desktop/src-tauri/target/release/bundle/deb/mindwtr_${version}_amd64.deb`
);

fs.writeFileSync(filePath, content);
console.log(`Updated snapcraft.yaml to version ${version}`);
NODE
}

update_snapcraft

# Regenerate lockfile with new versions
echo ""
echo "Updating lockfile..."
bun install

echo ""
echo "Validating desktop package-lock metadata..."
if ! python3 scripts/ci/repair-package-lock.py --check apps/desktop/package-lock.json; then
    echo ""
    echo "Desktop package-lock.json is incomplete. Repair it before tagging with:"
    echo "  python3 scripts/ci/repair-package-lock.py apps/desktop/package-lock.json"
    exit 1
fi

echo ""
echo "Done! Now you can:"
echo "  git add -A"
echo "  git commit -m 'chore(release): v$NEW_VERSION'"
echo "  git tag v$NEW_VERSION"
echo "  git push origin main --tags"
