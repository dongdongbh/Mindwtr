#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const FOSS_AUTOLINKING_EXCLUDES = ['play-store-updates', 'expo-store-review', 'gmail-authorization'];
const REMOVE_DEPS = ['expo-dev-client'];
const REMOVE_PATHS = ['modules/play-store-updates', 'modules/gmail-authorization'];

const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const ensureObjectProperty = (parent, key) => {
  if (!isPlainObject(parent[key])) {
    parent[key] = {};
  }
  return parent[key];
};

const ensureFossAutolinkingConfig = (expoConfig, enableExpoBuildFromSource) => {
  const changes = [];
  const autolinking = ensureObjectProperty(expoConfig, 'autolinking');
  const existingExclude = Array.isArray(autolinking.exclude)
    ? autolinking.exclude.filter((value) => typeof value === 'string')
    : [];
  const missingAutolinkingExcludes = FOSS_AUTOLINKING_EXCLUDES.filter((name) => !existingExclude.includes(name));
  if (missingAutolinkingExcludes.length > 0) {
    autolinking.exclude = [...existingExclude, ...missingAutolinkingExcludes];
    changes.push(`excluded ${missingAutolinkingExcludes.join(', ')} from Expo autolinking for F-Droid builds`);
  }

  if (enableExpoBuildFromSource) {
    const androidAutolinking = ensureObjectProperty(autolinking, 'android');
    const existingBuildFromSource = Array.isArray(androidAutolinking.buildFromSource)
      ? androidAutolinking.buildFromSource.filter((value) => typeof value === 'string')
      : [];

    if (!existingBuildFromSource.includes('.*')) {
      androidAutolinking.buildFromSource = [...existingBuildFromSource, '.*'];
      changes.push('enabled expo.autolinking.android.buildFromSource=[".*"]');
    }
  }

  return changes;
};

const applyPackageManifestChanges = (pkg, enableExpoBuildFromSource) => {
  const changes = [];

  for (const dep of REMOVE_DEPS) {
    if (pkg.dependencies && dep in pkg.dependencies) {
      delete pkg.dependencies[dep];
      changes.push(`removed dependency ${dep}`);
    }
    if (pkg.devDependencies && dep in pkg.devDependencies) {
      delete pkg.devDependencies[dep];
      changes.push(`removed devDependency ${dep}`);
    }
  }

  if (pkg.dependencies && pkg.dependencies['@mindwtr/core'] === 'workspace:*') {
    pkg.dependencies['@mindwtr/core'] = 'file:../../packages/core';
    changes.push('rewrote @mindwtr/core to file:../../packages/core for npm compatibility');
  }

  const expoConfig = ensureObjectProperty(pkg, 'expo');
  changes.push(...ensureFossAutolinkingConfig(expoConfig, enableExpoBuildFromSource));

  return changes;
};

const applyAppJsonManifestChanges = (appJson, enableExpoBuildFromSource) => {
  const expoConfig = ensureObjectProperty(appJson, 'expo');
  return ensureFossAutolinkingConfig(expoConfig, enableExpoBuildFromSource);
};

const removeFossOnlyPaths = (rootDir) => {
  const changes = [];
  for (const relativePath of REMOVE_PATHS) {
    const targetPath = path.join(rootDir, relativePath);
    if (!fs.existsSync(targetPath)) {
      continue;
    }
    fs.rmSync(targetPath, { recursive: true, force: true });
    changes.push(`removed ${relativePath}`);
  }
  return changes;
};

const readJson = (filePath) => JSON.parse(fs.readFileSync(filePath, 'utf8'));
const writeJson = (filePath, data) => fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`);

const run = () => {
  const pkgPath = path.join(__dirname, '..', 'package.json');
  const appJsonPath = path.join(__dirname, '..', 'app.json');
  const pkg = readJson(pkgPath);
  const appJson = readJson(appJsonPath);
  const enableExpoBuildFromSource =
    process.env.FDROID_EXPO_BUILD_FROM_SOURCE === '1' ||
    process.env.FDROID_EXPO_BUILD_FROM_SOURCE === 'true';

  const pkgChanges = applyPackageManifestChanges(pkg, enableExpoBuildFromSource);
  const appJsonChanges = applyAppJsonManifestChanges(appJson, enableExpoBuildFromSource);
  const pathChanges = removeFossOnlyPaths(path.join(__dirname, '..'));

  if (pkgChanges.length > 0) {
    writeJson(pkgPath, pkg);
  }

  if (appJsonChanges.length > 0) {
    writeJson(appJsonPath, appJson);
  }

  const changes = [
    ...pkgChanges.map((message) => `package.json: ${message}`),
    ...appJsonChanges.map((message) => `app.json: ${message}`),
    ...pathChanges.map((message) => `source: ${message}`),
  ];

  if (changes.length > 0) {
    console.log('[fdroid] applied changes:');
    changes.forEach((message) => console.log(`- ${message}`));
  } else {
    console.log('[fdroid] no deps to strip');
  }

  const coreDep = pkg.dependencies?.['@mindwtr/core'];
  if (typeof coreDep === 'string' && coreDep.startsWith('workspace:')) {
    throw new Error('[fdroid] @mindwtr/core still uses workspace:*; npm install will fail in non-workspace environments');
  }
};

if (require.main === module) {
  run();
}

module.exports = {
  applyPackageManifestChanges,
  __testables: {
    applyAppJsonManifestChanges,
    applyPackageManifestChanges,
    ensureFossAutolinkingConfig,
    removeFossOnlyPaths,
  },
};
