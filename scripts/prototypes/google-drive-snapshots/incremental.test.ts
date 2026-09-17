import { describe, expect, test } from 'bun:test';
import { setLogger } from '../../../packages/core/src/logger';
import { createIncrementalDiscovery, type ChangePage, type Checkpoint, type CheckpointStore, type DiscoverySource } from './incremental';
import { prepareSnapshot, resolveSnapshots, type Snapshot } from './model';

setLogger(() => {});
const now = '2026-09-17T12:00:00.000Z';
const namespace = 'synthetic-incremental';
const data = { tasks: [], projects: [], sections: [], areas: [], people: [], settings: {} };
const root = prepareSnapshot('root', namespace, data, [], now)!;
const child: Snapshot = { ...structuredClone(root), id: 'child', parents: ['root'] };
function harness(initial: Snapshot[] = [root]) {
  let checkpoint: Checkpoint | null = null;
  let saveFails = false;
  const calls: string[] = [];
  const pages = new Map<string, ChangePage>([['start', { changes: [], newStartPageToken: 'end' }],
    ['end', { changes: [], newStartPageToken: 'end' }]]);
  const files = new Map(initial.map(s => [s.id, structuredClone(s)]));
  const source: DiscoverySource = {
    namespace,
    async getStartPageToken() { calls.push('start'); return 'start'; },
    async readAll() { calls.push('list'); return structuredClone(initial); },
    async readSnapshot(id) { calls.push(`get:${id}`); if (!files.has(id)) throw new Error('unavailable'); return structuredClone(files.get(id)!); },
    async getChangePage(cursor) { calls.push(`feed:${cursor}`); const page = pages.get(cursor); if (!page) throw new Error('feed-failed'); return structuredClone(page); },
  };
  const store: CheckpointStore = {
    async load() { return structuredClone(checkpoint); },
    async save(next, revision) {
      calls.push('save');
      if (saveFails) throw new Error('disk-failed');
      if ((checkpoint?.revision ?? null) !== revision) throw new Error('stale-cache');
      checkpoint = structuredClone(next);
    },
  };
  return { source, store, files, pages, calls, get checkpoint() { return structuredClone(checkpoint); },
    failSave(value: boolean) { saveFails = value; },
    seed(value: Checkpoint) { checkpoint = structuredClone(value); } };
}
const addition = (id: string) => ({ id, removed: false, owned: true });

