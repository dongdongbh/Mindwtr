
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { apkDrift, buildSteps, checkApks, checkArgs, defaultChecks, harnessChecks, parseArgs, pinApks, setenvArgs, unreachable, verdict, withAdbPort } from './run-device-batch.mjs';
import { DEFAULT_ADB } from './device.mjs';

const readCheck = (check) => readFileSync(new URL(`./${check}.mjs`, import.meta.url), 'utf8');

test('parses options and check names', () => {
    const o = parseArgs(['--tree', '/w/t', '--harness', '/h', '--log', '/l', '--no-build', 'check-intl-device.mjs', 'check-language-device']);
    assert.equal(o.tree, '/w/t');
    assert.equal(o.harness, '/h');
    assert.equal(o.log, '/l');
    assert.equal(o.build, false);
    assert.equal(o.detach, false);
    assert.deepEqual(o.checks, ['check-intl-device', 'check-language-device']);
    assert.equal(parseArgs(['--detach', '--unit', 'p3-phone-1']).unit, 'p3-phone-1');
    assert.throws(() => parseArgs(['--log']), /--log needs a value/);
    assert.throws(() => parseArgs(['--log', '--no-build']), /--log needs a value/);
    assert.throws(() => parseArgs(['--bogus']), /unknown option --bogus/);
});

test('default checks: projects first, upgrade last, new checks before upgrade, helpers left out', () => {
    const files = ['device.mjs', 'check-upgrade-device.mjs', 'check-zebra-device.mjs', 'check-intl-device.mjs', 'check-boot-gates.mjs',
        'check-sync-dry-run.mjs', 'capture-parity-screens.mjs', 'check-projects-device.mjs'];
    assert.deepEqual(defaultChecks(files),
        ['check-projects-device', 'capture-parity-screens', 'check-intl-device', 'check-zebra-device', 'check-upgrade-device']);
});

test('each check names the APKs it installs, and gets them as its arguments', () => {
    const apks = (check) => checkApks(check, readCheck(check));
    assert.deepEqual(apks('check-intl-device'), ['play/debug/app-play-debug.apk']);
    assert.deepEqual(apks('check-projects-device'), ['play/debug/app-play-debug.apk']);
    assert.deepEqual(apks('check-bgsync-device'), ['play/debug/app-play-debug.apk', 'foss/debug/app-foss-debug.apk']);
    assert.deepEqual(apks('check-startup-device'), ['play/benchmarkSeed/app-play-benchmarkSeed.apk', 'play/benchmark/app-play-benchmark.apk']);
    assert.deepEqual(apks('check-onboarding-device'), ['play/benchmarkSeed/app-play-benchmarkSeed.apk']);
    for (const check of ['check-upgrade-device', 'capture-parity-screens', 'check-data-device', 'check-data-deadlines-device']) assert.deepEqual(apks(check), [], check);
    assert.deepEqual(checkArgs('check-projects-device', ['/log/apks/play/debug/app-play-debug.apk']), ['/log/apks/play/debug/app-play-debug.apk', '--prune-old']);
    assert.deepEqual(checkArgs('check-intl-device', ['/log/apks/x.apk']), ['/log/apks/x.apk']);
    assert.deepEqual(checkArgs('check-upgrade-device', []), []);
});

test('every check that installs the debug APK takes its path as an argument, so it can install the copy', () => {
    const checks = defaultChecks(readdirSync(new URL('.', import.meta.url)));
    const debugChecks = checks.filter((check) => checkApks(check, readCheck(check)).includes('play/debug/app-play-debug.apk'));
    assert.ok(debugChecks.length > 50);
    for (const check of debugChecks) {
        assert.match(readCheck(check), /const apk = apkArg \?\? resolve\(app, 'android\/app\/build\/outputs\/apk\/play\/debug\/app-play-debug\.apk'\)/, check);
    }
    assert.match(readCheck('check-bgsync-device'), /const fossApk = fossApkArg \?\? /);
});

test('the batch installs its own copy of each APK, so a rebuild in the tree mid-batch changes nothing', () => {
    const tree = mkdtempSync(join(tmpdir(), 'batch-tree-'));
    const log = mkdtempSync(join(tmpdir(), 'batch-log-'));
    try {
        const source = (apk) => join(tree, 'apps/android-native/android/app/build/outputs/apk', apk);
        for (const apk of ['play/debug/app-play-debug.apk', 'foss/debug/app-foss-debug.apk']) {
            mkdirSync(dirname(source(apk)), { recursive: true });
            writeFileSync(source(apk), `first build of ${apk}`);
        }
        const pinned = pinApks(tree, join(log, 'apks'), ['play/debug/app-play-debug.apk', 'foss/debug/app-foss-debug.apk', 'play/debug/app-play-debug.apk']);
        assert.deepEqual(pinned.map(({ apk, path }) => [apk, path]), [
            ['play/debug/app-play-debug.apk', join(log, 'apks/play/debug/app-play-debug.apk')],
            ['foss/debug/app-foss-debug.apk', join(log, 'apks/foss/debug/app-foss-debug.apk')],
        ]);
        assert.match(pinned[0].sha, /^[0-9a-f]{64}$/);

        writeFileSync(source('play/debug/app-play-debug.apk'), 'gates rebuilt this APK');
        assert.equal(apkDrift(pinned), null);
        assert.equal(readFileSync(pinned[0].path, 'utf8'), 'first build of play/debug/app-play-debug.apk');
        assert.deepEqual(checkArgs('check-bgsync-device', pinned.map(({ path }) => path)), [pinned[0].path, pinned[1].path]);

        writeFileSync(pinned[1].path, 'swapped copy');
        assert.equal(apkDrift(pinned), `STOP: pinned APK changed mid-batch: ${pinned[1].path} ${pinned[1].sha} now ${createHash('sha256').update('swapped copy').digest('hex')}`);
        assert.throws(() => pinApks(tree, join(log, 'apks'), ['play/benchmark/app-play-benchmark.apk']), /ENOENT/);
    } finally {
        rmSync(tree, { recursive: true, force: true });
        rmSync(log, { recursive: true, force: true });
    }
});

