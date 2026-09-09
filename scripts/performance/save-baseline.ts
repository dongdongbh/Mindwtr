// Run with Bun. Synthetic snapshots only; never reads or writes application data.
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import type { AppData } from '../../packages/core/src/types';
import { buildChangedEntityBaseline } from '../../apps/desktop/src/lib/storage-save-baseline';
import { fixture } from './fixture.mjs';

const runs = Number(process.env.RUNS ?? 7);
const size = Number(process.env.SIZE ?? 10000);
assert(Number.isInteger(runs) && runs >= 3 && runs <= 100, 'RUNS must be 3..100');
assert(Number.isInteger(size) && size >= 1 && size <= 50000, 'SIZE must be 1..50000');
const baseline = fixture(size).data as AppData;
const target = structuredClone(baseline);
target.tasks.push({ ...target.tasks[0], id: 'perf-task-captured', title: 'Synthetic capture' });
const timings: number[] = [];
for (let run = 0; run <= runs; run++) {
    const start = performance.now();
    const result = buildChangedEntityBaseline(baseline, target);
    const elapsed = performance.now() - start;
    assert.equal(result.observedEntityIds.tasks.length, size);
    assert.deepEqual(Object.keys(result), ['observedEntityIds']);
    if (run) timings.push(elapsed);
}
const sorted = [...timings].sort((a, b) => a - b);
const middle = Math.floor(sorted.length / 2);
console.log(JSON.stringify({ scenario: 'cloned-snapshot-capture-baseline', size, runs, samplesMs: timings,
    medianMs: sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2 }));
