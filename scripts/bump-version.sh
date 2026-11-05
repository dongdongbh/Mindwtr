#!/usr/bin/env bash


set -e

INPUT_VERSION="${1:-}"

if [ -z "$INPUT_VERSION" ]; then
    echo "Current versions:"
    grep '"version"' package.json apps/desktop/package.json apps/mobile/package.json apps/cloud/package.json packages/*/package.json apps/mobile/app.json apps/desktop/src-tauri/tauri.conf.json 2>/dev/null | head -10
    echo ""
    read -p "Enter new version or RC tag (e.g., 0.2.5 or v1.0.5-rc.1): " INPUT_VERSION
fi

if [ -z "$INPUT_VERSION" ]; then
    echo "Error: Version cannot be empty"
    exit 1
fi

IS_RC=0
RELEASE_TAG=""
NEW_VERSION=""

if [[ "$INPUT_VERSION" =~ ^v?([0-9]+)\.([0-9]+)\.([0-9]+)-rc\.([0-9]+)$ ]]; then
    NEW_VERSION="${BASH_REMATCH[1]}.${BASH_REMATCH[2]}.${BASH_REMATCH[3]}"
    RELEASE_TAG="v${NEW_VERSION}-rc.${BASH_REMATCH[4]}"
    IS_RC=1
    echo "Detected release candidate tag ${RELEASE_TAG}; app/package versions will use stable base ${NEW_VERSION}."
elif [[ "$INPUT_VERSION" =~ ^v?([0-9]+)\.([0-9]+)\.([0-9]+)$ ]]; then
    NEW_VERSION="${BASH_REMATCH[1]}.${BASH_REMATCH[2]}.${BASH_REMATCH[3]}"
    RELEASE_TAG="v${NEW_VERSION}"
else
    echo "Error: Version must be x.y.z or an RC tag like v1.0.5-rc.1"
    exit 1
fi


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

    if [ -n "${ANDROID_REMOTE_MAX_VERSION_CODE:-}" ]; then
        echo "Ensuring Android versionCode is above Google Play max ${ANDROID_REMOTE_MAX_VERSION_CODE}..."
        REMOTE_MAX_VERSION_CODE="${ANDROID_REMOTE_MAX_VERSION_CODE}" \
            AUTO_BUMP_APP_JSON_VERSION_CODE=1 \
            WRITE_APP_JSON=1 \
            node scripts/ci/android-version-code-policy.js
    fi
}


node scripts/update-versions.js "$NEW_VERSION"
bump_android_version_code


printf '{\n  "releaseVersion": "%s"\n}\n' "${RELEASE_TAG#v}" > apps/mobile/release-version.json
echo "Updated apps/mobile/release-version.json to ${RELEASE_TAG#v}"

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


echo ""
echo "Updating lockfile..."
bun install

echo ""
echo "Validating core package.json/package-lock sync..."
if ! node scripts/ci/check-package-lock-sync.js packages/core/package.json packages/core/package-lock.json; then
    echo ""
    echo "Core package-lock.json does not match packages/core/package.json."
    echo "Repair it before tagging with:"
    echo "  npm install --package-lock-only --prefix packages/core --legacy-peer-deps --workspaces=false"
    exit 1
fi

echo ""
echo "Validating desktop package.json/package-lock sync..."
if ! node scripts/ci/check-package-lock-sync.js apps/desktop/package.json apps/desktop/package-lock.json; then
    echo ""
    echo "Desktop package-lock.json does not match apps/desktop/package.json."
    echo "Repair it before tagging with:"
    echo "  npm install --package-lock-only --prefix apps/desktop --legacy-peer-deps --workspaces=false"
    exit 1
fi

echo ""
echo "Validating desktop package-lock metadata..."
if ! python3 scripts/ci/repair-package-lock.py --check apps/desktop/package-lock.json; then
    echo ""
    echo "Desktop package-lock.json is incomplete. Repair it before tagging with:"
    echo "  python3 scripts/ci/repair-package-lock.py apps/desktop/package-lock.json"
    exit 1
fi

echo ""
echo "Validating mobile FOSS package-lock sync..."
if ! node scripts/ci/check-mobile-foss-lock-sync.js; then
    echo ""
    echo "Mobile FOSS package-lock.json does not match the FOSS dependency manifest."
    echo "Repair it before tagging with:"
    echo "  cp apps/mobile/package.json /tmp/mindwtr-mobile-package.json.bak"
    echo "  bash apps/mobile/scripts/fdroid_prep.sh"
    echo "  npm install --package-lock-only --prefix apps/mobile --legacy-peer-deps --workspaces=false"
    echo "  cp /tmp/mindwtr-mobile-package.json.bak apps/mobile/package.json"
    exit 1
fi

echo ""
echo "Done! Now you can:"
echo "  git add -A"
echo "  git commit -m 'chore(release): ${RELEASE_TAG}'"
echo "  git tag -a ${RELEASE_TAG} -m '${RELEASE_TAG}'"
echo "  git push origin main ${RELEASE_TAG}"
