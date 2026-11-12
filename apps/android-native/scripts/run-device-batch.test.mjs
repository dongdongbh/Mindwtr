
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { apkDrift, buildSteps, checkApks, checkArgs, closingLines, defaultChecks, DISPOSABLE_PACKAGES, harnessChecks, KNOWN_STALE, parseArgs, pinApks, resetLibrary, setenvArgs, staleEntryProblem, staleLines, staleProblems, unreachable, verdict,
    withAdbPort } from './run-device-batch.mjs';
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
    assert.equal(verdict([{ check: 'a', exit: 0 }, { check: 'b', exit: 0 }], {}), 'VERDICT PASS 2/2');
    assert.equal(verdict([{ check: 'a', exit: 0 }, { check: 'b', exit: 1 }, { check: 'c', exit: 124 }], {}), 'VERDICT FAIL 1/3: b c');
    assert.equal(verdict([], {}), 'VERDICT FAIL 0/0: no checks ran');
});

test('a known-stale failure is reported on its own and does not fail the verdict; a new failure still does', () => {
    const stale = { s: '2026-11-12 reason' };
    assert.equal(verdict([{ check: 'a', exit: 0 }, { check: 's', exit: 1 }], stale), 'VERDICT PASS 1/2; known-stale failed: s');
    assert.equal(verdict([{ check: 'b', exit: 1 }, { check: 's', exit: 1 }], stale), 'VERDICT FAIL 0/2: b; known-stale failed: s');
    assert.deepEqual(staleLines([{ check: 'a', exit: 0 }, { check: 's', exit: 3 }], stale), ['KNOWN-STALE FAILED s EXIT=3: 2026-11-12 reason']);
    assert.deepEqual(staleLines([{ check: 's', exit: 0 }], stale), ['KNOWN-STALE PASSED s: take it off KNOWN_STALE (2026-11-12 reason)']);
    for (const check of Object.keys(KNOWN_STALE)) assert.ok(readdirSync(new URL('.', import.meta.url)).includes(`${check}.mjs`), check);
    assert.deepEqual(staleProblems(), []);
    assert.ok(!('check-ai-device' in KNOWN_STALE), 'a real app crash is never known-stale');
});

test('a known-stale entry without a proof path, a check line or a date is rejected', () => {
    const line = 'check-x-device.mjs:12';
    assert.equal(staleEntryProblem('x', `2026-11-12 misreads the row (${line}); proof /home/dd/scratch/logs/x/shot.png shows it works`), null);
    assert.match(staleEntryProblem('x', `2026-11-12 fails on main too (${line})`), /needs "proof \/path"/);
    assert.match(staleEntryProblem('x', `2026-11-12 misreads the row (${line}); proof shot.png`), /needs "proof \/path"/);
    assert.match(staleEntryProblem('x', '2026-11-12 misreads the row; proof /home/dd/x.png'), /names the check line/);
    assert.match(staleEntryProblem('x', `misreads the row (${line}); proof /home/dd/x.png`), /date and reason/);
    assert.deepEqual(staleProblems({ x: '2026-11-12 fails on main too' }).length, 1);
});

test('the batch reset clears only the two disposable dev packages', () => {
    assert.deepEqual(DISPOSABLE_PACKAGES, ['tech.dongdongbh.mindwtr.nativeclient.dev', 'tech.dongdongbh.mindwtr.upgradetest']);
    const calls = [];
    const adb = (...args) => {
        calls.push(args.join(' '));
        if (args[0] === 'pm' && args[1] === 'list') return `package:${args[3]}`;
        if (args[0] === 'dumpsys') return '    android.permission.POST_NOTIFICATIONS: granted=true, flags=[ USER_SET ]\n    android.permission.CAMERA: granted=false';
        if (args[0] === 'appops' && args[1] === 'get') return calls.includes(`pm clear ${args[2]}`) && !calls.some((call) => call.startsWith('appops set')) ? 'No operations.' : 'SCHEDULE_EXACT_ALARM: allow';
        return args[1] === 'clear' ? 'Success' : '';
    };
    const past = () => { calls.push('past onboarding'); return 0; };
    assert.equal(resetLibrary(adb, 'tech.dongdongbh.mindwtr.nativeclient.dev', past), 'Success, 1 permissions granted again, exact alarms allow (now allow), past onboarding=0');
    assert.deepEqual(calls.slice(2).filter((call) => !call.startsWith('appops get')), ['pm clear tech.dongdongbh.mindwtr.nativeclient.dev',
        'pm grant tech.dongdongbh.mindwtr.nativeclient.dev android.permission.POST_NOTIFICATIONS',
        'appops set tech.dongdongbh.mindwtr.nativeclient.dev SCHEDULE_EXACT_ALARM allow', 'past onboarding']);
    calls.length = 0;
    assert.equal(resetLibrary(adb, 'tech.dongdongbh.mindwtr.upgradetest', past), 'Success, 1 permissions granted again, exact alarms allow (now allow)');
    assert.ok(!calls.includes('past onboarding'), 'every upgradetest check uninstalls first, so only the dev library needs onboarding passed');
    assert.throws(() => resetLibrary(adb, 'tech.dongdongbh.mindwtr', past), /refusing to clear tech\.dongdongbh\.mindwtr$/);
    assert.equal(resetLibrary(() => '', 'tech.dongdongbh.mindwtr.upgradetest', past), 'not installed');
});

test('the batch ends with the dev library past onboarding, so the old runner on other branches finds it as it expects', () => {
    let passed = 0;
    const lines = closingLines([{ check: 'check-review-device', exit: 1 }, { check: 'a', exit: 0 }], () => { passed += 1; return 0; }, { 'check-review-device': '2026-11-12 reason (check-review-device.mjs:1); proof /x' });
    assert.equal(passed, 1);
    assert.deepEqual(lines.slice(-2), ['past onboarding=0', 'VERDICT PASS 1/2; known-stale failed: check-review-device']);
    assert.match(readCheck('past-onboarding-device'), /waitFor\('the tabs past the welcome sheet'/);
    assert.match(readFileSync(new URL('./device.mjs', import.meta.url), 'utf8'), /if \(!keepWelcome && welcomeSkip\(nodes\)\) await skipWelcome\(nodes\);/);
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
