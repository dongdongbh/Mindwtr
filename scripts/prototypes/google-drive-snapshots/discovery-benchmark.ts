/** Real SQLite cache + synthetic feed. No network or native app timing. */
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { performance } from 'node:perf_hooks';
import { setLogger } from '../../../packages/core/src/logger';
import type { AppData, Task } from '../../../packages/core/src/types';
import { createSqliteCheckpointStore } from './checkpoint-store';
import { createIncrementalDiscovery, type DiscoverySource } from './incremental';
import { prepareSnapshot, type Snapshot } from './model';

setLogger(() => {});
const nowMs = Date.parse('2026-09-17T12:00:00Z');
const now = (n: number) => new Date(nowMs + n * 1000).toISOString();
const wire = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const namespace = 'synthetic-discovery-benchmark';
const base: AppData = { tasks: Array.from({ length: 5000 }, (_, n): Task => ({
  id: `synthetic-${n}`, title: `Synthetic task ${n}`, status: 'inbox', contexts: [], tags: [],
  rev: 1, revBy: 'synthetic-device', createdAt: now(0), updatedAt: now(0),
})), projects: [], sections: [], areas: [], people: [], settings: {} };
const history: Snapshot[] = [wire(prepareSnapshot('root', namespace, base, [], now(0))!)];
for (let i = 1; i < 10; i++) {
  const previous = history.at(-1)!;
  const data = wire(previous.data);
  data.tasks[i] = { ...data.tasks[i], title: `Synthetic edit ${i}`, rev: 2 };
  history.push({ ...previous, id: `snapshot-${i}`, parents: [previous.id], data });
}
const parent = join(homedir(), 'build-artifacts', 'drive-incremental-tests');
mkdirSync(parent, { recursive: true, mode: 0o700 });
const directory = mkdtempSync(join(parent, 'benchmark-'));
const path = join(directory, 'cache.sqlite');
let store = createSqliteCheckpointStore(path, namespace);
let cursor = 'start';
let appended: Snapshot | undefined;
let requests = 0;
let downloadedSnapshots = 0;
const source: DiscoverySource = {
  namespace,
  async getStartPageToken() { requests++; return cursor; },
  async readAll() { requests++; downloadedSnapshots += history.length; return wire(history); },
  async readSnapshot(id) {
    requests++; downloadedSnapshots++;
    const snapshot = history.find(s => s.id === id);
    if (!snapshot) throw new Error('fixture missing');
    return wire(snapshot);
  },
  async getChangePage(from) {
    requests++;
    return { changes: appended && from !== cursor ? [{ id: appended.id, owned: true, removed: false }] : [],
      newStartPageToken: cursor };
  },
};
const elapsed = async (action: () => Promise<unknown>) => {
  const start = performance.now(); await action(); return Math.round((performance.now() - start) * 100) / 100;
};
try {
  const client = createIncrementalDiscovery(source, store);
  const coldMs = await elapsed(() => client.sync(now(1)));
  const warm: number[] = [];
  requests = 0; downloadedSnapshots = 0;
  for (let i = 2; i <= 4; i++) warm.push(await elapsed(() => client.sync(now(i))));
  const warmRequests = requests;
  const warmDownloads = downloadedSnapshots;
  const previous = history.at(-1)!;
  const data = wire(previous.data);
  data.tasks[0] = { ...data.tasks[0], title: 'Synthetic new edit', rev: 2 };
  appended = { ...previous, id: 'snapshot-10', parents: [previous.id], data };
  history.push(appended); cursor = 'after-append'; requests = 0; downloadedSnapshots = 0;
  const appendMs = await elapsed(() => client.sync(now(5)));
  const appendDownloads = downloadedSnapshots;
  store.close(); store = createSqliteCheckpointStore(path, namespace);
  requests = 0; downloadedSnapshots = 0;
  const reopenedMs = await elapsed(() => createIncrementalDiscovery(source, store).sync(now(6)));
  console.log(JSON.stringify({ environment: 'synthetic-bun-feed-real-sqlite-no-network',
    tasks: 5000, initialHistoryFiles: 10, coldMs,
    warmMedianMs: [...warm].sort((a, b) => a - b)[1], warmSamplesMs: warm,
    warmCycles: 3, warmFeedCalls: warmRequests, warmDownloadedSnapshots: warmDownloads,
    oneNewSnapshotMs: appendMs, oneNewSnapshotDownloads: appendDownloads,
    reopenedCacheMs: reopenedMs, reopenedDownloadedSnapshots: downloadedSnapshots,
    retainedHistoryFiles: history.length }, null, 2));
} finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
