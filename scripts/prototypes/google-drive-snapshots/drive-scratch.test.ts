import { describe, expect, test } from 'bun:test';
import { createScratchDriveStore } from './drive-scratch';
import type { Snapshot } from './model';

function fakeDrive(options: { wrongMarker?: boolean; ambiguous?: boolean; incomplete?: boolean } = {}) {
  const files = new Map<string, { metadata: any; bytes: string }>();
  const calls: { method: string; path: string }[] = [];
  let serial = 0;
  const fetchImpl = (async (input: any, init: RequestInit) => {
    const url = new URL(String(input));
    const method = init.method ?? 'GET';
    calls.push({ method, path: url.pathname });
    expect(url.origin).toBe('https://www.googleapis.com');
    expect(init.redirect).toBe('error');
    expect(init.signal).toBeDefined();
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
    if (url.pathname.endsWith('/generateIds')) return json({ ids: [`scratch-${++serial}`] });
    if (method === 'POST') {
      const body = String(init.body);
      const parts = body.split('\r\n');
      const metadata = JSON.parse(parts[3]);
      const bytes = parts[7];
      if (files.has(metadata.id)) return json({}, 409);
      files.set(metadata.id, { metadata, bytes });
      if (options.ambiguous) throw new Error('private-provider-error');
      return json({ id: metadata.id });
    }
    if (url.pathname === '/drive/v3/files') {
      expect(url.searchParams.get('q')).toContain('appProperties has');
      return json({ files: [...files.values()].map(x => x.metadata), incompleteSearch: !!options.incomplete });
    }
    const id = url.pathname.split('/').at(-1)!;
    const file = files.get(id);
    if (!file) return json({}, 404);
    if (method === 'DELETE') { files.delete(id); return new Response(null, { status: 204 }); }
    if (url.searchParams.get('alt') === 'media') return new Response(file.bytes);
    return json(options.wrongMarker ? { ...file.metadata, appProperties: {} } : file.metadata);
  }) as typeof fetch;
  return { fetchImpl, files, calls };
}

async function fixture(options: Parameters<typeof fakeDrive>[0] = {}) {
  const fake = fakeDrive(options);
  const store = createScratchDriveStore({ accessToken: 'synthetic-token', allowTestWrites: true, fetchImpl: fake.fetchImpl });
  const id = await store.generateId();
  const snapshot = { format: 'mindwtr-drive-snapshot-prototype', version: 1, id,
    namespace: store.namespace, parents: [],
    data: { tasks: [], projects: [], sections: [], areas: [], people: [], settings: {} } } as Snapshot;
  return { ...fake, store, snapshot };
}

describe('isolated Drive scratch transport', () => {
  test('requires explicit writes authorization before any request', () => {
    expect(() => createScratchDriveStore({ accessToken: 'synthetic' })).toThrow('writes-not-authorized');
  });
  test('creates immutable files, verifies exact retry bytes, lists only namespace and cleans exact IDs', async () => {
    const { store, snapshot, files, calls } = await fixture();
    expect(await store.publish(snapshot)).toBe('created');
    expect(await store.publish(snapshot)).toBe('already-exists');
    expect(await store.readAll()).toEqual([snapshot]);
    expect(await store.cleanup()).toEqual({ attempted: 1, deleted: 1, absent: 0, failed: 0 });
    expect(files.size).toBe(0);
    expect(calls.some(x => x.method === 'PATCH' || x.method === 'PUT')).toBe(false);
  });
  test('never follows/deletes mismatched ownership', async () => {
    const { store, snapshot, files, calls } = await fixture({ wrongMarker: true });
    await expect(store.publish(snapshot)).rejects.toThrow('ownership-mismatch');
    expect((await store.cleanup()).failed).toBe(1);
    expect(files.size).toBe(1);
    expect(calls.some(x => x.method === 'DELETE')).toBe(false);
  });
  test('cleans an ambiguous create only after validating exact marker', async () => {
    const { store, snapshot } = await fixture({ ambiguous: true });
    await expect(store.publish(snapshot)).rejects.toThrow('request-failed');
    expect((await store.cleanup()).deleted).toBe(1);
  });
  test('rejects duplicate-ID different content without overwriting', async () => {
    const { store, snapshot } = await fixture();
    await store.publish(snapshot);
    await expect(store.publish({ ...snapshot, parents: ['different'] })).rejects.toThrow('immutable-content-mismatch');
    expect(await store.readAll()).toEqual([snapshot]);
    await store.cleanup();
  });
  test('refuses incomplete discovery', async () => {
    const { store, snapshot } = await fixture({ incomplete: true });
    await store.publish(snapshot);
    await expect(store.readAll()).rejects.toThrow('incomplete-list');
    await store.cleanup();
  });
  test('does not publish an ID this runner did not generate', async () => {
    const { store, snapshot, calls } = await fixture();
    await expect(store.publish({ ...snapshot, id: 'foreign' })).rejects.toThrow('foreign-snapshot');
    expect(calls).toHaveLength(1);
    expect((await store.cleanup()).attempted).toBe(0);
  });
  test('bounds stalled response bodies and does not leak raw errors', async () => {
    const store = createScratchDriveStore({ accessToken: 'secret-token', allowTestWrites: true,
      timeoutMs: 10, fetchImpl: (async () => new Response(new ReadableStream({ start() {} }))) as typeof fetch });
    const start = performance.now();
    await expect(store.generateId()).rejects.toThrow('request-timeout');
    expect(performance.now() - start).toBeLessThan(1_000);
  });
});
