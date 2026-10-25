// Builds the four APKs of the Android upgrade harness. All four are package
// tech.dongdongbh.mindwtr.upgradetest and all are signed with one harness key,
// so `adb install -r` upgrades each over the other in place:
//
//   152  the real RN app from tag v1.3.2 (release build, embedded Hermes bundle)
//   153  this worktree's native app, build type `upgradetest`
//   154  RN recovery, built from RECOVERY_COMMIT with only versionCode raised
//   155  RN with its Pomodoro alarm re-arm fix (45dff1573), built from RN_FIX_COMMIT the same way
//   151  with --parity-rn[=<rev>]: RN at <rev> (default HEAD), the RN side of capture-parity-screens' pairs
//
//   node apps/android-native/scripts/build-upgrade-harness.mjs [--rebuild-rn] [--parity-rn[=<rev>]]
//
// Each RN build comes from a `git archive` of its pinned commit in a throwaway
// folder under $MINDWTR_HARNESS_DIR (default /home/dd/.mindwtr-harness). Only
// upgradetest-rn-identity.patch changes it (upgradetest-rn-identity-155.patch, the same change, for RN_FIX_COMMIT's app.config.ts). apps/mobile/scripts/android_build.sh,
// the release build script, prepares it (`--prep-only`), Gradle builds it with
// the wanted versionCode, and then the folder is deleted. Dependencies are a link
// farm into this checkout's node_modules, with @mindwtr/core pointing at the
// commit's own core. Signed RN APKs are cached by source commit and patch hash,
// so a rerun rebuilds only the native APK. The harness key is created once
// in the harness folder and never committed. Writes apks/manifest.json for
// check-upgrade-device.mjs.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const PKG = 'tech.dongdongbh.mindwtr.upgradetest';
const TAG = 'v1.3.2';
const V132 = 'ee82a9e3e9a1d4e0c406f5ffff80e768a1f1f812';
// The RN 154 recovery source: the first main commit whose startup writers wait
// for the canonical SQLite load (df495e076). v1.3.2 itself runs its first session
// on a stale AsyncStorage snapshot and hides native edits. The identity patch
// must still apply to it.
const RECOVERY_COMMIT = 'df495e07691b71657932cf7bb406121c3e89d703';
// The RN 155 source: a main commit with RN's Pomodoro alarm re-arm fix (45dff1573), for the upgrade check's RN-over-native
// mid-phase scenario (9c). Its bun.lock must equal this checkout's, as RECOVERY_COMMIT's.
const RN_FIX_COMMIT = '101f81ee1abb5daf6c9504b14217785cd7db4e51';
const repo = resolve(import.meta.dirname, '../../..');
const home = process.env.MINDWTR_HARNESS_DIR ?? '/home/dd/.mindwtr-harness';
const sdk = '/home/dd/Android/Sdk';
const aapt2 = `${sdk}/build-tools/36.1.0/aapt2`;
const apksigner = `${sdk}/build-tools/36.1.0/apksigner`;
const keystore = resolve(home, 'upgradetest.keystore');
// A throwaway key for a throwaway package: it signs nothing a user installs.
const ALIAS = 'upgradetest';
const STORE_SECRET = 'mindwtr-upgradetest-harness';
const apks = resolve(home, 'apks');
const patch = resolve(import.meta.dirname, 'upgradetest-rn-identity.patch');
// The same identity change, for RN_FIX_COMMIT's app.config.ts (the Gmail lines moved the first patch's context).
const patchFix = resolve(import.meta.dirname, 'upgradetest-rn-identity-155.patch');
const env = { ...process.env, ANDROID_HOME: sdk, ANDROID_SDK_ROOT: sdk, TMPDIR: resolve(home, 'tmp') };

const run = (command, args, options = {}) => execFileSync(command, args, { stdio: 'inherit', env, ...options });
const out = (command, args, options = {}) => execFileSync(command, args, { encoding: 'utf8', env, maxBuffer: 64 << 20, ...options }).trim();
const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
const fail = (message) => { throw new Error(message); };

const sign = (input, output) => {
    rmSync(output, { force: true });
    rmSync(`${output}.idsig`, { force: true });
    // No v4 .idsig beside the APK: adb would then try an incremental install.
    run(apksigner, ['sign', '--ks', keystore, '--ks-pass', `pass:${STORE_SECRET}`, '--ks-key-alias', ALIAS,
        '--v4-signing-enabled', 'false', '--out', output, input]);
};

// Every top-level entry except `skip`, as a symlink to its real path.
const linkFarm = (from, to, skip) => {
    mkdirSync(to, { recursive: true });
    for (const name of readdirSync(from)) {
        if (name !== skip) symlinkSync(realpathSync(resolve(from, name)), resolve(to, name));
    }
};

