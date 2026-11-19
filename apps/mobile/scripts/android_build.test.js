import { describe, expect, it } from 'vitest';

const fs = require('fs');
const path = require('path');

describe('android_build FOSS guards', () => {
  it('patches expo-application before prebuild and excludes Google service dependencies', () => {
    const source = fs.readFileSync(path.join(__dirname, 'android_build.sh'), 'utf8');

    expect(source.indexOf('node scripts/fdroid_patch_expo_application.js')).toBeGreaterThanOrEqual(0);
    expect(source.indexOf('node scripts/fdroid_patch_expo_application.js')).toBeLessThan(source.indexOf('npx expo prebuild'));
    expect(source.indexOf('DONATION_PROMPT_ENABLED="${DONATION_PROMPT_ENABLED:-true}"')).toBeLessThan(source.indexOf('npx expo prebuild'));
    expect(source.indexOf('FEEDBACK_ENDPOINT_URL="${FEEDBACK_ENDPOINT_URL:-https://feedback.mindwtr.app}"')).toBeLessThan(source.indexOf('npx expo prebuild'));
    expect(source).toContain("exclude group: 'com.android.installreferrer'");
    expect(source).toContain("exclude group: 'com.google.android.play'");
    expect(source).toContain("exclude group: 'com.google.android.gms'");
    expect(source).toContain("exclude group: 'com.google.firebase'");
  });

  it('defaults F-Droid prep to Expo source builds instead of local Maven AARs', () => {
    const source = fs.readFileSync(path.join(__dirname, 'fdroid_prep.sh'), 'utf8');

    expect(source).toContain('FDROID_EXPO_BUILD_FROM_SOURCE="${FDROID_EXPO_BUILD_FROM_SOURCE:-1}"');
  });

  it('applies npm dependency patches between Expo prebuild and Gradle', () => {
    const source = fs.readFileSync(path.join(__dirname, 'android_build.sh'), 'utf8');
    const patchCommand = 'bash "${REPO_ROOT}/scripts/ci/apply_bun_patches.sh" "${ROOT_DIR}/node_modules"';

    expect(source.indexOf(patchCommand)).toBeGreaterThan(source.indexOf('npx expo prebuild'));
    expect(source.indexOf(patchCommand)).toBeLessThan(source.indexOf('./gradlew assembleRelease'));
  });
});