test('verdict passes only when every check exits 0', () => {
    assert.equal(verdict([{ check: 'a', exit: 0 }, { check: 'b', exit: 0 }]), 'VERDICT PASS 2/2');
    assert.equal(verdict([{ check: 'a', exit: 0 }, { check: 'b', exit: 1 }, { check: 'c', exit: 124 }]), 'VERDICT FAIL 1/3: b c');
    assert.equal(verdict([]), 'VERDICT FAIL 0/0: no checks ran');
});

test('an unset adb port defaults to 5038 in the child env and the detached unit; a set one wins', () => {
    const unset = withAdbPort({ PATH: '/bin', HOME: '/home/dd' });
    assert.equal(unset.ANDROID_ADB_SERVER_PORT, '5038');
    assert.deepEqual(setenvArgs(unset), ['--setenv=PATH=/bin', '--setenv=HOME=/home/dd', '--setenv=ANDROID_ADB_SERVER_PORT=5038']);
    assert.equal(withAdbPort({ ANDROID_ADB_SERVER_PORT: '' }).ANDROID_ADB_SERVER_PORT, '5038');
    const set = withAdbPort({ PATH: '/bin', ANDROID_ADB_SERVER_PORT: '5099' });
    assert.equal(set.ANDROID_ADB_SERVER_PORT, '5099');
    assert.deepEqual(setenvArgs(set), ['--setenv=PATH=/bin', '--setenv=ANDROID_ADB_SERVER_PORT=5099']);

    assert.deepEqual(setenvArgs({ PATH: '/bin', PARITY_ONLY: 'small2' }), ['--setenv=PATH=/bin', '--setenv=PARITY_ONLY=small2']);
    assert.deepEqual(setenvArgs({ MINDWTR_UPGRADE_ONLY: '12' }), ['--setenv=MINDWTR_UPGRADE_ONLY=12']);
    assert.equal(DEFAULT_ADB, '/opt/android-sdk/platform-tools/adb');
});

test('a phone that is not "device" stops the batch with one line naming the port and the state', () => {
    assert.equal(unreachable({ status: 0, stdout: 'device\n', stderr: '' }, '5038', 3), null);
    assert.equal(unreachable({ status: 1, stdout: '', stderr: "error: device 'RFCW10JBP0Y' not found\n" }, '5038', 3),
        "VERDICT FAIL 0/3: not run, RFCW10JBP0Y not reachable on adb port 5038 (error: device 'RFCW10JBP0Y' not found)");
    assert.equal(unreachable({ status: 0, stdout: 'unauthorized\n', stderr: '' }, '5037', 1),
        'VERDICT FAIL 0/1: not run, RFCW10JBP0Y not reachable on adb port 5037 (unauthorized)');
    assert.equal(unreachable({ status: null, error: new Error('spawnSync adb ENOENT') }, '5038', 2),
        'VERDICT FAIL 0/2: not run, RFCW10JBP0Y not reachable on adb port 5038 (spawnSync adb ENOENT)');
});


const stepNames = (checks) => buildSteps('/w/t', harnessChecks(checks, readCheck)).map(([name]) => name);

test('a run of only non-harness checks skips the harness step', () => {
    const checks = ['check-about-device', 'check-intl-device', 'check-startup-device', 'check-onboarding-device',
        'check-widget-list-device', 'check-someday-projects-device'];
    assert.deepEqual(harnessChecks(checks, readCheck), []);
    assert.deepEqual(stepNames(checks), ['bundle', 'gradle']);
});

test('a run with a harness check keeps the harness step', () => {
    for (const check of ['check-upgrade-device', 'capture-parity-screens', 'check-data-device', 'check-data-deadlines-device',
        'check-data-deadlines2-device', 'check-data-large-import-device', 'check-data-no-undo-device']) {
        assert.deepEqual(harnessChecks(['check-about-device', check], readCheck), [check], check);
        assert.deepEqual(stepNames(['check-about-device', check]), ['bundle', 'gradle', 'harness'], check);
    }
});
