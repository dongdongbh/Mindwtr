import { expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';

it('rejects an interaction run before accessing adb without synthetic-data confirmation', () => {
  const result = spawnSync('node', [join(import.meta.dir, 'android-interactions.mjs')], {
    env: { ...process.env, SCENARIO: 'captureSave', SYNTHETIC_DATA_CONFIRMED: '', ADB_BIN: '/nonexistent-adb' }, encoding: 'utf8',
  });
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain('Confirm synthetic data');
  expect(result.stderr).not.toContain('spawnSync /nonexistent-adb');
});

it('rejects an unknown scenario before driving the phone', () => {
  const result = spawnSync('node', [join(import.meta.dir, 'android-interactions.mjs')], {
    env: { ...process.env, SCENARIO: 'wipe', ADB_BIN: '/nonexistent-adb' }, encoding: 'utf8',
  });
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain('SCENARIO must be');
});

it('rejects an unknown metric mode before driving the phone', () => {
  const result = spawnSync('node', [join(import.meta.dir, 'android-interactions.mjs')], {
    env: { ...process.env, SCENARIO: 'inboxScroll', METRIC_MODE: 'mixed', ADB_BIN: '/nonexistent-adb' }, encoding: 'utf8',
  });
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain('METRIC_MODE must be');
  expect(result.stderr).not.toContain('spawnSync /nonexistent-adb');
});

it('requires a matching release APK, a passing test and collected native evidence', () => {
  const scratch = join(import.meta.dir, '../../build/performance-tools');
  mkdirSync(scratch, { recursive: true });
  for (const condition of ['', 'FAKE_STALE', 'FAKE_DEBUGGABLE', 'FAKE_TEST_FAILURE', 'FAKE_MISSING_REPORT', 'FAKE_MISSING_METRIC']) {
    const directory = mkdtempSync(join(scratch, 'interaction-test-'));
    try {
      const adb = join(directory, 'adb.mjs');
      copyFileSync(join(import.meta.dir, 'fake-interaction-adb.mjs'), adb);
      chmodSync(adb, 0o700);
      const log = join(directory, 'calls.log');
      const output = join(directory, 'output');
      const env: Record<string, string | undefined> = { ...process.env, ADB_BIN: adb, ANDROID_SERIAL: 'synthetic', SCENARIO: 'coldStartup', METRIC_MODE: 'timing', RUNS: '1',
        SYNTHETIC_DATA_CONFIRMED: '1', DATASET_ID: 'test-v1', DEVICE_LABEL: 'synthetic', NETWORK: 'offline',
        EXPECTED_APK_SHA256: 'a'.repeat(64), FAKE_ADB_LOG: log, OUT_DIR: output };
      for (const name of ['FAKE_STALE', 'FAKE_DEBUGGABLE', 'FAKE_TEST_FAILURE', 'FAKE_MISSING_REPORT', 'FAKE_MISSING_METRIC']) delete env[name];
      if (condition) env[condition] = '1';
      const result = spawnSync('node', [join(import.meta.dir, 'android-interactions.mjs')], { env, encoding: 'utf8', timeout: 15000 });
      expect(result.status, result.stderr).toBe(condition ? 1 : 0);
      const calls = readFileSync(log, 'utf8');
      expect(calls).not.toMatch(/pm clear|install|logcat -c/);
      if (condition === 'FAKE_STALE' || condition === 'FAKE_DEBUGGABLE') expect(calls).not.toContain('am instrument');
      else {
        const metadata = JSON.parse(readFileSync(join(output, readdirSync(output)[0], 'metadata.json'), 'utf8'));
        expect(metadata.status).toBe(condition ? 'failed' : 'passed');
        expect(metadata.testApkHash).toBe('a'.repeat(64));
      }
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }
}, 20000);

it('isolates timing and memory and rejects the observed shortened scalar reports', () => {
  const scratch = join(import.meta.dir, '../../build/performance-tools');
  mkdirSync(scratch, { recursive: true });
  for (const mode of ['timing', 'memory']) {
    for (const shortened of [false, true]) {
      const directory = mkdtempSync(join(scratch, 'metric-mode-test-'));
      try {
        const adb = join(directory, 'adb.mjs');
        copyFileSync(join(import.meta.dir, 'fake-interaction-adb.mjs'), adb);
        chmodSync(adb, 0o700);
        const env = { ...process.env, ADB_BIN: adb, ANDROID_SERIAL: 'synthetic', SCENARIO: 'settingsNavigation', RUNS: '5',
          METRIC_MODE: mode, SYNTHETIC_DATA_CONFIRMED: '1', DATASET_ID: 'test-v1', DEVICE_LABEL: 'synthetic', NETWORK: 'offline',
          EXPECTED_APK_SHA256: 'a'.repeat(64), FAKE_ADB_LOG: join(directory, 'calls.log'), OUT_DIR: join(directory, 'output'),
          FAKE_SHORT_SCALARS: shortened ? '1' : '' };
        const result = spawnSync('node', [join(import.meta.dir, 'android-interactions.mjs')], { env, encoding: 'utf8', timeout: 15000 });
        expect(result.status, result.stderr).toBe(shortened ? 1 : 0);
        expect(readFileSync(env.FAKE_ADB_LOG, 'utf8')).toContain(`-e metricMode ${mode}`);
        if (shortened) expect(result.stderr).toContain('Missing or invalid native metric');
        const metadata = JSON.parse(readFileSync(join(env.OUT_DIR, readdirSync(env.OUT_DIR)[0], 'metadata.json'), 'utf8'));
        expect(metadata.metricMode).toBe(mode);
      } finally { rmSync(directory, { recursive: true, force: true }); }
    }
  }
}, 20000);