const patchId = sha256(patch).slice(0, 12);
// --parity-rn[=<rev>]: also the RN app at <rev> (default this checkout's HEAD; versionCode 151, below the native 153 installed
// over it), the RN side of capture-parity-screens' pairs, so they compare with today's RN rather than RN 154's older source.
const parityArg = process.argv.find((arg) => arg === '--parity-rn' || arg.startsWith('--parity-rn='));
const parityCommit = parityArg ? out('git', ['-C', repo, 'rev-parse', `${parityArg.split('=')[1] ?? 'HEAD'}^{commit}`]) : null;
const patchFor = (commit) => (commit === RN_FIX_COMMIT || commit === parityCommit ? patchFix : patch);
const rnApk = (commit, code) => resolve(apks, `rn-${commit.slice(0, 12)}-${sha256(patchFor(commit)).slice(0, 12)}-${code}.apk`);

const checkRnIdentity = (mobile) => {
    const manifest = readFileSync(resolve(mobile, 'android/app/src/main/AndroidManifest.xml'), 'utf8');
    const main = /<activity android:name="\.MainActivity"[\s\S]*?<\/activity>/.exec(manifest)?.[0] ?? fail('no MainActivity in the RN manifest');
    if (!/<application [^>]*android:debuggable="true"/.test(manifest)) fail('RN manifest is not debuggable (adb run-as needs it)');
    if (main.includes('android:scheme="mindwtr"')) fail('RN MainActivity still catches mindwtr:// links');
    if (!main.includes('android:scheme="mindwtr-upgradetest"')) fail('RN MainActivity lacks the mindwtr-upgradetest scheme');
};

// Builds one APK per versionCode from one source commit.
const buildRn = (commit, versionCodes) => {
    // The link farm is this checkout's node_modules: the source must pin the same dependencies.
    if (out('git', ['-C', repo, 'show', `${commit}:bun.lock`]) !== readFileSync(resolve(repo, 'bun.lock'), 'utf8').trim()) {
        fail(`bun.lock at ${commit} differs from this checkout; the node_modules link farm would not match it`);
    }
    const src = resolve(home, `rn-src-${commit.slice(0, 12)}`);
    // Metro caches transforms by real path. expo-router's route context lives in the
    // shared link farm and bakes in this archive's app path, so a cache left by another
    // archive points at a deleted folder and the app crashes with "No routes found".
    for (const name of readdirSync(env.TMPDIR)) {
        if (name.startsWith('metro-')) rmSync(resolve(env.TMPDIR, name), { recursive: true, force: true });
    }
    rmSync(src, { recursive: true, force: true });
    mkdirSync(src, { recursive: true });
    try {
        execFileSync('bash', ['-c', 'git -C "$1" archive "$2" | tar -x -C "$3"', 'archive', repo, commit, src], { stdio: 'inherit' });
        linkFarm(resolve(repo, 'node_modules'), resolve(src, 'node_modules'), '@mindwtr');
        mkdirSync(resolve(src, 'node_modules/@mindwtr'));
        symlinkSync('../../packages/core', resolve(src, 'node_modules/@mindwtr/core'));
        linkFarm(resolve(repo, 'apps/mobile/node_modules'), resolve(src, 'apps/mobile/node_modules'));
        run('git', ['apply', '--verbose', patchFor(commit)], { cwd: src });
        const mobile = resolve(src, 'apps/mobile');
        // APP_VARIANT must also reach Gradle: expo-constants reads app.config.ts again there
        // and embeds it, and the running app reads its analytics URL from that copy.
        const rnEnv = { ...env, APP_VARIANT: 'upgradetest', ARCHS: 'arm64-v8a', CI: '1' };
        run('bash', ['scripts/android_build.sh', '--prep-only'], { cwd: mobile, env: rnEnv });
        checkRnIdentity(mobile);
        const gradleFile = resolve(mobile, 'android/app/build.gradle');
        for (const versionCode of versionCodes) {
            const gradle = readFileSync(gradleFile, 'utf8');
            if ((gradle.match(/^ {8}versionCode \d+$/gm) ?? []).length !== 1) fail('expected exactly one versionCode line in the RN build.gradle');
            writeFileSync(gradleFile, gradle.replace(/^ {8}versionCode \d+$/m, `        versionCode ${versionCode}`));
            // The same Gradle call android_build.sh makes after its preparation.
            run('./gradlew', ['assembleRelease', '-PreactNativeArchitectures=arm64-v8a'], {
                cwd: resolve(mobile, 'android'),
                env: { ...rnEnv, NODE_OPTIONS: process.env.NODE_OPTIONS ?? '--max-old-space-size=6144' },
            });
            sign(resolve(mobile, 'android/app/build/outputs/apk/release/app-arm64-v8a-release.apk'), rnApk(commit, versionCode));
        }
    } finally {
        rmSync(src, { recursive: true, force: true });
    }
};

