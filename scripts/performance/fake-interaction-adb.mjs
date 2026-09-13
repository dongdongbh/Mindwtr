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
  const staleRunner = process.env.FAKE_STALE_RUNNER && command.includes('/runner/');
  console.log(`${(process.env.FAKE_STALE || staleRunner || changed ? 'b' : 'a').repeat(64)}  /data/app/synthetic/base.apk`);
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
    const scalarValues = Array.from({ length: process.env.FAKE_SHORT_SCALARS ? 1 : count }, () => 50);
    const frameCounts = Array.from({ length: process.env.FAKE_SHORT_SCALARS ? 1 : count }, () => 2);
    const memory = process.env.METRIC_MODE === 'memory';
    const frameFault = process.env.FAKE_FRAME_FAULT;
    const cpuRuns = Array.from({ length: count }, () => [0, 3]);
    const overrunRuns = Array.from({ length: count }, () => [-5, 2]);
    if (frameFault === 'fractional-count') frameCounts[0] = 1.5;
    if (frameFault === 'zero-count') frameCounts[0] = 0;
    if (frameFault === 'cpu-not-array') cpuRuns[0] = 'invalid';
    if (frameFault === 'overrun-not-array') overrunRuns[0] = 'invalid';
    if (frameFault === 'cpu-missing-entry') cpuRuns[0] = [0];
    if (frameFault === 'overrun-missing-entry') overrunRuns[0] = [-5];
    if (frameFault === 'unequal-lengths') overrunRuns[0] = [-5, 2, 4];
    if (frameFault === 'cpu-negative') cpuRuns[0] = [-1, 3];
    if (frameFault === 'cpu-nonfinite') cpuRuns[0] = [Number.NaN, 3];
    if (frameFault === 'overrun-nonfinite') overrunRuns[0] = [-5, Number.POSITIVE_INFINITY];
    const traceFault = process.env.FAKE_TRACE_FAULT;
    const profilerOutputs = Array.from({ length: count }, (_, iteration) => ({
      type: 'PerfettoTrace', label: `Trace Iteration ${iteration}`,
      filename: `MindwtrBenchmark_${process.env.SCENARIO}_iter${String(iteration).padStart(3, '0')}_synthetic.perfetto-trace`,
    }));
    profilerOutputs.push({ type: 'StackSamplingTrace', label: 'Ancillary output', filename: 'ancillary.trace' });
    if (traceFault === 'missing-index') profilerOutputs.splice(count - 1, 1);
    if (traceFault === 'duplicate-index') profilerOutputs[1].label = 'Trace Iteration 0';
    if (traceFault === 'noncanonical-index') profilerOutputs[0].label = 'Trace Iteration 00';
    if (traceFault === 'duplicate-file') profilerOutputs[1].filename = profilerOutputs[0].filename;
    if (traceFault === 'missing-file') profilerOutputs[count - 1].filename = `MindwtrBenchmark_${process.env.SCENARIO}_iter${String(count - 1).padStart(3, '0')}_missing.perfetto-trace`;
    if (traceFault === 'empty-file') profilerOutputs[count - 1].filename = `MindwtrBenchmark_${process.env.SCENARIO}_iter${String(count - 1).padStart(3, '0')}_empty.perfetto-trace`;
    if (traceFault === 'traversal') profilerOutputs[0].filename = '../MindwtrBenchmark_escape_iter000_synthetic.perfetto-trace';
    if (traceFault === 'absolute') profilerOutputs[0].filename = '/sdcard/MindwtrBenchmark_escape_iter000_synthetic.perfetto-trace';
    if (traceFault === 'wrong-convention') profilerOutputs[0].filename = 'wrong_iter000_synthetic.perfetto-trace';
    if (traceFault === 'ancillary-only') profilerOutputs.splice(0, count);
    writeFileSync(join(args[2], 'synthetic-benchmarkData.json'), JSON.stringify({ benchmarks: [{ name: process.env.SCENARIO, repeatIterations: count,
      metrics: process.env.FAKE_MISSING_METRIC ? {} : memory
        ? { memoryRssAnonLastKb: { runs: scalarValues }, memoryRssFileLastKb: { runs: scalarValues } }
        : process.env.SCENARIO === 'coldStartup'
          ? { timeToInitialDisplayMs: { runs: scalarValues }, timeToFullDisplayMs: { runs: scalarValues } }
          : { frameCount: { runs: frameCounts } },
      sampledMetrics: memory ? {} : {
        frameDurationCpuMs: { runs: cpuRuns },
        frameOverrunMs: { runs: overrunRuns },
      },
      profilerOutputs,
    }] }));
    for (const output of profilerOutputs.filter(item => item.type === 'PerfettoTrace')) {
      if (output.filename.startsWith('/') || output.filename.includes('..') || output.filename.includes('missing')) continue;
      writeFileSync(join(args[2], output.filename), output.filename.includes('empty') ? '' : 'fake test trace');
    }
    if (traceFault === 'ancillary-only') writeFileSync(join(args[2], 'arbitrary-ancillary.perfetto-trace'), 'not measurement evidence');
  }
} else { console.error(`Unexpected fake adb call: ${command}`); process.exitCode = 1; }
