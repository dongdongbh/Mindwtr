import { expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';

const readinessCases = [
  ...['captureOpenClose', 'captureSave'].flatMap(scenario => ['timing', 'memory'].flatMap(mode =>
    ['', 'test-failure'].map(fault => ({ scenario, mode, fault })))),
  ...['missing', 'pull-failure', 'malformed', 'incomplete', 'duplicate', 'hidden', 'wrong-hash', 'wrong-dataset', 'wrong-count', 'failed', 'wrong-kind', 'wrong-iteration', 'shell-failure', 'target-changed', 'runner-changed']
    .map(fault => ({ scenario: 'captureOpenClose', mode: 'timing', fault })),
];
for (const { scenario, mode, fault } of readinessCases) it(`gates ${scenario}/${mode} on complete keyboard readiness (${fault || 'passed'})`, () => {
  const scratch = join(import.meta.dir, '../../build/performance-tools');
  mkdirSync(scratch, { recursive: true });
  const directory = mkdtempSync(join(scratch, 'readiness-test-'));
  try {
    const adb = join(directory, 'adb.mjs');
    copyFileSync(join(import.meta.dir, 'fake-interaction-adb.mjs'), adb);
    chmodSync(adb, 0o700);
    const env = { ...process.env, ADB_BIN: adb, ANDROID_SERIAL: 'synthetic', SCENARIO: scenario, METRIC_MODE: mode, RUNS: '1',
      SYNTHETIC_DATA_CONFIRMED: '1', DATASET_ID: 'test-v1', DEVICE_LABEL: 'synthetic', NETWORK: 'offline',
      EXPECTED_APK_SHA256: 'a'.repeat(64), EXPECTED_TEST_APK_SHA256: 'a'.repeat(64),
      FAKE_ADB_LOG: join(directory, 'calls.log'), OUT_DIR: join(directory, 'output'),
      FAKE_READINESS: fault };
    const result = spawnSync('node', [join(import.meta.dir, 'android-interactions.mjs')], { env, encoding: 'utf8', timeout: 15000 });
    expect(result.status, result.stderr).toBe(fault ? 1 : 0);
    const calls = readFileSync(env.FAKE_ADB_LOG, 'utf8');
    expect(calls).toContain('CaptureKeyboardReadinessTest#coldAndWarmCapture');
    expect(calls).toContain('-e iterations 10 -e syntheticDataConfirmed true');
    expect(calls).toContain(`-e expectedApkSha256 ${'a'.repeat(64)}`);
    expect(calls).not.toMatch(/pm clear|install|logcat -c/);
    if (fault) expect(calls).not.toContain('MindwtrBenchmark#');
    else {
      expect(calls.indexOf('CaptureKeyboardReadinessTest#')).toBeLessThan(calls.indexOf(`MindwtrBenchmark#${scenario}`));
      expect(calls).toContain(`-e metricMode ${mode}`);
    }
    const artifacts = join(env.OUT_DIR, readdirSync(env.OUT_DIR)[0]);
    const metadata = JSON.parse(readFileSync(join(artifacts, 'metadata.json'), 'utf8'));
    expect(metadata.status).toBe(fault ? 'failed' : 'passed');
    expect(metadata.readiness.status).toBe(fault ? 'failed' : 'passed');
    expect(metadata.readiness.expectedSamples).toBe(20);
    expect(readFileSync(join(artifacts, 'readiness-instrumentation.txt'), 'utf8')).toContain(fault === 'test-failure' ? 'FAILURES!!!' : 'OK (1 test)');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

it('rejects an interaction run before accessing adb without synthetic-data confirmation', () => {
  const result = spawnSync('node', [join(import.meta.dir, 'android-interactions.mjs')], {
    env: { ...process.env, SCENARIO: 'captureSave', SYNTHETIC_DATA_CONFIRMED: '', ADB_BIN: '/nonexistent-adb' }, encoding: 'utf8',
  });
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain('Confirm synthetic data');
  expect(result.stderr).not.toContain('spawnSync /nonexistent-adb');
});

for (const [scenario, mode] of [['settingsNavigation', 'timing'], ['captureOpenClose', 'memory']]) {
  for (const fault of ['target', 'runner', 'missing-target', 'missing-runner', 'disconnected', 'same-build-new-path']) {
    it(`verifies both installed builds after ${scenario}/${mode} (${fault})`, () => {
      const scratch = join(import.meta.dir, '../../build/performance-tools');
      mkdirSync(scratch, { recursive: true });
      const directory = mkdtempSync(join(scratch, 'build-identity-test-'));
      try {
        const adb = join(directory, 'adb.mjs');
        copyFileSync(join(import.meta.dir, 'fake-interaction-adb.mjs'), adb);
        chmodSync(adb, 0o700);
        const env = { ...process.env, ADB_BIN: adb, ANDROID_SERIAL: 'synthetic', SCENARIO: scenario,
          METRIC_MODE: mode, RUNS: '1', SYNTHETIC_DATA_CONFIRMED: '1', DATASET_ID: 'test-v1',
          DEVICE_LABEL: 'synthetic', NETWORK: 'offline', EXPECTED_APK_SHA256: 'a'.repeat(64), EXPECTED_TEST_APK_SHA256: 'a'.repeat(64),
          FAKE_ADB_LOG: join(directory, 'calls.log'), OUT_DIR: join(directory, 'output'), FAKE_MEASUREMENT_CHANGE: fault };
        const result = spawnSync('node', [join(import.meta.dir, 'android-interactions.mjs')], { env, encoding: 'utf8', timeout: 15000 });
        const changed = fault !== 'same-build-new-path';
        expect(result.status, result.stderr).toBe(changed ? 1 : 0);
        const artifacts = join(env.OUT_DIR, readdirSync(env.OUT_DIR)[0]);
        const metadata = JSON.parse(readFileSync(join(artifacts, 'metadata.json'), 'utf8'));
        expect(metadata.status).toBe(changed ? 'failed' : 'passed');
        expect(metadata.finalBuildIdentity.status).toBe(changed ? 'failed' : 'passed');
        if (fault === 'disconnected') expect(metadata.diagnosticsError).toBeDefined();
        expect(readFileSync(join(artifacts, 'instrumentation.txt'), 'utf8')).toContain('OK (1 test)');
        expect(readdirSync(join(artifacts, 'native')).some(file => file.endsWith('.perfetto-trace'))).toBe(true);
        const calls = readFileSync(env.FAKE_ADB_LOG, 'utf8');
        expect(calls).not.toMatch(/pm clear|install |logcat -c/);
        if (scenario.startsWith('capture')) expect(metadata.readiness.status).toBe('passed');
      } finally { rmSync(directory, { recursive: true, force: true }); }
    });
  }
}

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
        EXPECTED_APK_SHA256: 'a'.repeat(64), EXPECTED_TEST_APK_SHA256: 'a'.repeat(64), FAKE_ADB_LOG: log, OUT_DIR: output };
      for (const name of ['FAKE_STALE', 'FAKE_DEBUGGABLE', 'FAKE_TEST_FAILURE', 'FAKE_MISSING_REPORT', 'FAKE_MISSING_METRIC']) delete env[name];
      if (condition) env[condition] = '1';
      const result = spawnSync('node', [join(import.meta.dir, 'android-interactions.mjs')], { env, encoding: 'utf8', timeout: 15000 });
      expect(result.status, result.stderr).toBe(condition ? 1 : 0);
      const calls = readFileSync(log, 'utf8');
      expect(calls).not.toMatch(/pm clear|install|logcat -c/);
      expect(calls).not.toContain('CaptureKeyboardReadinessTest#');
      if (condition === 'FAKE_STALE' || condition === 'FAKE_DEBUGGABLE') expect(calls).not.toContain('am instrument');
      else {
        const metadata = JSON.parse(readFileSync(join(output, readdirSync(output)[0], 'metadata.json'), 'utf8'));
        expect(metadata.status).toBe(condition ? 'failed' : 'passed');
        expect(metadata.schemaVersion).toBe(5);
        expect(metadata.expectedApkHash).toBe('a'.repeat(64));
        expect(metadata.expectedTestApkHash).toBe('a'.repeat(64));
        expect(metadata.testApkHash).toBe('a'.repeat(64));
      }
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }
}, 20000);

