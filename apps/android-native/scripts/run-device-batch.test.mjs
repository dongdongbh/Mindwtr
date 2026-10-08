// node --test apps/android-native/scripts/run-device-batch.test.mjs (no phone needed)
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkArgs, defaultChecks, parseArgs, verdict } from './run-device-batch.mjs';

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
