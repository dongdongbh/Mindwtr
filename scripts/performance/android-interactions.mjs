import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

// Intentionally no package/activity override and no install/reset/import command.
const target = 'tech.dongdongbh.mindwtr.benchmark';
const testPackage = 'tech.dongdongbh.mindwtr.macrobenchmark';
const scenarios = ['coldStartup', 'inboxScroll', 'settingsNavigation', 'captureOpenClose', 'captureSave'];
const scenario = process.env.SCENARIO;
const metricMode = process.env.METRIC_MODE ?? 'timing';
assert(['timing', 'memory'].includes(metricMode), 'METRIC_MODE must be timing or memory');
const runs = Number(process.env.RUNS ?? 10);
assert(scenarios.includes(scenario), `SCENARIO must be one of ${scenarios.join(', ')}`);
assert(Number.isInteger(runs) && runs >= 1 && runs <= 100, 'RUNS must be 1..100');
assert(process.env.SYNTHETIC_DATA_CONFIRMED === '1', 'Confirm synthetic data and disabled sync with SYNTHETIC_DATA_CONFIRMED=1');
assert(process.env.ANDROID_SERIAL, 'Explicit ANDROID_SERIAL is required');
assert(process.env.DATASET_ID && process.env.DEVICE_LABEL, 'DATASET_ID and DEVICE_LABEL are required');
assert(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(process.env.DATASET_ID), 'DATASET_ID must be a safe fixture identifier');
assert(['offline', 'online'].includes(process.env.NETWORK), 'NETWORK must describe actual device state');
assert(/^[a-f0-9]{64}$/i.test(process.env.EXPECTED_APK_SHA256 ?? ''), 'EXPECTED_APK_SHA256 must identify the APK you just built');
const adbBin = process.env.ADB_BIN ?? 'adb';
const deviceArgs = ['-s', process.env.ANDROID_SERIAL];
const adb = (...args) => execFileSync(adbBin, [...deviceArgs, ...args], { encoding: 'utf8', timeout: 30000 }).trim();
assert.equal(adb('get-state'), 'device');
const packageInfo = adb('shell', 'dumpsys', 'package', target);
assert(packageInfo.includes('versionName=') && !packageInfo.includes('DEBUGGABLE'), 'Install a non-debuggable Benchmark release APK');
const paths = adb('shell', 'pm', 'path', target).split(/\r?\n/).map(line => line.replace(/^package:/, ''));
assert.equal(paths.length, 1, 'Use the single locally built APK, not a split installation');
assert(/^\/[a-zA-Z0-9_./=+~-]+\.apk$/.test(paths[0]), 'Unexpected APK path');
const apkHash = adb('shell', 'sha256sum', paths[0]).split(/\s/)[0];
assert.equal(apkHash.toLowerCase(), process.env.EXPECTED_APK_SHA256.toLowerCase(), 'Installed APK is stale or different');
const testPath = adb('shell', 'pm', 'path', testPackage).replace(/^package:/, '');
assert(/^\/[a-zA-Z0-9_./=+~-]+\.apk$/.test(testPath), 'Install the single Macrobenchmark runner APK');
const testApkHash = adb('shell', 'sha256sum', testPath).split(/\s/)[0];
const root = resolve(import.meta.dirname, '../..');
const output = resolve(process.env.OUT_DIR ?? join(root, 'build/performance-android'));
mkdirSync(output, { recursive: true });
const directory = mkdtempSync(join(output, `${scenario}-`));
const remoteOutput = `/sdcard/Android/media/${testPackage}/run-${Date.now()}`;
const metadata = {
  schemaVersion: 2, scenario, metricMode, requestedRuns: runs, dataset: process.env.DATASET_ID,
  device: process.env.DEVICE_LABEL, deviceModel: adb('shell', 'getprop', 'ro.product.model'),
  os: adb('shell', 'getprop', 'ro.build.fingerprint'), network: process.env.NETWORK,
  apkHash, testApkHash, buildType: 'release-profileable', runtime: 'android-macrobenchmark-1.4.1',
  compilation: 'partial-no-baseline-3-warmups',
  listSort: scenario.startsWith('capture') ? 'newest' : scenario === 'inboxScroll' ? 'default' : undefined,
  capturedAt: new Date().toISOString(), status: 'running',
  warnings: ['UI selectors require English. Dataset and disabled sync are operator-verified, not inferred from an app label.',
    'captureSave grows the synthetic fixture during warm-up and measurement; restore it before a comparable rerun.',
    'Timing and memory are separate experiments. Memory reports the last RSS samples, not exact allocation peaks or PSS.',
    'ART heap and GPU counters are excluded from aggregation because intermittent counters cause AndroidX 1.4.1 to drop complete scalar iterations.',
    'The process may already be stopped after instrumentation. Frame duration is not input-to-display latency.'],
};
const saveMetadata = () => writeFileSync(join(directory, 'metadata.json'), `${JSON.stringify(metadata, null, 2)}\n`);
saveMetadata();
writeFileSync(join(directory, 'battery-before.txt'), adb('shell', 'dumpsys', 'battery'));
writeFileSync(join(directory, 'thermal-before.txt'), adb('shell', 'dumpsys', 'thermalservice'));
const result = spawnSync(adbBin, [...deviceArgs, 'shell', 'am', 'instrument', '-w', '-r',
  '-e', 'class', `${testPackage}.MindwtrBenchmark#${scenario}`,
  '-e', 'iterations', String(runs), '-e', 'syntheticDataConfirmed', 'true',
  '-e', 'metricMode', metricMode,
  '-e', 'datasetId', process.env.DATASET_ID,
  '-e', 'additionalTestOutputDir', remoteOutput,
  `${testPackage}/androidx.test.runner.AndroidJUnitRunner`],
{ encoding: 'utf8', timeout: 20 * 60 * 1000, maxBuffer: 16 * 1024 * 1024 });
const log = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
writeFileSync(join(directory, 'instrumentation.txt'), log);
let collectionError;
try {
  const native = join(directory, 'native');
  adb('pull', remoteOutput, native);
  const files = readdirSync(native, { recursive: true }).map(String);
  const reports = files.filter(file => file.endsWith('-benchmarkData.json'));
  assert(reports.length > 0, 'No native benchmark JSON collected');
  assert(files.some(file => file.endsWith('.perfetto-trace')), 'No native trace collected');
  for (const file of reports) {
    const report = JSON.parse(readFileSync(join(native, file), 'utf8'));
    const benchmark = report.benchmarks?.find(item => item.name === scenario);
    assert(benchmark, 'Native report does not contain the requested scenario');
    assert.equal(benchmark.repeatIterations, runs, 'Native sample count differs from requested iterations');
    const required = metricMode === 'memory' ? ['memoryRssAnonLastKb', 'memoryRssFileLastKb']
      : scenario === 'coldStartup' ? ['timeToInitialDisplayMs', 'timeToFullDisplayMs'] : ['frameCount'];
    for (const name of required) {
      const values = benchmark.metrics?.[name]?.runs;
      assert(Array.isArray(values) && values.length === runs && values.every(value => Number.isFinite(value) && value > 0), `Missing or invalid native metric: ${name}`);
    }
    if (metricMode === 'timing' && scenario !== 'coldStartup') {
      for (const name of ['frameDurationCpuMs', 'frameOverrunMs']) {
        const values = benchmark.sampledMetrics?.[name]?.runs;
        assert(Array.isArray(values) && values.length === runs && values.every(frames => frames.length > 0 && frames.every(Number.isFinite)), `Missing or invalid frame metric: ${name}`);
      }
    }
  }
} catch (error) { collectionError = String(error); }
writeFileSync(join(directory, 'process-after.txt'), adb('shell', 'dumpsys', 'meminfo', target));
writeFileSync(join(directory, 'thermal-after.txt'), adb('shell', 'dumpsys', 'thermalservice'));
metadata.status = !result.error && result.status === 0 && /OK \(1 test\)/.test(log) && !collectionError ? 'passed' : 'failed';
metadata.collectionError = collectionError;
metadata.runnerError = result.error?.message;
saveMetadata();
console.log(`Android interaction artifacts: ${directory}`);
if (metadata.status !== 'passed') {
  console.error(log);
  if (collectionError) console.error(collectionError);
  process.exitCode = 1;
}