const describe = (apk, versionCode, rn) => {
    if (out(aapt2, ['dump', 'packagename', apk]) !== PKG) fail(`${apk} is not ${PKG}`);
    const badging = out(aapt2, ['dump', 'badging', apk]);
    if (!badging.includes(`package: name='${PKG}' versionCode='${versionCode}'`)) fail(`${apk} is not versionCode ${versionCode}`);
    if (!badging.includes('application-debuggable')) fail(`${apk} is not debuggable (adb run-as needs it)`);
    if (rn) {
        const config = JSON.parse(out('unzip', ['-p', apk, 'assets/app.config']));
        if (config.scheme !== 'mindwtr-upgradetest' || config.android?.package !== PKG
            || config.extra?.analyticsHeartbeatUrl !== '' || config.extra?.feedbackEndpointUrl !== '') {
            fail(`${apk} embeds a non-harness app config (scheme, package, analytics or feedback endpoint)`);
        }
    }
    const certs = out(apksigner, ['verify', '--print-certs', apk]);
    const signer = /certificate SHA-256 digest: ([0-9a-f]{64})/.exec(certs)?.[1] ?? fail(`${apk} has no signer`);
    console.log(`\n${apk}\n${certs}`);
    return { path: apk, sha256: sha256(apk), versionCode, signer };
};

try {
    mkdirSync(apks, { recursive: true });
    mkdirSync(env.TMPDIR, { recursive: true });
    if (!existsSync(keystore)) {
        run('keytool', ['-genkeypair', '-keystore', keystore, '-storetype', 'PKCS12', '-storepass', STORE_SECRET,
            '-alias', ALIAS, '-keyalg', 'RSA', '-keysize', '3072', '-validity', '10000', '-dname', 'CN=Mindwtr upgrade harness']);
    }
    const tagCommit = out('git', ['-C', repo, 'rev-parse', `${TAG}^{commit}`]);
    if (tagCommit !== V132) fail(`${TAG} resolves to ${tagCommit}, not the pinned ${V132}`);
    const wanted = [[V132, 152], [RECOVERY_COMMIT, 154], [RN_FIX_COMMIT, 155], ...(parityCommit ? [[parityCommit, 151]] : [])]
        .filter(([commit, code]) => process.argv.includes('--rebuild-rn') || !existsSync(rnApk(commit, code)));
    for (const commit of new Set(wanted.map(([source]) => source))) {
        buildRn(commit, wanted.filter(([source]) => source === commit).map(([, code]) => code));
    }
    if (wanted.length === 0) console.log(`RN APKs cached for ${V132.slice(0, 12)}, ${RECOVERY_COMMIT.slice(0, 12)} and ${RN_FIX_COMMIT.slice(0, 12)} / patch ${patchId}`);

    const nativeDir = resolve(repo, 'apps/android-native/android');
    run('./gradlew', [':app:assemblePlayUpgradetest', '--offline'], { cwd: nativeDir });
    const nativeApk = resolve(apks, 'native-upgradetest-153.apk');
    sign(resolve(nativeDir, 'app/build/outputs/apk/play/upgradetest/app-play-upgradetest.apk'), nativeApk);

    const result = {
        package: PKG,
        rnSource: V132,
        recoverySource: RECOVERY_COMMIT,
        rn152: describe(rnApk(V132, 152), 152, true),
        native153: describe(nativeApk, 153, false),
        rn154: describe(rnApk(RECOVERY_COMMIT, 154), 154, true),
        rnFixSource: RN_FIX_COMMIT,
        rn155: describe(rnApk(RN_FIX_COMMIT, 155), 155, true),
        ...(parityCommit ? { rnParitySource: parityCommit, rnParity: describe(rnApk(parityCommit, 151), 151, true) } : {}),
    };
    if (new Set([result.rn152.signer, result.native153.signer, result.rn154.signer, result.rn155.signer, result.rnParity?.signer ?? result.rn152.signer]).size !== 1) {
        fail('the APKs have different signers');
    }
    writeFileSync(resolve(apks, 'manifest.json'), `${JSON.stringify(result, null, 2)}\n`);
    console.log(`\nAll four APKs are ${PKG}, signed by ${result.rn152.signer}\n${resolve(apks, 'manifest.json')}`);
} catch (error) {
    console.error(`FAIL: ${error.message}`);
    process.exitCode = 1;
}
