import { afterEach, expect, it } from 'bun:test';
import { base64ToBytes, bytesToBase64, FILE_SYNC_ABSENT_FINGERPRINT, FileSyncPathOwnerTerminatedError, type AppData, type MobileFileSyncFullHost } from '@mindwtr/core';
import { assertNativeFileSyncData, createNativeFileSync, prepareNativeFileSync, type NativeFileSyncCall } from './host-file-sync';
const selection = { turn: 'one-turn', rootURI: 'file:///app/Sync%20%E8%B3%87%E6%96%99/', canonicalPath: 'file:///app/Sync%20%E8%B3%87%E6%96%99/data.json' };
const host: Pick<MobileFileSyncFullHost, 'encryption' | 'crypto' | 'log'> = {
    encryption: { localState: { read: () => null, write: () => {} }, flush: async () => {}, logEvent: () => {} },
    crypto: { randomBytes: (n) => crypto.getRandomValues(new Uint8Array(n)), argon2id: async () => { throw new Error('unsupported'); },
        aesGcmOpen: async () => { throw new Error('unsupported'); }, aesGcmSeal: async () => { throw new Error('unsupported'); } },
    log: { info: () => {}, warn: () => {}, error: () => {} },
};
const original = globalThis.fetch;
const browserBase64 = ['atob', 'btoa'].map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
const withoutBrowserBase64 = () => { for (const [name] of browserBase64) Reflect.deleteProperty(globalThis, name); };
afterEach(() => {
    globalThis.fetch = original;
    for (const [name, descriptor] of browserBase64) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
    }
});
it('opens, revalidates and closes the same sole transport turn', async () => {
    const calls: Record<string, unknown>[] = [];
    const port = createNativeFileSync(selection, async (request) => { calls.push(request); return { id: 'reply', value: null }; }, host);
    const lease = await port.acquireLease(selection.canonicalPath);
    await port.revalidateLease(lease); await port.releaseLease(lease);
    expect(calls).toEqual(['open', 'revalidate', 'close'].map((op) => ({ turn: selection.turn, op })));
    await expect(port.revalidateLease(lease)).rejects.toBeInstanceOf(FileSyncPathOwnerTerminatedError);
    expect(calls.filter((call) => call.op === 'open')).toHaveLength(1);
});
it.each([{ exists: undefined }, { exists: null }, { exists: 0 }, { exists: true }, { exists: false, size: 1 }])('unknown metadata %j ends the actual versioned-read path and awaits close', async (info) => {
    const calls: string[] = [];
    let release!: () => void, reached!: () => void;
    const closing = new Promise<void>((resolve) => { reached = resolve; });
    const closed = new Promise<void>((resolve) => { release = resolve; });
    const call: NativeFileSyncCall = async (request) => {
        calls.push(String(request.op));
        if (request.op === 'close') { reached(); await closed; return { id: 'close', value: null }; }
        return { id: 'reply', value: request.op === 'info' ? info : request.op === 'list' ? [] : null };
    };
    const port = createNativeFileSync(selection, call, host);
    await port.acquireLease(selection.canonicalPath);
    let settled = false;
    const pending = port.readVersioned(selection.canonicalPath, {}).finally(() => { settled = true; });
    await closing;
    expect(calls).toContain('close'); expect(settled).toBe(false);
    release(); await expect(pending).rejects.toBeInstanceOf(FileSyncPathOwnerTerminatedError);
    expect(calls.filter((op) => op === 'info')).toHaveLength(1);
    expect(calls.filter((op) => op === 'list').length).toBeGreaterThan(0);
    expect(calls.slice(calls.indexOf('close')).every((op) => op === 'close')).toBe(true);
    expect(calls.every((op) => ['open', 'list', 'info', 'close'].includes(op))).toBe(true);
});
it('foreign lease token retires the current capability without another open', async () => {
    const calls: string[] = [];
    const port = createNativeFileSync(selection, async (request) => { calls.push(String(request.op)); return { id: 'reply', value: null }; }, host);
    await port.acquireLease(selection.canonicalPath);
    await expect(port.revalidateLease({ turn: 'foreign' })).rejects.toBeInstanceOf(FileSyncPathOwnerTerminatedError);
    await expect(port.revalidateLease({ turn: selection.turn })).rejects.toBeInstanceOf(FileSyncPathOwnerTerminatedError);
    expect(calls).toEqual(['open', 'close', 'close']);
});
it('attachment-free admission rejects both task and project material', () => {
    const data: AppData = { tasks: [], projects: [], sections: [], areas: [], settings: {} };
    expect(() => assertNativeFileSyncData(data)).not.toThrow();
    for (const side of ['tasks', 'projects'] as const) {
        const poisoned = structuredClone(data);
        // Runtime input shape comes from the real shared parser; only attachment presence matters here.
        poisoned[side] = [{ attachments: [{}] }] as unknown as typeof poisoned[typeof side];
        expect(() => assertNativeFileSyncData(poisoned)).toThrow('attachments are unavailable');
    }
});
it('a native terminal error cannot turn its error text into absence or a later request', async () => {
    const calls: string[] = [];
    const port = createNativeFileSync(selection, async (request) => {
        calls.push(String(request.op));
        return request.op === 'info' ? { id: 'reply', error: 'ENOENT data.json' } : { id: 'reply', value: request.op === 'list' ? [] : null };
    }, host);
    const lease = await port.acquireLease(selection.canonicalPath);
    await expect(port.readVersioned(selection.canonicalPath, {})).rejects.toBeInstanceOf(FileSyncPathOwnerTerminatedError);
    await expect(port.revalidateLease(lease)).rejects.toBeInstanceOf(FileSyncPathOwnerTerminatedError);
    expect(calls.filter((op) => !['open', 'list', 'info', 'close'].includes(op))).toEqual([]);
});