it('isolates timing and memory and rejects the observed shortened scalar reports', () => {
  const scratch = join(import.meta.dir, '../../build/performance-tools');
  mkdirSync(scratch, { recursive: true });
  const cases = ['settingsNavigation', 'captureOpenClose'].flatMap(scenario =>
    ['timing', 'memory'].map(mode => ({ scenario, mode })));
  for (const { scenario, mode } of cases) {
    for (const shortened of [false, true]) {
      const directory = mkdtempSync(join(scratch, 'metric-mode-test-'));
      try {
        const adb = join(directory, 'adb.mjs');
        copyFileSync(join(import.meta.dir, 'fake-interaction-adb.mjs'), adb);
        chmodSync(adb, 0o700);
        const env = { ...process.env, ADB_BIN: adb, ANDROID_SERIAL: 'synthetic', SCENARIO: scenario, RUNS: '5',
          METRIC_MODE: mode, SYNTHETIC_DATA_CONFIRMED: '1', DATASET_ID: 'test-v1', DEVICE_LABEL: 'synthetic', NETWORK: 'offline',
          EXPECTED_APK_SHA256: 'a'.repeat(64), EXPECTED_TEST_APK_SHA256: 'a'.repeat(64),
          FAKE_ADB_LOG: join(directory, 'calls.log'), OUT_DIR: join(directory, 'output'),
          FAKE_SHORT_SCALARS: shortened ? '1' : '' };
        const result = spawnSync('node', [join(import.meta.dir, 'android-interactions.mjs')], { env, encoding: 'utf8', timeout: 15000 });
        expect(result.status, result.stderr).toBe(shortened ? 1 : 0);
        expect(readFileSync(env.FAKE_ADB_LOG, 'utf8')).toContain(`-e metricMode ${mode}`);
        if (shortened) expect(result.stderr).toContain('Missing or invalid native metric');
        const metadata = JSON.parse(readFileSync(join(env.OUT_DIR, readdirSync(env.OUT_DIR)[0], 'metadata.json'), 'utf8'));
        expect(metadata.metricMode).toBe(mode);
        expect(metadata.listSort).toBe(scenario === 'captureOpenClose' ? 'newest' : undefined);
        expect(readFileSync(env.FAKE_ADB_LOG, 'utf8')).toContain(`MindwtrBenchmark#${scenario}`);
        expect(metadata.readiness?.status).toBe(scenario.startsWith('capture') ? 'passed' : undefined);
      } finally { rmSync(directory, { recursive: true, force: true }); }
    }
  }
}, 20000);