describe('incremental snapshot discovery', () => {
  test('gets the cursor before listing and replays files added during the listing window', async () => {
    const h = harness();
    h.files.set(child.id, child);
    h.pages.set('start', { changes: [addition(child.id)], newStartPageToken: 'end' });
    const result = await createIncrementalDiscovery(h.source, h.store).sync(now);
    expect(h.calls).toEqual(['start', 'list', 'feed:start', 'get:child', 'save']);
    expect(result.heads).toEqual(['child']);
    expect(h.checkpoint?.snapshots).toHaveLength(2);
    expect(h.checkpoint?.cursor).toBe('end');
  });
  test('unchanged warm sync makes one feed call, no media/list/start/save call', async () => {
    const h = harness(); const client = createIncrementalDiscovery(h.source, h.store);
    await client.sync(now); h.calls.length = 0;
    const result = await client.sync('2026-09-17T12:01:00.000Z');
    expect(h.calls).toEqual(['feed:end']);
    expect(result.downloadedSnapshots).toBe(0);
    expect(result.checkpointWritten).toBe(false);
    expect(result.mode).toBe('incremental');
  });
  test('downloads only new IDs, handles reversed parent ordering and empty pages', async () => {
    const h = harness(); const client = createIncrementalDiscovery(h.source, h.store);
    await client.sync(now); h.calls.length = 0;
    const grandchild = { ...child, id: 'grandchild', parents: ['child'] };
    h.files.set('child', child); h.files.set('grandchild', grandchild);
    h.pages.set('end', { changes: [addition('grandchild')], nextPageToken: 'middle' });
    h.pages.set('middle', { changes: [], nextPageToken: 'last' });
    h.pages.set('last', { changes: [addition('child'), addition('grandchild')], newStartPageToken: 'done' });
    const result = await client.sync(now);
    expect(result.heads).toEqual(['grandchild']);
    expect(result.downloadedSnapshots).toBe(2);
    expect(h.calls.filter(c => c.startsWith('get:'))).toEqual(['get:child', 'get:grandchild']);
    expect(h.checkpoint?.snapshots).toHaveLength(3);
  });
  test('failed durable commit never acknowledges or skips replay', async () => {
    const h = harness(); const client = createIncrementalDiscovery(h.source, h.store);
    await client.sync(now);
    h.files.set('child', child);
    h.pages.set('end', { changes: [addition('child')], newStartPageToken: 'new' });
    h.failSave(true);
    await expect(client.sync(now)).rejects.toThrow('disk-failed');
    expect(h.checkpoint?.cursor).toBe('end');
    expect(h.checkpoint?.snapshots).toHaveLength(1);
    h.failSave(false); h.calls.length = 0;
    expect((await client.sync(now)).heads).toEqual(['child']);
    expect(h.calls).toContain('feed:end');
    expect(h.checkpoint?.cursor).toBe('new');
  });
  test('failed download leaves old checkpoint and retry succeeds', async () => {
    const h = harness(); const client = createIncrementalDiscovery(h.source, h.store);
    await client.sync(now);
    h.pages.set('end', { changes: [addition('child')], newStartPageToken: 'new' });
    await expect(client.sync(now)).rejects.toThrow('unavailable');
    expect(h.checkpoint?.cursor).toBe('end');
    h.files.set('child', child);
    expect((await client.sync(now)).heads).toEqual(['child']);
  });
  test('rejects removal, permission loss, or changed bytes for known history', async () => {
    for (const kind of ['removed', 'foreign', 'mutated']) {
      const h = harness(); const client = createIncrementalDiscovery(h.source, h.store);
      await client.sync(now);
      h.pages.set('end', { changes: [{ id: 'root', removed: kind === 'removed', owned: kind !== 'foreign' }], newStartPageToken: 'new' });
      if (kind === 'mutated') h.files.set('root', { ...root, data: { ...data, settings: { theme: 'dark' } } });
      await expect(client.sync(now)).rejects.toThrow(kind === 'mutated' ? 'immutable-content-changed' : 'history-unavailable');
      expect(h.checkpoint?.cursor).toBe('end');
    }
  });
  test('unknown foreign IDs are never downloaded and owned removal fails closed', async () => {
    const h = harness(); const client = createIncrementalDiscovery(h.source, h.store);
    h.pages.set('start', { changes: [{ id: 'foreign', removed: false, owned: false },
      { id: 'removed-unknown', removed: true, owned: false }], newStartPageToken: 'end' });
    await client.sync(now);
    expect(h.calls.some(c => c.startsWith('get:'))).toBe(false);
    h.pages.set('end', { changes: [{ id: 'owned-gone', removed: true, owned: true }], newStartPageToken: 'new' });
    await expect(client.sync(now)).rejects.toThrow('history-unavailable');
  });
  test('does not commit a page before later pages and graph validation succeed', async () => {
    const h = harness(); const client = createIncrementalDiscovery(h.source, h.store);
    await client.sync(now);
    h.files.set('orphan', { ...child, id: 'orphan', parents: ['missing'] });
    h.pages.set('end', { changes: [addition('orphan')], nextPageToken: 'missing-page' });
    await expect(client.sync(now)).rejects.toThrow('feed-failed');
    expect(h.checkpoint?.cursor).toBe('end');
    h.pages.set('missing-page', { changes: [], newStartPageToken: 'done' });
    await expect(client.sync(now)).rejects.toThrow('missing parent');
    expect(h.checkpoint?.cursor).toBe('end');
  });
  test('rejects looping, malformed and unterminated pages without committing', async () => {
    for (const page of [{ changes: [], nextPageToken: 'start' }, { changes: [] },
      { changes: [], nextPageToken: 'middle', newStartPageToken: 'end' }]) {
      const h = harness(); h.pages.set('start', page);
      await expect(createIncrementalDiscovery(h.source, h.store).sync(now)).rejects.toThrow();
      expect(h.checkpoint).toBeNull();
    }
  });
  test('fresh process restores cache but validates it rather than trusting proof flags', async () => {
    const h = harness(); await createIncrementalDiscovery(h.source, h.store).sync(now);
    h.calls.length = 0;
    const result = await createIncrementalDiscovery(h.source, h.store).sync(now);
    expect(result.data).toEqual(resolveSnapshots([root], namespace, now).data);
    expect(h.calls).toEqual(['feed:end']);
    const corrupt = h.checkpoint!; corrupt.snapshots[0].parents = ['missing']; h.seed(corrupt);
    h.calls.length = 0;
    await expect(createIncrementalDiscovery(h.source, h.store).sync(now)).rejects.toThrow('missing parent');
    expect(h.calls).toEqual([]);
  });
  test('empty cache rebuilds from complete remote history', async () => {
    const h = harness([root, child]);
    const result = await createIncrementalDiscovery(h.source, h.store).sync(now);
    expect(result.mode).toBe('rebuild'); expect(result.heads).toEqual(['child']);
    expect(h.checkpoint?.snapshots).toHaveLength(2);
  });
  test('rejects namespace mismatch and oversized history', async () => {
    const h = harness();
    h.seed({ version: 1, revision: 1, namespace: 'other', cursor: 'end', snapshots: [root] });
    await expect(createIncrementalDiscovery(h.source, h.store).sync(now)).rejects.toThrow('invalid-checkpoint');
    const oversized = harness(Array.from({ length: 129 }, (_, index) => ({ ...root, id: `id-${index}` })));
    await expect(createIncrementalDiscovery(oversized.source, oversized.store).sync(now)).rejects.toThrow('history-budget');
    expect(oversized.checkpoint).toBeNull();
  });
  test('rejects overlapping calls on one client', async () => {
    const h = harness(); let release!: () => void;
    h.source.getStartPageToken = async () => { await new Promise<void>(r => { release = r; }); return 'start'; };
    const client = createIncrementalDiscovery(h.source, h.store);
    const first = client.sync(now);
    await Promise.resolve();
    await expect(client.sync(now)).rejects.toThrow('discovery-busy');
    release(); await first;
  });
});
