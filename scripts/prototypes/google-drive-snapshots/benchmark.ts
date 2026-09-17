/** Synthetic Node/Bun CPU experiment, not a native desktop/mobile benchmark. */
import { performance } from 'node:perf_hooks';
import { mergeAppData } from '../../../packages/core/src/sync';
import { setLogger } from '../../../packages/core/src/logger';
import type { AppData, Task } from '../../../packages/core/src/types';
import { prepareSnapshot, resolveSnapshots, type Snapshot } from './model';

const nowIso = '2026-09-17T12:00:00.000Z';
setLogger(() => {}); // No console I/O inside either measured path.
const empty = (tasks: Task[]): AppData => ({ tasks, projects: [], sections: [], areas: [], people: [], settings: {} });
function fixture(count: number): AppData {
  return empty(Array.from({ length: count }, (_, index) => ({ id: `synthetic-${index}`,
    title: `Synthetic task ${index}`, status: 'inbox', contexts: [], tags: [], rev: 1,
    revBy: 'synthetic-device', createdAt: nowIso, updatedAt: nowIso })));
}
function measure(fn: () => unknown) {
  fn();
  const samples: number[] = [];
  for (let round = 0; round < 5; round++) {
    const start = performance.now(); fn(); samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);
  return Math.round(samples[2] * 100) / 100;
}
const results = [];
for (const count of [1_000, 5_000]) {
  const namespace = 'synthetic-benchmark';
  const base = fixture(count);
  const snapshots: Snapshot[] = [prepareSnapshot('snapshot-0', namespace, base, [], nowIso)!];
  for (let i = 1; i < 10; i++) {
    const prior = snapshots.at(-1)!.data;
    const changed = { ...prior, tasks: prior.tasks.map((task, index) => index === i
      ? { ...task, title: `Synthetic edit ${i}`, rev: (task.rev ?? 0) + 1 } : task) };
    snapshots.push(prepareSnapshot(`snapshot-${i}`, namespace, changed, snapshots, nowIso)!);
  }
  const current = snapshots.at(-1)!.data;
  results.push({ tasks: count, historyFiles: snapshots.length,
    documentBytes: Buffer.byteLength(JSON.stringify(current)),
    historyBytes: Buffer.byteLength(JSON.stringify(snapshots)),
    currentTwoDocumentMergeMedianMs: measure(() => mergeAppData(base, current, { nowIso })),
    snapshotHistoryResolveMedianMs: measure(() => resolveSnapshots(snapshots, namespace, nowIso)),
    snapshotNoOpPrepareMedianMs: measure(() => prepareSnapshot('unused', namespace, current, snapshots, nowIso)),
  });
}
console.log(JSON.stringify({ environment: 'synthetic-bun-cpu-only', results }, null, 2));
