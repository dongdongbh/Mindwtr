import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

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
assert(/^[a-f0-9]{64}$/i.test(process.env.EXPECTED_TEST_APK_SHA256 ?? ''), 'EXPECTED_TEST_APK_SHA256 must identify the runner APK you just built');
const expectedApkHash = process.env.EXPECTED_APK_SHA256.toLowerCase();
const expectedTestApkHash = process.env.EXPECTED_TEST_APK_SHA256.toLowerCase();
const adbBin = process.env.ADB_BIN ?? 'adb';
const deviceArgs = ['-s', process.env.ANDROID_SERIAL];
const adb = (...args) => execFileSync(adbBin, [...deviceArgs, ...args], { encoding: 'utf8', timeout: 30000 }).trim();
const installedApk = (packageName) => {
  const paths = adb('shell', 'pm', 'path', packageName).split(/\r?\n/).map(line => line.replace(/^package:/, ''));
  assert.equal(paths.length, 1, 'Use a single locally built APK, not a split installation');
  assert(/^\/[a-zA-Z0-9_./=+~-]+\.apk$/.test(paths[0]), 'Unexpected APK path');
  const hash = adb('shell', 'sha256sum', paths[0]).split(/\s/)[0];
  assert(/^[a-f0-9]{64}$/i.test(hash), 'Missing or invalid installed APK hash');
  return hash.toLowerCase();
};
assert.equal(adb('get-state'), 'device');
const packageInfo = adb('shell', 'dumpsys', 'package', target);
assert(packageInfo.includes('versionName=') && !packageInfo.includes('DEBUGGABLE'), 'Install a non-debuggable Benchmark release APK');
const apkHash = installedApk(target);
assert.equal(apkHash, expectedApkHash, 'Installed APK is stale or different');
const testApkHash = installedApk(testPackage);
assert.equal(testApkHash, expectedTestApkHash, 'Installed runner APK is stale or different');
const root = resolve(import.meta.dirname, '../..');
const output = resolve(process.env.OUT_DIR ?? join(root, 'build/performance-android'));
mkdirSync(output, { recursive: true });
const directory = mkdtempSync(join(output, `${scenario}-`));
const remoteRoot = `/sdcard/Android/media/${testPackage}/run-${Date.now()}-${basename(directory)}`;
const remoteOutput = `${remoteRoot}/measurement`;
const metadata = {
  schemaVersion: 5, scenario, metricMode, requestedRuns: runs, dataset: process.env.DATASET_ID,
  device: process.env.DEVICE_LABEL, deviceModel: adb('shell', 'getprop', 'ro.product.model'),
  os: adb('shell', 'getprop', 'ro.build.fingerprint'), network: process.env.NETWORK,
  expectedApkHash, expectedTestApkHash, apkHash, testApkHash,
  buildType: 'release-profileable', runtime: 'android-macrobenchmark-1.4.1',
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
if (scenario.startsWith('capture')) {
  // Correctness is not a latency metric. Require an actual visible IME after
  // cold and warm opens before compilation warm-ups or measured interactions.
  const coldLaunches = 10;
  metadata.readiness = { status: 'running', coldLaunches, expectedSamples: coldLaunches * 2,
    report: 'readiness/keyboard-readiness.json' };
  saveMetadata();
  const readiness = spawnSync(adbBin, [...deviceArgs, 'shell', 'am', 'instrument', '-w', '-r',
    '-e', 'class', `${testPackage}.CaptureKeyboardReadinessTest#coldAndWarmCapture`,
    '-e', 'iterations', String(coldLaunches), '-e', 'syntheticDataConfirmed', 'true',
    '-e', 'datasetId', process.env.DATASET_ID, '-e', 'expectedApkSha256', apkHash.toLowerCase(),
    '-e', 'additionalTestOutputDir', `${remoteRoot}/readiness`,
    `${testPackage}/androidx.test.runner.AndroidJUnitRunner`],
  { encoding: 'utf8', timeout: 10 * 60 * 1000, maxBuffer: 16 * 1024 * 1024 });
  const readinessLog = `${readiness.stdout ?? ''}\n${readiness.stderr ?? ''}`;
  writeFileSync(join(directory, 'readiness-instrumentation.txt'), readinessLog);
  try {
    // Collect even a failing test's report/screenshot, but never accept JSON
    // alone: Android instrumentation can return shell exit 0 for a failed test.
    adb('pull', `${remoteRoot}/readiness`, join(directory, 'readiness'));
    assert(!readiness.error && readiness.status === 0 && /OK \(1 test\)/.test(readinessLog),
      `Keyboard-readiness instrumentation failed: ${readiness.error?.message ?? readinessLog}`);
    const report = JSON.parse(readFileSync(join(directory, metadata.readiness.report), 'utf8'));
    assert.equal(report.status, 'passed', 'Keyboard-readiness report did not pass');
    assert.equal(report.apkHash, apkHash.toLowerCase(), 'Keyboard-readiness APK differs');
    assert.equal(report.dataset, metadata.dataset, 'Keyboard-readiness dataset differs');
    assert.equal(report.requestedColdLaunches, coldLaunches, 'Keyboard-readiness launch count differs');
    assert(Array.isArray(report.samples) && report.samples.length === coldLaunches * 2, 'Incomplete keyboard-readiness samples');
    const expected = new Set(Array.from({ length: coldLaunches }, (_, iteration) => [`${iteration}:cold`, `${iteration}:warm`]).flat());
    for (const sample of report.samples) {
      assert(Number.isInteger(sample.iteration) && sample.keyboardVisible === true && expected.delete(`${sample.iteration}:${sample.kind}`),
        'Invalid or duplicate keyboard-readiness sample');
    }
    assert.equal(installedApk(target), apkHash, 'Target APK changed during readiness');
    assert.equal(installedApk(testPackage), testApkHash, 'Runner APK changed during readiness');
    metadata.readiness.status = 'passed';
  } catch (error) {
    metadata.readiness.status = 'failed';
    metadata.readiness.error = String(error);
    metadata.status = 'failed';
    saveMetadata();
    console.error(`Capture benchmark skipped: ${error}`);
    console.log(`Android interaction artifacts: ${directory}`);
    process.exit(1);
  }
  saveMetadata();
}
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
    const reportPath = join(native, file);
    const report = JSON.parse(readFileSync(reportPath, 'utf8'));
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
      const frameCounts = benchmark.metrics?.frameCount?.runs;
      const cpuRuns = benchmark.sampledMetrics?.frameDurationCpuMs?.runs;
      const overrunRuns = benchmark.sampledMetrics?.frameOverrunMs?.runs;
      assert(Array.isArray(frameCounts) && frameCounts.length === runs
        && frameCounts.every(value => Number.isInteger(value) && value > 0), 'Missing or invalid frameCount iterations');
      assert(Array.isArray(cpuRuns) && cpuRuns.length === runs, 'Missing or invalid frameDurationCpuMs iterations');
      assert(Array.isArray(overrunRuns) && overrunRuns.length === runs, 'Missing or invalid frameOverrunMs iterations');
      for (let iteration = 0; iteration < runs; iteration += 1) {
        const frameCount = frameCounts[iteration];
        const cpuFrames = cpuRuns[iteration];
        const overrunFrames = overrunRuns[iteration];
        assert(Array.isArray(cpuFrames), `Invalid frameDurationCpuMs array at iteration ${iteration}`);
        assert(Array.isArray(overrunFrames), `Invalid frameOverrunMs array at iteration ${iteration}`);
        assert.equal(cpuFrames.length, frameCount, `frameDurationCpuMs count differs from frameCount at iteration ${iteration}`);
        assert.equal(overrunFrames.length, frameCount, `frameOverrunMs count differs from frameCount at iteration ${iteration}`);
        assert(cpuFrames.every(value => Number.isFinite(value) && value >= 0), `Invalid frameDurationCpuMs sample at iteration ${iteration}`);
        assert(overrunFrames.every(Number.isFinite), `Invalid frameOverrunMs sample at iteration ${iteration}`);
      }
    }
    const profilerOutputs = benchmark.profilerOutputs;
    assert(Array.isArray(profilerOutputs), 'Missing Perfetto profiler outputs');
    const traceOutputs = profilerOutputs.filter(output => output?.type === 'PerfettoTrace');
    assert.equal(traceOutputs.length, runs, `Expected ${runs} Perfetto profiler outputs`);
    const remainingIterations = new Set(Array.from({ length: runs }, (_, iteration) => iteration));
    const traceFilenames = new Set();
    for (const output of traceOutputs) {
      const labelMatch = /^Trace Iteration (0|[1-9]\d*)$/.exec(output.label ?? '');
      assert(labelMatch, 'Invalid Perfetto trace iteration label');
      const iteration = Number(labelMatch[1]);
      assert(remainingIterations.delete(iteration), `Duplicate or unexpected Perfetto trace iteration: ${iteration}`);
      const filename = output.filename;
      assert(typeof filename === 'string' && filename.length > 0, `Missing Perfetto trace filename at iteration ${iteration}`);
      const segments = filename.split('/');
      assert(!isAbsolute(filename) && !/^[a-zA-Z]:[\\/]/.test(filename) && !filename.includes('\\')
        && segments.every(segment => segment.length > 0 && segment !== '.' && segment !== '..' && /^[a-zA-Z0-9._-]+$/.test(segment)),
      `Unsafe Perfetto trace filename: ${filename}`);
      assert(!traceFilenames.has(filename), `Duplicate Perfetto trace filename: ${filename}`);
      traceFilenames.add(filename);
      const expectedPrefix = `MindwtrBenchmark_${scenario}_iter${String(iteration).padStart(3, '0')}_`;
      const traceBasename = basename(filename);
      assert(traceBasename.startsWith(expectedPrefix) && traceBasename.endsWith('.perfetto-trace')
        && traceBasename.length > expectedPrefix.length + '.perfetto-trace'.length,
      `Perfetto trace filename does not match scenario/iteration: ${filename}`);
      const tracePath = resolve(dirname(reportPath), filename);
      const retainedPath = relative(native, tracePath);
      assert(retainedPath && retainedPath !== '..' && !retainedPath.startsWith(`..${sep}`) && !isAbsolute(retainedPath),
        `Perfetto trace resolves outside retained artifacts: ${filename}`);
      assert(existsSync(tracePath), `Missing Perfetto trace file: ${filename}`);
      const traceStat = statSync(tracePath);
      assert(traceStat.isFile() && traceStat.size > 0, `Empty or invalid Perfetto trace file: ${filename}`);
    }
    assert.equal(remainingIterations.size, 0, 'Missing Perfetto trace iteration');
  }
} catch (error) { collectionError = String(error); }
// A successful native report alone cannot establish build identity: another
// build/install can replace either package after the initial check. Resolve the
// currently installed paths again and retain collected evidence even on failure.
metadata.finalBuildIdentity = { status: 'checking' };
try {
  metadata.finalBuildIdentity.apkHash = installedApk(target);
  metadata.finalBuildIdentity.testApkHash = installedApk(testPackage);
  assert.equal(metadata.finalBuildIdentity.apkHash, apkHash, 'Target APK changed during measurement');
  assert.equal(metadata.finalBuildIdentity.testApkHash, testApkHash, 'Runner APK changed during measurement');
  metadata.finalBuildIdentity.status = 'passed';
} catch (error) {
  metadata.finalBuildIdentity.status = 'failed';
  metadata.finalBuildIdentity.error = String(error);
}
try {
  writeFileSync(join(directory, 'process-after.txt'), adb('shell', 'dumpsys', 'meminfo', target));
  writeFileSync(join(directory, 'thermal-after.txt'), adb('shell', 'dumpsys', 'thermalservice'));
} catch (error) { metadata.diagnosticsError = String(error); }
metadata.status = !result.error && result.status === 0 && /OK \(1 test\)/.test(log) && !collectionError
  && metadata.finalBuildIdentity.status === 'passed' && !metadata.diagnosticsError ? 'passed' : 'failed';
metadata.collectionError = collectionError;
metadata.runnerError = result.error?.message;
saveMetadata();
console.log(`Android interaction artifacts: ${directory}`);
if (metadata.status !== 'passed') {
  console.error(log);
  if (collectionError) console.error(collectionError);
  if (metadata.finalBuildIdentity.error) console.error(metadata.finalBuildIdentity.error);
  if (metadata.diagnosticsError) console.error(metadata.diagnosticsError);
  process.exitCode = 1;
}
