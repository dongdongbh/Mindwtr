#!/usr/bin/env node
// Synthetic runner protocol fixture; never connects to Android.
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const args = process.argv.slice(4); // node script -s serial <command>
appendFileSync(process.env.FAKE_ADB_LOG, `${args.join(' ')}\n`);
const command = args.join(' ');
const measured = readFileSync(process.env.FAKE_ADB_LOG, 'utf8').includes('MindwtrBenchmark#');
const measurementChange = measured ? process.env.FAKE_MEASUREMENT_CHANGE : '';
if (measurementChange === 'disconnected'
  && (command.startsWith('shell pm path ') || command.startsWith('shell dumpsys '))) process.exit(1);
if (command === 'get-state') console.log('device');
else if (command.startsWith('shell dumpsys package ')) console.log(`versionName=1.3.0 flags=[HAS_CODE ${process.env.FAKE_DEBUGGABLE ? 'DEBUGGABLE' : ''}]`);
else if (command.startsWith('shell pm path ')) {
  const label = command.endsWith('tech.dongdongbh.mindwtr.benchmark') ? 'target' : 'runner';
  if (measurementChange === `missing-${label}`) process.exit(1);
  const prefix = measurementChange === 'same-build-new-path' ? 'reinstalled-' : '';
  console.log(`package:/data/app/${prefix}${label}/base.apk`);
}
else if (command.startsWith('shell sha256sum ')) {
  const hashReads = readFileSync(process.env.FAKE_ADB_LOG, 'utf8').split('\n').filter(line => line.startsWith('shell sha256sum ')).length;
  const changed = (process.env.FAKE_READINESS === 'target-changed' && hashReads === 3)
    || (process.env.FAKE_READINESS === 'runner-changed' && hashReads === 4)
    || (measurementChange === 'target' && command.includes('/target/'))
    || (measurementChange === 'runner' && command.includes('/runner/'));
  console.log(`${(process.env.FAKE_STALE || changed ? 'b' : 'a').repeat(64)}  /data/app/synthetic/base.apk`);
}
else if (command.startsWith('shell getprop ')) console.log('synthetic-device');
else if (command.startsWith('shell dumpsys ')) console.log('synthetic snapshot');
else if (command.startsWith('shell am instrument ')) {
  const readiness = command.includes('CaptureKeyboardReadinessTest#');
  console.log((readiness ? process.env.FAKE_READINESS === 'test-failure' : process.env.FAKE_TEST_FAILURE) ? 'FAILURES!!!' : 'OK (1 test)');
  if (readiness && process.env.FAKE_READINESS === 'shell-failure') process.exitCode = 1;
}
else if (args[0] === 'pull') {
  mkdirSync(args[2], { recursive: true });
  if (args[1].endsWith('/readiness')) {
    const fault = process.env.FAKE_READINESS;
    if (fault === 'pull-failure') process.exit(1);
    if (fault === 'missing') process.exit(0);
    const samples = Array.from({ length: 10 }, (_, iteration) => ['cold', 'warm'].map(kind => ({ iteration, kind, keyboardVisible: true }))).flat();
    const report = { apkHash: 'a'.repeat(64), dataset: process.env.DATASET_ID, requestedColdLaunches: 10, samples, status: 'passed' };
    if (fault === 'incomplete') samples.pop();
    if (fault === 'duplicate') samples[1] = samples[0];
    if (fault === 'hidden') samples[0].keyboardVisible = false;
    if (fault === 'wrong-kind') samples[0].kind = 'hot';
    if (fault === 'wrong-iteration') samples[0].iteration = 10;
    if (fault === 'wrong-hash') report.apkHash = 'b'.repeat(64);
    if (fault === 'wrong-dataset') report.dataset = 'another-fixture';
    if (fault === 'wrong-count') report.requestedColdLaunches = 1;
    if (fault === 'failed') report.status = 'failed';
    writeFileSync(join(args[2], 'keyboard-readiness.json'), fault === 'malformed' ? '{' : JSON.stringify(report));
    process.exit(0);
  }
  if (!process.env.FAKE_MISSING_REPORT) {
    const count = Number(process.env.RUNS ?? 1);
    const values = Array.from({ length: process.env.FAKE_SHORT_SCALARS ? 1 : count }, () => 50);
    const memory = process.env.METRIC_MODE === 'memory';
    writeFileSync(join(args[2], 'synthetic-benchmarkData.json'), JSON.stringify({ benchmarks: [{ name: process.env.SCENARIO, repeatIterations: count,
      metrics: process.env.FAKE_MISSING_METRIC ? {} : memory
        ? { memoryRssAnonLastKb: { runs: values }, memoryRssFileLastKb: { runs: values } }
        : process.env.SCENARIO === 'coldStartup'
          ? { timeToInitialDisplayMs: { runs: values }, timeToFullDisplayMs: { runs: values } }
          : { frameCount: { runs: values } },
      sampledMetrics: memory ? {} : {
        frameDurationCpuMs: { runs: Array.from({ length: count }, () => [2, 3]) },
        frameOverrunMs: { runs: Array.from({ length: count }, () => [-5, -3]) },
      },
    }] }));
    writeFileSync(join(args[2], 'synthetic.perfetto-trace'), 'fake test trace');
  }
} else { console.error(`Unexpected fake adb call: ${command}`); process.exitCode = 1; }
