
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { buildSteps, checkArgs, defaultChecks, harnessChecks, parseArgs, setenvArgs, unreachable, verdict, withAdbPort } from './run-device-batch.mjs';
import { DEFAULT_ADB } from './device.mjs';

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

test('only projects and startup get extra arguments', () => {
    assert.deepEqual(checkArgs('check-projects-device'), ['--prune-old']);
    assert.equal(checkArgs('check-startup-device').length, 2);
    assert.match(checkArgs('check-startup-device')[0], /benchmarkSeed\.apk$/);
    assert.deepEqual(checkArgs('check-intl-device'), []);
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
    // The upgrade check's scenario pick reaches the detached unit (check-upgrade-device.mjs reads it).
    assert.deepEqual(setenvArgs({ MINDWTR_UPGRADE_ONLY: '12' }), ['--setenv=MINDWTR_UPGRADE_ONLY=12']);
    // device.mjs's own default is the /opt adb, never the /home/dd/Android/Sdk one (each kills the other's server).
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


const readCheck = (check) => readFileSync(new URL(`./${check}.mjs`, import.meta.url), 'utf8');
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
