#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

process.on('uncaughtException', (error) => {
  console.error(`::error::${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});

const truthy = (value) => ['1', 'true', 'yes', 'on'].includes(String(value ?? '').toLowerCase());

const parseInteger = (label, raw, { allowEmpty = false, min = 1 } = {}) => {
  const value = String(raw ?? '').trim();
  if (!value) {
    if (allowEmpty) return null;
    throw new Error(`Missing ${label}`);
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min) {
    throw new Error(`Invalid ${label}: ${value}`);
  }
  return parsed;
};

const appJsonPath = path.resolve(process.env.APP_JSON_PATH || 'apps/mobile/app.json');
const appJson = JSON.parse(fs.readFileSync(appJsonPath, 'utf8'));
const localCode = parseInteger('expo.android.versionCode in apps/mobile/app.json', appJson.expo?.android?.versionCode);
const requestedCode = parseInteger('requested Android versionCode', process.env.REQUESTED_VERSION_CODE, { allowEmpty: true });
const allowUntracked = truthy(process.env.ALLOW_UNTRACKED_VERSION_CODE);
const writeAppJson = truthy(process.env.WRITE_APP_JSON);
const autoBumpAppJson = truthy(process.env.AUTO_BUMP_APP_JSON_VERSION_CODE);
const client = String(process.env.ANDROID_CLIENT || 'rn').trim();

const NATIVE_RC_LEAD = 15;
const RELEASE_VERSION = String.raw`\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?`;
const NATIVE_RELEASE_NAME = new RegExp(`^${RELEASE_VERSION} native testing$`);
const REACT_NATIVE_RELEASE_NAMES = [
  new RegExp(`^${RELEASE_VERSION}$`),
  new RegExp(`^${RELEASE_VERSION} testing$`),
  new RegExp(`^${RELEASE_VERSION} stable [a-z]+$`),
  new RegExp(`^${RELEASE_VERSION} release candidate$`),
  new RegExp(`^${RELEASE_VERSION} internal diagnostic \\d+$`),
  new RegExp(`^${RELEASE_VERSION} \\(internal\\)$`),
];
const PLAY_MAX_VERSION_CODE = 2_100_000_000;

const playReleases = process.env.PLAY_RELEASES_FILE
  ? JSON.parse(fs.readFileSync(process.env.PLAY_RELEASES_FILE, 'utf8')).releases ?? []
  : [];
const codesOf = (releases) => releases.flatMap((release) => (release.versionCodes ?? [])
  .map((code) => parseInteger(`Google Play versionCode on ${release.track}`, code)));
const productionMaxCode = Math.max(0, ...codesOf(playReleases.filter((release) => release.track === 'production')));
const releaseKind = (release) => {
  const name = String(release.name ?? '').trim();
  if (release.track === 'production') return 'rn';
  if (NATIVE_RELEASE_NAME.test(name)) return 'native';
  if (REACT_NATIVE_RELEASE_NAMES.some((pattern) => pattern.test(name))) return 'rn';
  if (codesOf([release]).every((code) => code <= productionMaxCode)) return 'ignored';
  throw new Error(
    `Google Play ${release.track} holds release '${name}' (versionCodes ${(release.versionCodes ?? []).join(', ')}) above production `
    + `${productionMaxCode}. Its name is neither a native release candidate ('<version> native testing') nor a known React Native release, `
    + `so the versionCode policy will not guess whether it is native. Rename or replace it in Play Console.`
  );
};
const releasesOfKind = (kind) => playReleases.filter((release) => releaseKind(release) === kind);
const nativeMaxCode = Math.max(0, ...codesOf(releasesOfKind('native')));
const remoteMaxCode = Math.max(
  parseInteger('remote Android versionCode maximum', process.env.REMOTE_MAX_VERSION_CODE || '0', { min: 0 }),
  ...codesOf(releasesOfKind('rn')),
);
const playMaxCode = Math.max(remoteMaxCode, nativeMaxCode);

if (!['rn', 'native'].includes(client)) {
  throw new Error(`ANDROID_CLIENT must be rn or native, got ${client}`);
}

if (client === 'native') {
  if (writeAppJson) {
    throw new Error('Native release candidate versionCodes are never written to apps/mobile/app.json, which tracks the React Native code.');
  }
  const reactNativeCode = Math.max(remoteMaxCode, localCode);
  const minimumCode = Math.max(reactNativeCode + NATIVE_RC_LEAD, playMaxCode + 1);
  const resolvedCode = requestedCode ?? minimumCode;
  if (resolvedCode < minimumCode) {
    throw new Error(
      `Native release candidate versionCode ${resolvedCode} must be at least ${minimumCode}: `
      + `${NATIVE_RC_LEAD} above the React Native code ${reactNativeCode} and above every Google Play code (highest ${playMaxCode}).`
    );
  }
  if (resolvedCode > PLAY_MAX_VERSION_CODE) {
    throw new Error(`Native versionCode ${resolvedCode} exceeds Google Play's limit ${PLAY_MAX_VERSION_CODE}.`);
  }
  const output = process.env.GITHUB_OUTPUT;
  if (output) {
    fs.appendFileSync(output, `local_code=${localCode}\n`);
    fs.appendFileSync(output, `remote_max_code=${playMaxCode}\n`);
    fs.appendFileSync(output, `resolved_code=${resolvedCode}\n`);
  }
  console.log(`Resolved native release candidate versionCode ${resolvedCode} (React Native ${reactNativeCode} + ${NATIVE_RC_LEAD}, Google Play max ${playMaxCode}).`);
  process.exit(0);
}

let resolvedCode = requestedCode ?? localCode;

if (requestedCode !== null && !allowUntracked && requestedCode !== localCode) {
  throw new Error(
    `Stable Android release builds must use the git-tracked versionCode from apps/mobile/app.json. `
    + `Requested ${requestedCode}, but app.json has ${localCode}. Bump apps/mobile/app.json before tagging instead of overriding versionCode in CI.`
  );
}

if (requestedCode === null && remoteMaxCode >= localCode) {
  if (writeAppJson && autoBumpAppJson) {
    resolvedCode = remoteMaxCode + 1;
    console.log(
      `Google Play already has versionCode ${remoteMaxCode}; bumping app.json to tracked versionCode ${resolvedCode}.`
    );
  } else if (!allowUntracked) {
    throw new Error(
      `Google Play already has Android versionCode ${remoteMaxCode}, but apps/mobile/app.json has ${localCode}. `
      + `Stable release artifacts must be reproducible from the tag, so bump apps/mobile/app.json above ${remoteMaxCode} before tagging. `
      + `Release prep can do this with ANDROID_REMOTE_MAX_VERSION_CODE=${remoteMaxCode} ./scripts/bump-version.sh <version>.`
    );
  } else {
    resolvedCode = remoteMaxCode + 1;
    console.log(`Google Play already has versionCode ${remoteMaxCode}; using generated versionCode ${resolvedCode} for this non-stable build.`);
  }
} else if (requestedCode === null) {
  console.log(`versionCode ok: local ${localCode} > store ${remoteMaxCode}`);
}

if (nativeMaxCode > 0 && resolvedCode >= nativeMaxCode) {
  throw new Error(
    `React Native versionCode ${resolvedCode} would reach the native release candidate ${nativeMaxCode} on Google Play, `
    + `which would move release candidate testers back to React Native. Cut a new native release candidate first.`
  );
}

if (writeAppJson) {
  appJson.expo = appJson.expo || {};
  appJson.expo.android = appJson.expo.android || {};
  const previousCode = appJson.expo.android.versionCode;
  if (previousCode !== resolvedCode) {
    appJson.expo.android.versionCode = resolvedCode;
    fs.writeFileSync(appJsonPath, `${JSON.stringify(appJson, null, 2)}\n`);
    console.log(`Android versionCode: ${previousCode} -> ${resolvedCode}`);
  } else {
    console.log(`Android versionCode already matches app.json: ${resolvedCode}`);
  }
}

const output = process.env.GITHUB_OUTPUT;
if (output) {
  fs.appendFileSync(output, `local_code=${localCode}\n`);
  fs.appendFileSync(output, `remote_max_code=${remoteMaxCode}\n`);
  fs.appendFileSync(output, `resolved_code=${resolvedCode}\n`);
}

console.log(`Resolved Android versionCode ${resolvedCode} (local ${localCode}, remote max ${remoteMaxCode}, untracked allowed: ${allowUntracked ? 'yes' : 'no'}).`);