it('requires a valid expected runner hash before any adb access', () => {
  for (const expected of ['', 'not-a-sha256']) {
    const result = spawnSync('node', [join(import.meta.dir, 'android-interactions.mjs')], {
      env: { ...process.env, ADB_BIN: '/nonexistent-adb', ANDROID_SERIAL: 'synthetic', SCENARIO: 'settingsNavigation',
        METRIC_MODE: 'timing', RUNS: '1', SYNTHETIC_DATA_CONFIRMED: '1', DATASET_ID: 'test-v1',
        DEVICE_LABEL: 'synthetic', NETWORK: 'offline', EXPECTED_APK_SHA256: 'a'.repeat(64),
        EXPECTED_TEST_APK_SHA256: expected }, encoding: 'utf8',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('EXPECTED_TEST_APK_SHA256');
    expect(result.stderr).not.toContain('spawnSync /nonexistent-adb');
  }
});

it('rejects a stale runner before launch or instrumentation', () => {
  const scratch = join(import.meta.dir, '../../build/performance-tools');
  mkdirSync(scratch, { recursive: true });
  const directory = mkdtempSync(join(scratch, 'initial-runner-test-'));
  try {
    const adb = join(directory, 'adb.mjs');
    copyFileSync(join(import.meta.dir, 'fake-interaction-adb.mjs'), adb);
    chmodSync(adb, 0o700);
    const env = { ...process.env, ADB_BIN: adb, ANDROID_SERIAL: 'synthetic', SCENARIO: 'settingsNavigation',
      METRIC_MODE: 'timing', RUNS: '1', SYNTHETIC_DATA_CONFIRMED: '1', DATASET_ID: 'test-v1',
      DEVICE_LABEL: 'synthetic', NETWORK: 'offline', EXPECTED_APK_SHA256: 'a'.repeat(64),
      EXPECTED_TEST_APK_SHA256: 'a'.repeat(64), FAKE_ADB_LOG: join(directory, 'calls.log'),
      OUT_DIR: join(directory, 'output'), FAKE_STALE_RUNNER: '1' };
    const result = spawnSync('node', [join(import.meta.dir, 'android-interactions.mjs')], { env, encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Installed runner APK is stale or different');
    expect(readFileSync(env.FAKE_ADB_LOG, 'utf8')).not.toContain('am instrument');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

it('requires coherent per-frame timing samples and accepts zero CPU with signed overruns', () => {
  const scratch = join(import.meta.dir, '../../build/performance-tools');
  mkdirSync(scratch, { recursive: true });
  const faults = ['', 'fractional-count', 'zero-count', 'cpu-not-array', 'overrun-not-array', 'cpu-missing-entry',
    'overrun-missing-entry', 'unequal-lengths', 'cpu-negative', 'cpu-nonfinite', 'overrun-nonfinite'];
  for (const fault of faults) {
    const directory = mkdtempSync(join(scratch, 'frame-integrity-test-'));
    try {
      const adb = join(directory, 'adb.mjs');
      copyFileSync(join(import.meta.dir, 'fake-interaction-adb.mjs'), adb);
      chmodSync(adb, 0o700);
      const env = { ...process.env, ADB_BIN: adb, ANDROID_SERIAL: 'synthetic', SCENARIO: 'settingsNavigation',
        METRIC_MODE: 'timing', RUNS: '2', SYNTHETIC_DATA_CONFIRMED: '1', DATASET_ID: 'test-v1',
        DEVICE_LABEL: 'synthetic', NETWORK: 'offline', EXPECTED_APK_SHA256: 'a'.repeat(64),
        EXPECTED_TEST_APK_SHA256: 'a'.repeat(64), FAKE_ADB_LOG: join(directory, 'calls.log'),
        OUT_DIR: join(directory, 'output'), FAKE_FRAME_FAULT: fault };
      const result = spawnSync('node', [join(import.meta.dir, 'android-interactions.mjs')], { env, encoding: 'utf8' });
      expect(result.status, `${fault || 'valid'}: ${result.stderr}`).toBe(fault ? 1 : 0);
      if (fault) expect(result.stderr).toContain('frame');
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }
}, 60000);

it('requires one safe retained Perfetto trace for every measured iteration', () => {
  const scratch = join(import.meta.dir, '../../build/performance-tools');
  mkdirSync(scratch, { recursive: true });
  const faults = ['', 'missing-index', 'duplicate-index', 'noncanonical-index', 'duplicate-file', 'missing-file', 'empty-file',
    'traversal', 'absolute', 'wrong-convention', 'ancillary-only'];
  for (const fault of faults) {
    const directory = mkdtempSync(join(scratch, 'trace-integrity-test-'));
    try {
      const adb = join(directory, 'adb.mjs');
      copyFileSync(join(import.meta.dir, 'fake-interaction-adb.mjs'), adb);
      chmodSync(adb, 0o700);
      const env = { ...process.env, ADB_BIN: adb, ANDROID_SERIAL: 'synthetic', SCENARIO: 'settingsNavigation',
        METRIC_MODE: 'timing', RUNS: '3', SYNTHETIC_DATA_CONFIRMED: '1', DATASET_ID: 'test-v1',
        DEVICE_LABEL: 'synthetic', NETWORK: 'offline', EXPECTED_APK_SHA256: 'a'.repeat(64),
        EXPECTED_TEST_APK_SHA256: 'a'.repeat(64), FAKE_ADB_LOG: join(directory, 'calls.log'),
        OUT_DIR: join(directory, 'output'), FAKE_TRACE_FAULT: fault };
      const result = spawnSync('node', [join(import.meta.dir, 'android-interactions.mjs')], { env, encoding: 'utf8' });
      expect(result.status, `${fault || 'valid'}: ${result.stderr}`).toBe(fault ? 1 : 0);
      if (fault === 'duplicate-file') expect(result.stderr).toContain('Duplicate Perfetto trace filename');
      else if (fault) expect(result.stderr).toContain('Perfetto');
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }
}, 60000);
