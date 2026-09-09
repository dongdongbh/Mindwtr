// Run with Bun. Synthetic snapshots only; no app data, timers, or native writes.
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import type { AppData } from '../../packages/core/src/types';
import { createLocalDataWatcherController } from '../../apps/desktop/src/lib/local-data-watcher';
import { fixture } from './fixture.mjs';

const runs = Number(process.env.RUNS ?? 7);
const size = Number(process.env.SIZE ?? 10000);
assert(Number.isInteger(runs) && runs >= 3 && runs <= 100, 'RUNS must be 3..100');
assert(Number.isInteger(size) && size >= 1 && size <= 50000, 'SIZE must be 1..50000');
const data = fixture(size).data as AppData;
const controller = createLocalDataWatcherController({
    schedule: (() => 0) as unknown as typeof setTimeout,
    cancelSchedule: (() => undefined) as typeof clearTimeout,
    logInfo: () => undefined,
    logWarn: () => undefined,
});
const timings: number[] = [];
for (let run = 0; run <= runs; run++) {
    controller.testUtils.resetForTests();
    const start = performance.now();
    controller.markLocalWrite(data);
    const elapsed = performance.now() - start;
    assert(controller.testUtils.getPendingSelfWritePayloadLengthForTests() > 0);
    if (run) timings.push(elapsed);
}
controller.stop();
const sorted = [...timings].sort((a, b) => a - b);
const middle = Math.floor(sorted.length / 2);
console.log(JSON.stringify({ scenario: 'watcher-self-write-mark', size, runs, samplesMs: timings,
    medianMs: sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2 }));
