import { describe, expect, it } from 'vitest';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { __testables } = require('./fdroid_strip_deps');

const {
  applyAppJsonManifestChanges,
  applyPackageManifestChanges,
  removeFossOnlyPaths,
} = __testables;

describe('fdroid_strip_deps', () => {
  it('strips non-FOSS package dependencies and keeps npm-compatible workspace deps', () => {
    const pkg = {
      dependencies: {
        '@mindwtr/core': 'workspace:*',
        'expo-dev-client': '~6.0.21',
      },
      devDependencies: {
        'expo-dev-client': '~6.0.21',
      },
      expo: {
        doctor: {
          reactNativeDirectoryCheck: {},
        },
      },
    };

    const changes = applyPackageManifestChanges(pkg, false);

    expect(pkg.dependencies).not.toHaveProperty('expo-dev-client');
    expect(pkg.devDependencies).not.toHaveProperty('expo-dev-client');
    expect(pkg.dependencies['@mindwtr/core']).toBe('file:../../packages/core');
    expect(pkg.expo.doctor).toEqual({ reactNativeDirectoryCheck: {} });
    expect(pkg.expo.autolinking.exclude).toEqual(['play-store-updates', 'expo-store-review', 'gmail-authorization']);
    expect(changes).toContain('removed dependency expo-dev-client');
    expect(changes).toContain('rewrote @mindwtr/core to file:../../packages/core for npm compatibility');
  });

  it('writes FOSS autolinking excludes to app.json Expo config used by prebuild', () => {
    const appJson = {
      expo: {
        name: 'Mindwtr',
        autolinking: {
          exclude: ['existing-native-module'],
        },
      },
    };

    const changes = applyAppJsonManifestChanges(appJson, true);

    expect(appJson.expo.autolinking.exclude).toEqual([
      'existing-native-module',
      'play-store-updates',
      'expo-store-review',
      'gmail-authorization',
    ]);
    expect(appJson.expo.autolinking.android.buildFromSource).toEqual(['.*']);
    expect(changes).toEqual([
      'excluded play-store-updates, expo-store-review, gmail-authorization from Expo autolinking for F-Droid builds',
      'enabled expo.autolinking.android.buildFromSource=[".*"]',
    ]);
  });

  it('removes Google-backed native module sources from the F-Droid prep tree', () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mindwtr-fdroid-strip-'));
    const moduleDir = path.join(rootDir, 'modules', 'play-store-updates', 'android');
    fs.mkdirSync(moduleDir, { recursive: true });
    fs.writeFileSync(
      path.join(moduleDir, 'build.gradle'),
      'dependencies { implementation("com.google.android.play:app-update:2.1.0") }\n'
    );
    const gmailDir = path.join(rootDir, 'modules', 'gmail-authorization', 'android');
    fs.mkdirSync(gmailDir, { recursive: true });
    fs.writeFileSync(path.join(gmailDir, 'build.gradle'), 'implementation "com.google.android.gms:play-services-auth:22.0.0"');

    const changes = removeFossOnlyPaths(rootDir);

    expect(fs.existsSync(path.join(rootDir, 'modules', 'play-store-updates'))).toBe(false);
    expect(fs.existsSync(path.join(rootDir, 'modules', 'gmail-authorization'))).toBe(false);
    expect(changes).toEqual(['removed modules/play-store-updates', 'removed modules/gmail-authorization']);

    fs.rmSync(rootDir, { recursive: true, force: true });
  });
});
