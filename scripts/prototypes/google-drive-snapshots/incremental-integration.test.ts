import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { setLogger } from '../../../packages/core/src/logger';
import { createSqliteCheckpointStore } from './checkpoint-store';
import { createIncrementalDiscovery, type DiscoverySource } from './incremental';
import { prepareSnapshot, type Snapshot } from './model';

setLogger(() => {});
test('SQLite checkpoint survives reopen; a lost cache rebuilds the same retained remote history', async () => {
  const parent = join(homedir(), 'build-artifacts', 'drive-incremental-tests');
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const directory = mkdtempSync(join(parent, 'integration-'));
  const path = join(directory, 'cache.sqlite');
  const namespace = 'sqlite-integration';
  const now = '2026-09-17T12:00:00.000Z';
  const root = prepareSnapshot('root', namespace,
    { tasks: [], projects: [], sections: [], areas: [], people: [], settings: {} }, [], now)!;
  const child: Snapshot = { ...structuredClone(root), id: 'child', parents: ['root'] };
  const wire = <T>(value: T): T => JSON.parse(JSON.stringify(value));
  const files = [wire(root)]; let cursor = 'first';
  const calls: string[] = [];
  const source: DiscoverySource = {
    namespace,
    async getStartPageToken() { calls.push('start'); return cursor; },
    async readAll() { calls.push('list'); return structuredClone(files); },
    async readSnapshot(id) { calls.push(`get:${id}`); return structuredClone(files.find(f => f.id === id)!); },
    async getChangePage(from) { calls.push('feed'); return { changes: from !== cursor
      ? [{ id: 'child', removed: false, owned: true }] : [], newStartPageToken: cursor }; },
  };
  let store = createSqliteCheckpointStore(path, namespace);
  try {
    await createIncrementalDiscovery(source, store).sync(now);
    store.close();
    store = createSqliteCheckpointStore(path, namespace);
    files.push(wire(child)); cursor = 'second'; calls.length = 0;
    const result = await createIncrementalDiscovery(source, store).sync(now);
    expect(result.heads).toEqual(['child']);
    expect(calls).toEqual(['feed', 'get:child']);
    expect((await store.load())?.snapshots).toHaveLength(2);
    store.close();
    // A different absent cache path simulates reinstall/cache loss without
    // deleting or modifying any remote snapshot.
    store = createSqliteCheckpointStore(join(directory, 'rebuilt.sqlite'), namespace);
    calls.length = 0;
    const rebuilt = await createIncrementalDiscovery(source, store).sync(now);
    expect(rebuilt.data).toEqual(result.data);
    expect(rebuilt.heads).toEqual(result.heads);
    expect(rebuilt.mode).toBe('rebuild');
    expect(calls).toEqual(['start', 'list', 'feed']);
    expect(files).toHaveLength(2);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});