it('noncanonical returned base64 fails the actual versioned read before any fallback', async () => {
    const calls: string[] = [];
    const port = createNativeFileSync(selection, async (request) => {
        calls.push(String(request.op));
        if (request.op === 'list') return { id: 'reply', value: [] };
        if (request.op === 'info') return { id: 'reply', value: { exists: true, size: 1 } };
        if (request.op === 'read') return { id: 'reply', value: 'bytes', body: true, base64: 'Zg==\n' };
        return { id: 'reply', value: null };
    }, host);
    await port.acquireLease(selection.canonicalPath);
    await expect(port.readVersioned(selection.canonicalPath, {})).rejects.toBeInstanceOf(FileSyncPathOwnerTerminatedError);
    expect(calls.filter((op) => op === 'read')).toHaveLength(1);
    expect(calls.slice(calls.indexOf('close')).every((op) => op === 'close')).toBe(true);
});

it('reads a complete versioned document without browser base64 globals', async () => {
    const data: AppData = { tasks: [{ id: '00000000-0000-4000-8000-000000000001', title: 'Synthetic remote', status: 'inbox',
        tags: [], contexts: [], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }],
    projects: [], sections: [], areas: [], settings: {} };
    const bytes = new TextEncoder().encode(JSON.stringify(data)), encoded = bytesToBase64(bytes), calls: string[] = [];
    withoutBrowserBase64();
    expect(typeof globalThis.atob).toBe('undefined'); expect(typeof globalThis.btoa).toBe('undefined');
    const port = createNativeFileSync(selection, async (request) => {
        calls.push(String(request.op));
        if (request.op === 'list') return { id: 'reply', value: ['data.json'] };
        if (request.op === 'info') return { id: 'reply', value: request.uri === selection.canonicalPath ? { exists: true, size: bytes.length } : { exists: false } };
        if (request.op === 'read') return { id: 'reply', value: 'bytes', body: true, base64: encoded };
        return { id: 'reply', value: null };
    }, host);
    const lease = await port.acquireLease(selection.canonicalPath);
    const result = await port.readVersioned(selection.canonicalPath, {});
    expect(result.source).toBe('primary'); expect(result.data.tasks.map((task) => task.id)).toEqual(data.tasks.map((task) => task.id));
    expect(result.fingerprint).toBe(`sha256:${new Bun.CryptoHasher('sha256').update(bytes).digest('hex')}:length=${bytes.length}`);
    expect(calls.filter((op) => op === 'read')).toHaveLength(1);
    await port.releaseLease(lease);
});
it('encodes the actual observed write call without browser base64 globals', async () => {
    const data: AppData = { tasks: [], projects: [], sections: [], areas: [], settings: {} };
    const calls: string[] = [];
    let encoded: unknown;
    withoutBrowserBase64();
    const port = createNativeFileSync(selection, async (request) => {
        calls.push(String(request.op));
        if (request.op === 'list') return { id: 'reply', value: [] };
        if (request.op === 'info') return { id: 'reply', value: { exists: false } };
        if (request.op === 'read') return { id: 'reply', value: 'absent' };
        if (request.op === 'create') return { id: 'reply', value: 'created' };
        if (request.op === 'writeCreated') {
            encoded = request.base64;
            // End at the real transport call. This codec case claims no simulated native publication.
            throw new Error('Selected transport refusal after encoded bytes');
        }
        return { id: 'reply', value: null };
    }, host);
    await port.acquireLease(selection.canonicalPath);
    await expect(port.write(selection.canonicalPath, data, { expectedFingerprint: FILE_SYNC_ABSENT_FINGERPRINT }))
        .rejects.toBeInstanceOf(FileSyncPathOwnerTerminatedError);
    expect(calls.filter((op) => op === 'writeCreated')).toHaveLength(1);
    expect(typeof encoded).toBe('string');
    const expected = new TextEncoder().encode(JSON.stringify(data, null, 2));
    expect(encoded).toBe(bytesToBase64(expected));
    expect(base64ToBytes(String(encoded))).toEqual(expected);
    expect(calls.slice(calls.indexOf('close')).every((op) => op === 'close')).toBe(true);
});

it('prepares the owner projection then adopts that same turn without resolving a bookmark in JS', async () => {
    const calls: Record<string, unknown>[] = [];
    const call: NativeFileSyncCall = async (request) => {
        calls.push(request);
        return { id: 'reply', value: request.op === 'prepare' ? { rootURI: selection.rootURI, canonicalPath: selection.canonicalPath } : null };
    };
    const resolved = await prepareNativeFileSync(selection.turn, call, host.log);
    const port = createNativeFileSync(resolved, call, host);
    const lease = await port.acquireLease(selection.canonicalPath);
    await port.releaseLease(lease);
    expect(calls).toEqual(['prepare', 'open', 'close'].map((op) => ({ turn: selection.turn, op })));
});
it.each([
    { rootURI: selection.rootURI, canonicalPath: selection.canonicalPath, bookmark: 'untrusted' },
    { rootURI: selection.rootURI, canonicalPath: selection.rootURI + 'peer.json' },
    { rootURI: 'https://private.invalid/', canonicalPath: 'https://private.invalid/data.json' },
])('refuses an invalid owner projection before acquiring IO: %j', async (value) => {
    const calls: string[] = [];
    await expect(prepareNativeFileSync(selection.turn, async (request) => {
        calls.push(String(request.op)); return { id: 'reply', value };
    }, host.log)).rejects.toBeInstanceOf(FileSyncPathOwnerTerminatedError);
    expect(calls).toEqual(['prepare']);
});
