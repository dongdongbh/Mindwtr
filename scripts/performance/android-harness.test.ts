import { expect, test } from 'bun:test';
import { chmodSync, copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const directory = dirname(fileURLToPath(import.meta.url));
const root = resolve(directory, '../..');
function run(extra: Record<string, string>, check: (status: number | null, output: string, directory: string) => void) {
  const temp = mkdtempSync(join(tmpdir(), 'mindwtr-perf-harness-'));
  try {
    const adb = join(temp, 'fake-adb');
    copyFileSync(join(directory, 'fake-adb.sh'), adb);
    chmodSync(adb, 0o700);
    const result = spawnSync('bash', [join(root, 'apps/mobile/scripts/android_startup_benchmark.sh')], {
      cwd: root, encoding: 'utf8', timeout: 15000,
      env: { ...process.env, ADB_BIN: adb, FAKE_ADB_LOG: join(temp, 'commands.log'), OUT_DIR: join(temp, 'output'),
        PACKAGE: 'tech.dongdongbh.mindwtr.benchmark', DATASET_ID: 'test-v1', DEVICE_LABEL: 'synthetic', NETWORK: 'offline',
        MODE: 'cold', RUNS: '1', WAIT_MS: '1000', ...extra },
    });
    if (result.error) throw result.error;
    check(result.status, result.stdout + result.stderr, temp);
  } finally { rmSync(temp, { recursive: true, force: true }); }
}
test('cold launch emits a valid report without clearing logs or data', () => {
  run({}, (status, output, directory) => {
    expect(status).toBe(0);
    expect(output).toContain('"jsInteractive"');
    const calls = readFileSync(join(directory, 'commands.log'), 'utf8');
    expect(calls).not.toContain('logcat -c');
    expect(calls).not.toContain('pm clear');
    const reportDirectory = join(directory, 'output', readdirSync(join(directory, 'output'))[0]);
    const report = JSON.parse(readFileSync(join(reportDirectory, 'report.json'), 'utf8'));
    expect(report.invalidSamples).toBe(0);
    expect(report.metadata.artifactHash).toMatch(/^[a-f0-9]{64}$/);
  });
}, 20000);
test('missing readiness is a failing measurement, not a faster success', () => {
  run({ FAKE_MISSING_MARKER: '1' }, (status, output) => {
    expect(status).toBe(1);
    expect(output).toContain('missing_required_js_marker');
  });
}, 20000);
test('rejects debug builds and unsafe packages before driving UI', () => {
  run({ FAKE_DEBUGGABLE: '1' }, (status, output) => {
    expect(status).toBe(1);
    expect(output).toContain('Refusing a debuggable build');
  });
  run({ PACKAGE: 'tech.dongdongbh.mindwtr', ALLOW_EXISTING_APP: '0' }, (status, output) => {
    expect(status).toBe(1);
    expect(output).toContain('Refusing to drive a non-benchmark app');
  });
  run({ ACTIVITY: 'tech.dongdongbh.mindwtr/.MainActivity' }, (status, output) => {
    expect(status).toBe(1);
    expect(output).toContain('ACTIVITY must belong to PACKAGE');
  });
});
test('HOME is hot resume, and unexpected native classification fails', () => {
  run({ MODE: 'hot', FAKE_LAUNCH_STATE: 'HOT' }, (status, output, directory) => {
    expect(status).toBe(0);
    expect(output).toContain('"jsResume"');
    expect(readFileSync(join(directory, 'commands.log'), 'utf8')).toContain('shell input keyevent 3');
  });
  run({ MODE: 'warm', FAKE_LAUNCH_STATE: 'HOT' }, (status, output) => {
    expect(status).toBe(1);
    expect(output).toContain('unexpected_launch_state_or_status');
  });
}, 30000);
