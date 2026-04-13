#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const pkgPath = path.join(__dirname, '..', 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
const enableExpoBuildFromSource =
  process.env.FDROID_EXPO_BUILD_FROM_SOURCE === '1' ||
  process.env.FDROID_EXPO_BUILD_FROM_SOURCE === 'true';

const removeDeps = ['expo-dev-client'];
let changed = false;
const changes = [];

for (const dep of removeDeps) {
  if (pkg.dependencies && dep in pkg.dependencies) {
    delete pkg.dependencies[dep];
    changed = true;
    changes.push(`removed dependency ${dep}`);
  }
  if (pkg.devDependencies && dep in pkg.devDependencies) {
    delete pkg.devDependencies[dep];
    changed = true;
    changes.push(`removed devDependency ${dep}`);
  }
}

if (pkg.dependencies && pkg.dependencies['@mindwtr/core'] === 'workspace:*') {
  pkg.dependencies['@mindwtr/core'] = 'file:../../packages/core';
  changed = true;
  changes.push('rewrote @mindwtr/core to file:../../packages/core for npm compatibility');
}

if (!pkg.expo || typeof pkg.expo !== 'object' || Array.isArray(pkg.expo)) {
  pkg.expo = {};
}
if (!pkg.expo.autolinking || typeof pkg.expo.autolinking !== 'object' || Array.isArray(pkg.expo.autolinking)) {
  pkg.expo.autolinking = {};
}
const existingExclude = Array.isArray(pkg.expo.autolinking.exclude)
  ? pkg.expo.autolinking.exclude.filter((value) => typeof value === 'string')
  : [];
if (!existingExclude.includes('play-store-updates')) {
  pkg.expo.autolinking.exclude = [...existingExclude, 'play-store-updates'];
  changed = true;
  changes.push('excluded play-store-updates from Expo autolinking for F-Droid builds');
}

if (enableExpoBuildFromSource) {
  if (
    !pkg.expo.autolinking.android ||
    typeof pkg.expo.autolinking.android !== 'object' ||
    Array.isArray(pkg.expo.autolinking.android)
  ) {
    pkg.expo.autolinking.android = {};
  }

  const existingBuildFromSource = Array.isArray(pkg.expo.autolinking.android.buildFromSource)
    ? pkg.expo.autolinking.android.buildFromSource.filter((value) => typeof value === 'string')
    : [];

  if (!existingBuildFromSource.includes('.*')) {
    pkg.expo.autolinking.android.buildFromSource = [...existingBuildFromSource, '.*'];
    changed = true;
    changes.push('enabled expo.autolinking.android.buildFromSource=[".*"]');
  }
}

if (changed) {
  fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
  console.log('[fdroid] applied changes:');
  changes.forEach((message) => console.log(`- ${message}`));
} else {
  console.log('[fdroid] no deps to strip');
}

const coreDep = pkg.dependencies?.['@mindwtr/core'];
if (typeof coreDep === 'string' && coreDep.startsWith('workspace:')) {
  throw new Error('[fdroid] @mindwtr/core still uses workspace:*; npm install will fail in non-workspace environments');
}
