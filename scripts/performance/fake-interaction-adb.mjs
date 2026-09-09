#!/usr/bin/env node
// Synthetic runner protocol fixture; never connects to Android.
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const args = process.argv.slice(4); // node script -s serial <command>
appendFileSync(process.env.FAKE_ADB_LOG, `${args.join(' ')}\n`);
const command = args.join(' ');
if (command === 'get-state') console.log('device');
else if (command.startsWith('shell dumpsys package ')) console.log(`versionName=1.3.0 flags=[HAS_CODE ${process.env.FAKE_DEBUGGABLE ? 'DEBUGGABLE' : ''}]`);
else if (command.startsWith('shell pm path ')) console.log('package:/data/app/synthetic/base.apk');
else if (command.startsWith('shell sha256sum ')) console.log(`${(process.env.FAKE_STALE ? 'b' : 'a').repeat(64)}  /data/app/synthetic/base.apk`);
else if (command.startsWith('shell getprop ')) console.log('synthetic-device');
else if (command.startsWith('shell dumpsys ')) console.log('synthetic snapshot');
else if (command.startsWith('shell am instrument ')) console.log(process.env.FAKE_TEST_FAILURE ? 'FAILURES!!!' : 'OK (1 test)');
else if (args[0] === 'pull') {
  mkdirSync(args[2], { recursive: true });
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
