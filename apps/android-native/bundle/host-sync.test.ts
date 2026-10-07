import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test';
import * as core from '@mindwtr/core';
import {
    BACKGROUND_SYNC_FAILURE_STATE_KEY,
    NativeAttachmentCleanupUnconfirmedError,
    SyncEncryptionArtifactCapacityError,
    SYNC_BACKEND_KEY,
    WEBDAV_URL_KEY,
    resetForTests,
    setSha256HexProvider,
    setLogger,
    type AppData,
} from '@mindwtr/core';
import { createDeadlineFetch, createNativeSync } from './host-sync';
import type { NativeAttachmentBindings } from './host-attachments';
import { createMemoryFileSystem, CACHE, DOCUMENTS, MANAGED } from '../../../packages/core/src/__fixtures__/mobile-attachment-fakes';

// The native app's background sync binding (S4a): core's runner and schedule decision on the host's ports.
const globals = globalThis as unknown as Record<string, unknown>;
const realFetch = globalThis.fetch;
const nativeGlobals = ['__mindwtrHostPlatform', '__mindwtrNative', '__mindwtrFileCall', '__mindwtrInstallerCall'];
const originalGlobals = new Map(nativeGlobals.map((name) => [name, globals[name]]));

const host = (stored: Record<string, string> = {}, refuseSchedule = false, getData?: () => Promise<AppData>,
    retireLocalAttachment?: NativeAttachmentBindings['retireLocalAttachment']) => {
    const kv = new Map(Object.entries(stored));
    const schedules: boolean[] = [];
    const lines: string[] = [];
    const traces: string[] = [];
    const calls: string[] = [];
    const bindings: Parameters<typeof createNativeSync>[0] = {
        keyValue: {
            get: async (key) => { calls.push('get'); return kv.get(key) ?? null; },
            set: async (key, value) => { calls.push('set'); kv.set(key, value); },
            remove: async (key) => { calls.push('remove'); kv.delete(key); },
            multiGet: async (keys) => { calls.push('multiGet'); return keys.map((key) => [key, kv.get(key) ?? null] as [string, string | null]); },
            multiSet: async (pairs) => { calls.push('multiSet'); for (const [key, value] of pairs) kv.set(key, value); },
        },
        secrets: {
            getSecret: async () => { calls.push('getSecret'); return null; },
            setSecret: async () => { calls.push('setSecret'); },
            deleteSecret: async () => { calls.push('deleteSecret'); },
        },
        localData: () => ({ getData: getData ?? (async () => { throw new Error('no local data in this test'); }), saveData: async () => undefined }),
        networkState: () => { calls.push('networkState'); return { isConnected: true, isInternetReachable: true }; },
        appendLog: async (entry) => { calls.push('appendLog'); lines.push(entry.message); return null; },
        translate: (key) => key,
        emit: () => { calls.push('emit'); },
        trace: (line) => { calls.push('trace'); traces.push(line); },
        scheduleBackgroundSync: (on) => {
            if (refuseSchedule) throw new Error('WorkManager did not store the work');
            calls.push('schedule');
            schedules.push(on);
        },
        isFossBuild: false,
        retireLocalAttachment,
    };
    const sync = createNativeSync(bindings);
    return { sync, kv, schedules, lines, traces, calls, bindings };
};

it('records bounded iOS unlock only after the shared service confirms completion', async () => {
    const create = core.createSyncEncryptionService;
    let outcome: 'ok' | 'wrong-passphrase' | 'no-encrypted-remote' | Error = 'ok';
    let release: (() => void) | undefined;
    let held: Promise<void> | undefined;
    spyOn(core, 'createSyncEncryptionService').mockImplementation((options) => ({
        ...create(options),
        provideSyncEncryptionPassphrase: async () => {
            await held;
            if (outcome instanceof Error) throw outcome;
            return outcome;
        },
    }));
    for (const platform of ['ios', 'android']) {
        if (platform === 'ios') iosFiles();
        globals.__mindwtrHostPlatform = platform;
        const { sync, bindings } = host({}, false, undefined, async () => false);
        const entries: Parameters<typeof bindings.appendLog>[0][] = [];
        bindings.appendLog = async (entry) => { entries.push(entry); return null; };
        const provide = sync.settingsHost.encryption.transitions!.provide;
        sync.settingsHost.encryption.unlockOnly = true;
        for (outcome of ['wrong-passphrase', 'no-encrypted-remote', new Error('synthetic failure')] as const) {
            try { await provide('synthetic secret'); } catch { /* Shared failure stays a failure. */ }
            expect(entries.filter((entry) => entry.message === 'Native iOS encrypted unlock service completed')).toHaveLength(0);
        }
        outcome = 'ok';
        held = new Promise<void>((resolve) => { release = resolve; });
        const pending = provide('synthetic secret');
        await Promise.resolve();
        expect(entries).toHaveLength(0);
        release!();
        expect(await pending).toBe('ok');
        held = undefined;
        expect(entries).toHaveLength(platform === 'ios' ? 1 : 0);
        if (platform === 'ios') expect(entries[0]!.context).toEqual({
            releaseCheck: 'v1.3.5/ios-encryption-unlock', operation: 'unlock', outcome: 'confirmed',
        });
        expect(JSON.stringify(entries)).not.toContain('synthetic secret');
        entries.length = 0;
        sync.settingsHost.encryption.unlockOnly = false;
        expect(await provide('synthetic secret')).toBe('ok');
        expect(entries).toHaveLength(0);
        delete sync.settingsHost.encryption.unlockOnly;
        sync.settingsHost.encryption.mode = 'saved-webdav-enable-unlock';
        expect(await provide('synthetic secret')).toBe('ok');
        expect(entries).toHaveLength(platform === 'ios' ? 1 : 0);
        entries.length = 0;
        sync.settingsHost.encryption.mode = 'saved-webdav';
        expect(await provide('synthetic secret')).toBe('ok');
        expect(entries).toHaveLength(platform === 'ios' ? 1 : 0);
    }
});

it('records selected iOS encryption settlement without changing a completed outcome when logging fails', async () => {
    const create = core.createSyncEncryptionService;
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    spyOn(core, 'createSyncEncryptionService').mockImplementation((options) => ({
        ...create(options),
        enableSyncEncryption: async () => { await held; },
        changeSyncEncryptionPassphrase: async () => { await held; },
        disableSyncEncryption: async () => { await held; },
        abandonSyncEncryptionTransition: async () => 'enable' as const,
        recheckPartlyEncryptedLocation: async () => 'mixed' as const,
    }));
    iosFiles();
    globals.__mindwtrHostPlatform = 'ios';
    const { sync, bindings } = host({}, false, undefined, async () => false);
    sync.settingsHost.encryption.mode = 'saved-webdav';
    const entries: Parameters<typeof bindings.appendLog>[0][] = [];
    bindings.appendLog = async (entry) => { entries.push(entry); return null; };
    const transitions = sync.settingsHost.encryption.transitions!;
    const pending = transitions.enable('synthetic secret', {});
    const changing = transitions.change('synthetic current', 'synthetic next', {});
    const disabling = transitions.disable({});
    await Promise.resolve();
    expect(entries).toHaveLength(0);
    release();
    await Promise.all([pending, changing, disabling]);
    expect(await transitions.abandon()).toBe('enable');
    expect(await transitions.recheck()).toBe('mixed');
    expect(entries.map((entry) => entry.context)).toEqual(['enable', 'change', 'disable', 'abandon', 'recheck'].map((operation) => ({
        releaseCheck: 'v1.3.5/ios-encryption-selected', operation, outcome: 'confirmed',
    })));
    expect(JSON.stringify(entries)).not.toContain('synthetic secret');
    bindings.appendLog = () => { throw new Error('synthetic diagnostic failure'); };
    await transitions.enable('synthetic secret', {});
    await transitions.change('synthetic current', 'synthetic next', {});
    await transitions.disable({});
    expect(await transitions.abandon()).toBe('enable');
    expect(await transitions.recheck()).toBe('mixed');
});

const fetches: string[] = [];
it('binds the iOS encrypted-output capacity and preserves refusal if diagnostics fail', async () => {
    const create = core.createSyncEncryptionService;
    const capacities: (number | undefined)[] = [];
    const refused = new SyncEncryptionArtifactCapacityError();
    let failure: unknown = refused;
    spyOn(core, 'createSyncEncryptionService').mockImplementation((options) => {
        capacities.push(options.maxEncryptedArtifactBytes);
        return { ...create(options), enableSyncEncryption: async () => { throw failure; } };
    });
    for (const platform of ['ios', 'android']) {
        if (platform === 'ios') iosFiles();
        globals.__mindwtrHostPlatform = platform;
        const { sync, bindings } = host({}, false, undefined, async () => false);
        const entries: Parameters<typeof bindings.appendLog>[0][] = [];
        bindings.appendLog = async (entry) => { entries.push(entry); return null; };
        const enable = sync.settingsHost.encryption.transitions!.enable;
        failure = refused;
        await expect(enable('synthetic secret', {})).rejects.toBe(refused);
        expect(entries).toHaveLength(platform === 'ios' ? 1 : 0);
        if (platform === 'ios') expect(entries[0]!.context).toEqual({
            releaseCheck: 'v1.3.5/ios-encryption-enable-capacity', operation: 'enable', outcome: 'refused',
        });
        expect(JSON.stringify(entries)).not.toContain('synthetic secret');
        bindings.appendLog = () => { throw new Error('synthetic diagnostic failure'); };
        await expect(enable('synthetic secret', {})).rejects.toBe(refused);
        entries.length = 0;
        bindings.appendLog = async (entry) => { entries.push(entry); return null; };
        failure = new Error('ordinary transition failure');
        await expect(enable('synthetic secret', {})).rejects.toBe(failure);
        expect(entries).toHaveLength(0);
    }
    expect(capacities).toEqual([8 * 1024 * 1024, undefined]);
});
/** A server that refuses the password: a failure core does not retry, so a cycle fails at once. */
const failingFetch = (async (input: RequestInfo | URL) => {
    fetches.push(String(input));
    return new Response('', { status: 401, statusText: 'Unauthorized' });
}) as typeof fetch;

afterEach(() => {
    mock.restore();
    globalThis.fetch = realFetch;
    fetches.length = 0;
    delete globals.__mindwtrCryptoCall;
    setLogger(null);
    setSha256HexProvider(null);
    for (const name of nativeGlobals) {
        const original = originalGlobals.get(name);
        if (original === undefined) delete globals[name];
        else globals[name] = original;
    }
});

/** The same file-call wire read by nativeFileChannels, over existing memory files. */
const iosFiles = () => {
    setLogger(() => undefined);
    const memory = createMemoryFileSystem();
    const calls: string[] = [];
    globals.__mindwtrHostPlatform = 'ios';
    globals.__mindwtrNative = {
        fileDirectories: () => JSON.stringify({ document: DOCUMENTS, cache: CACHE }),
        fileDeleteNow: () => { calls.push('deleteNow'); throw new Error('Unexpected raw delete'); },
    };
    globals.__mindwtrFileCall = async (request: Record<string, unknown>) => {
        const op = String(request.op);
        const uri = String(request.uri ?? '');
        calls.push(op);
        switch (op) {
            case 'getInfo': return memory.fs.getInfo(uri);
            case 'makeDirectory': return memory.fs.makeDirectory(uri);
            case 'readDirectory': return memory.fs.readDirectory(uri);
            case 'barrier': case 'syncParent': return null;
            default: throw new Error('Unexpected fixture file operation');
        }
    };
    globals.__mindwtrInstallerCall = async () => { calls.push('installer'); throw new Error('Unexpected installer operation'); };
    return { memory, calls };
};

describe('explicit iOS foreground sync factory', () => {
    it('requires the selected cleanup callback and actual file channels instead of admitting no-op cleanup', () => {
        iosFiles();
        expect(() => host()).toThrow('Foreground sync requires owned attachment cleanup on this iOS build');
        delete globals.__mindwtrFileCall;
        expect(() => host({}, false, undefined, async () => false)).toThrow('Foreground sync requires native attachment files on this iOS build');
    });

    it('captures iOS without reading configuration and refuses automatic/background work while normal reconcile does nothing', async () => {
        const files = iosFiles();
        const fixture = host({ [SYNC_BACKEND_KEY]: 'cloudkit', untouched: 'fixture' }, false, undefined, async () => false);
        expect(fixture.sync.settingsHost.platform).toMatchObject({ os: 'ios', cloudKitAvailable: false });
        expect(fixture.sync.attachmentsHost).not.toBeNull();
        expect(fixture.calls).toEqual([]);
        expect(files.calls).toEqual([]);
        globals.__mindwtrHostPlatform = 'android';
        expect(fixture.sync.settingsHost.platform.os).toBe('ios');
        expect(() => fixture.sync.start('active')).toThrow('Automatic sync is not available on this iOS build');
        await expect(fixture.sync.backgroundSync('scheduled', 0)).rejects.toThrow('Background sync is not available on this iOS build');
        await expect(fixture.sync.backgroundSync('capture', 1)).rejects.toThrow('Background sync is not available on this iOS build');
        await fixture.sync.settingsHost.reconcileBackgroundSync();
        expect(fixture.calls).toEqual([]);
        expect(fixture.schedules).toEqual([]);
        expect(fixture.traces).toEqual([]);
        expect(files.calls).toEqual([]);
        expect([...fixture.kv]).toEqual([[SYNC_BACKEND_KEY, 'cloudkit'], ['untouched', 'fixture']]);
    });

    it('keeps the Android default for every platform value other than exact ios', async () => {
        globals.__mindwtrHostPlatform = 'IOS';
        const fixture = host();
        expect(fixture.sync.settingsHost.platform.os).toBe('android');
        expect(fixture.sync.attachmentsHost).toBeNull();
        await fixture.sync.settingsHost.reconcileBackgroundSync();
        expect(fixture.schedules).toEqual([false]);
    });

    it('passes the selected Task identity through the real cleanup lifecycle and preserves its fatal fence on iOS', async () => {
        resetForTests();
        const files = iosFiles();
        const date = '2026-10-06T00:00:00.000Z';
        const attachmentId = '00000000-0000-4000-8000-000000000315';
        const uri = `${MANAGED}${attachmentId}.txt`;
        const data: AppData = { tasks: [{ id: 'purged-task', title: 'Fixture', status: 'done', tags: [], contexts: [],
            createdAt: date, updatedAt: date, deletedAt: date, purgedAt: date,
            attachments: [{ id: attachmentId, kind: 'file', title: 'fixture.txt', uri, createdAt: date, updatedAt: date }] }],
            projects: [], sections: [], areas: [], settings: {} };
        const before = structuredClone(data);
        const fatal = new NativeAttachmentCleanupUnconfirmedError();
        const retire = mock(async (_id: string, _uri: string, keep: () => boolean) => {
            expect(keep()).toBe(false);
            throw fatal;
        });
        files.memory.put(uri, new Uint8Array([1, 2, 3]));
        globalThis.fetch = (async () => new Response(JSON.stringify(data), { status: 200, headers: { ETag: '"fixture"' } })) as typeof fetch;
        const fixture = host({ [SYNC_BACKEND_KEY]: 'webdav', [WEBDAV_URL_KEY]: 'https://fixture.invalid/data.json' }, false,
            async () => structuredClone(data), retire);
        const result = await fixture.sync.settingsHost.performSync(undefined, { manual: true }).catch((error: unknown) => error);
        expect(retire).toHaveBeenCalledWith(attachmentId, uri, expect.any(Function));
        expect(result).toBe(fatal);
        const at = fixture.calls.length;
        await expect(fixture.sync.settingsHost.reconcileBackgroundSync()).rejects.toBe(fatal);
        expect(fixture.calls.slice(at)).toEqual([]);
        expect(files.calls).not.toContain('deleteNow');
        expect(files.memory.read(uri)).toEqual(new Uint8Array([1, 2, 3]));
        expect(data).toEqual(before);
        resetForTests();
    });

    it('propagates the exact 8 MiB cap to real WebDAV attachment admission before snapshot or upload IO', async () => {
        resetForTests();
        const files = iosFiles();
        const date = '2026-10-06T00:00:00.000Z';
        const id = '00000000-0000-4000-8000-000000000316';
        const uri = `${MANAGED}${id}.txt`;
        const size = 8 * 1024 * 1024 + 1;
        const getInfo = files.memory.fs.getInfo;
        files.memory.fs.getInfo = async (target) => target === uri ? { exists: true, size, modificationTime: 1 } : getInfo(target);
        const data: AppData = { tasks: [{ id: 'live-task', title: 'Fixture', status: 'inbox', tags: [], contexts: [],
            createdAt: date, updatedAt: date, attachments: [{ id, kind: 'file', title: 'fixture.txt', uri, size, createdAt: date, updatedAt: date }] }],
            projects: [], sections: [], areas: [], settings: {} };
        const sent: string[] = [];
        globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
            sent.push(init?.method ?? 'GET');
            if (init?.method === 'PROPFIND') {
                return new Response(`<d:multistatus xmlns:d="DAV:"><d:response><d:href>${String(_input)}</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`, { status: 207 });
            }
            return new Response('', { status: init?.method === 'MKCOL' ? 201 : 404 });
        }) as typeof fetch;
        const retire = mock(async () => false);
        const fixture = host({ [SYNC_BACKEND_KEY]: 'webdav', [WEBDAV_URL_KEY]: 'https://fixture.invalid/data.json' }, false,
            async () => structuredClone(data), retire);
        expect(await fixture.sync.settingsHost.performSync(undefined, { manual: true })).toMatchObject({
            success: false, error: 'WebdavHostUploadLimitError: WebDAV attachment upload cannot be admitted by this host transport',
        });
        expect(files.calls).not.toContain('copy');
        expect(files.calls).not.toContain('sha256File');
        expect(files.calls).not.toContain('readBytes');
        expect(files.calls).not.toContain('readBytesRange');
        expect(files.calls).not.toContain('installer');
        expect(sent).not.toContain('PUT');
        expect(retire).not.toHaveBeenCalled();
        resetForTests();
    });
});

describe('event-owned iOS stored/resume pacing', () => {
    const data = (): AppData => ({ tasks: [], projects: [], sections: [], areas: [], settings: {} });
    const configured = (getData: () => Promise<AppData> = async () => data()) => {
        iosFiles();
        return host({ [SYNC_BACKEND_KEY]: 'webdav', [WEBDAV_URL_KEY]: 'https://fixture.invalid/data.json' },
            false, getData, async () => false);
    };
    const serve = () => {
        globalThis.fetch = (async () => new Response(JSON.stringify(data()), {
            status: 200, headers: { ETag: '"fixture-data"' },
        })) as typeof fetch;
    };
    afterEach(() => resetForTests());

    it('seeds resume pacing from cold completion and uses the strict shared 30-second boundary', async () => {
        resetForTests(); serve();
        let now = 100_000;
        spyOn(Date, 'now').mockImplementation(() => now);
        let entered!: () => void, release!: () => void;
        const reached = new Promise<void>((resolve) => { entered = resolve; });
        const held = new Promise<void>((resolve) => { release = resolve; });
        let first = true;
        const fixture = configured(async () => {
            if (first) { first = false; entered(); await held; }
            return data();
        });
        const operation = fixture.sync.performStoredAutomaticSync('startup');
        await reached;
        now += 20_000;
        release();
        expect(await operation).toMatchObject({ success: true });
        expect(fixture.sync.state().cycles).toBe(1);
        now += 30_000;
        expect(await fixture.sync.performStoredAutomaticSync('resume')).toEqual({ success: true, skipped: true });
        expect(fixture.sync.state().cycles).toBe(1);
        now += 1;
        expect(await fixture.sync.performStoredAutomaticSync('resume')).toMatchObject({ success: true });
        expect(fixture.sync.state().cycles).toBe(2);
        expect(fixture.schedules).toEqual([]);
    });

    it('retains cold failure cooldown across resume and clears it only after actual manual recovery', async () => {
        resetForTests(); globalThis.fetch = failingFetch;
        let now = 100_000;
        spyOn(Date, 'now').mockImplementation(() => now);
        const fixture = configured();
        expect(await fixture.sync.performStoredAutomaticSync('startup')).toEqual({ success: false, skipped: false });
        now += 30_001;
        expect(await fixture.sync.performStoredAutomaticSync('resume')).toEqual({ success: true, skipped: true });
        expect(fixture.sync.state().cycles).toBe(1);
        now += 30_000;
        expect(await fixture.sync.performStoredAutomaticSync('resume')).toEqual({ success: false, skipped: false });
        expect(fixture.sync.state().cycles).toBe(2);
        now += 30_001;
        serve();
        expect(await fixture.sync.settingsHost.performSync(undefined, { manual: true })).toMatchObject({ success: true });
        expect(await fixture.sync.performStoredAutomaticSync('resume')).toMatchObject({ success: true });
        expect(fixture.sync.state().cycles).toBe(4);
    });

    it('keeps shared offline skips outside automatic failure cooldown', async () => {
        resetForTests(); serve();
        let now = 100_000;
        spyOn(Date, 'now').mockImplementation(() => now);
        const fixture = configured(async () => { throw new Error('Network request failed'); });
        expect(await fixture.sync.performStoredAutomaticSync('startup')).toEqual({ success: true, skipped: true });
        now += 30_001;
        expect(await fixture.sync.performStoredAutomaticSync('resume')).toEqual({ success: true, skipped: true });
        expect(fixture.sync.state().cycles).toBe(2);
    });

    it('uses the real selected controller without installing timers and refuses an overlapping frame', async () => {
        resetForTests(); serve();
        const create = core.createAutoSyncController;
        const timer = mock(() => { throw new Error('No deferred controller work is permitted'); });
        spyOn(core, 'createAutoSyncController').mockImplementation((options) => {
            expect(options.allowDeferredWork).toBe(false);
            expect(options.periodicSyncIntervalMs).toBeNull();
            return create({ ...options, setTimer: timer });
        });
        let entered!: () => void, release!: () => void;
        const reached = new Promise<void>((resolve) => { entered = resolve; });
        const held = new Promise<void>((resolve) => { release = resolve; });
        const fixture = configured(async () => { entered(); await held; return data(); });
        const operation = fixture.sync.performStoredAutomaticSync('startup');
        await reached;
        await expect(fixture.sync.performStoredAutomaticSync('resume')).rejects.toThrow('already in progress');
        release();
        expect(await operation).toMatchObject({ success: true });
        expect(fixture.sync.state().cycles).toBe(1);
        globalThis.fetch = failingFetch;
        expect(await fixture.sync.performStoredAutomaticSync('startup')).toEqual({ success: false, skipped: false });
        expect(timer).not.toHaveBeenCalled();
        expect(fixture.schedules).toEqual([]);
    });

    for (const fatal of [false, true]) {
        it(`propagates the exact ${fatal ? 'fatal' : 'ordinary'} preflush error without service work`, async () => {
            resetForTests();
            const refusal = fatal ? new NativeAttachmentCleanupUnconfirmedError() : new Error('Synthetic flush refusal');
            const create = core.createAutoSyncController;
            spyOn(core, 'createAutoSyncController').mockImplementation((options) => create({
                ...options, flushPendingSave: async () => { throw refusal; },
            }));
            const fixture = configured();
            const fetch = mock(async () => { throw new Error('No HTTP after a failed flush'); });
            globalThis.fetch = fetch as typeof globalThis.fetch;
            await expect(fixture.sync.performStoredAutomaticSync('startup')).rejects.toBe(refusal);
            expect(fixture.sync.state().cycles).toBe(0);
            expect(fetch).not.toHaveBeenCalled();
            expect(fixture.calls).toEqual(['get']);
            if (fatal) {
                const at = fixture.calls.length;
                await expect(fixture.sync.performStoredAutomaticSync('resume')).rejects.toBe(refusal);
                await expect(fixture.sync.settingsHost.performSync(undefined, { manual: true })).rejects.toBe(refusal);
                await expect(fixture.sync.settingsHost.reconcileBackgroundSync()).rejects.toBe(refusal);
                expect(fixture.calls.slice(at)).toEqual([]);
            }
        });
    }

    it('retains an actual cleanup fatal before any completion state or later port work', async () => {
        resetForTests();
        const files = iosFiles();
        const date = '2026-10-06T00:00:00.000Z';
        const id = '00000000-0000-4000-8000-000000000341';
        const uri = `${MANAGED}${id}.txt`;
        const snapshot: AppData = { tasks: [{ id: 'purged-automatic-task', title: 'Fixture', status: 'done', tags: [], contexts: [],
            createdAt: date, updatedAt: date, deletedAt: date, purgedAt: date,
            attachments: [{ id, kind: 'file', title: 'fixture.txt', uri, createdAt: date, updatedAt: date }] }],
            projects: [], sections: [], areas: [], settings: {} };
        const fatal = new NativeAttachmentCleanupUnconfirmedError();
        files.memory.put(uri, new Uint8Array([1, 2, 3]));
        globalThis.fetch = (async () => new Response(JSON.stringify(snapshot), {
            status: 200, headers: { ETag: '"fixture-data"' },
        })) as typeof fetch;
        const retire = mock(async (_id: string, _uri: string, keep: () => boolean) => {
            expect(keep()).toBe(false); throw fatal;
        });
        const fixture = host({ [SYNC_BACKEND_KEY]: 'webdav', [WEBDAV_URL_KEY]: 'https://fixture.invalid/data.json' }, false,
            async () => structuredClone(snapshot), retire);
        await expect(fixture.sync.performStoredAutomaticSync('startup')).rejects.toBe(fatal);
        expect(retire).toHaveBeenCalledWith(id, uri, expect.any(Function));
        expect(fixture.sync.state().cycles).toBe(0);
        const before = [...fixture.kv], at = fixture.calls.length;
        await expect(fixture.sync.performStoredAutomaticSync('resume')).rejects.toBe(fatal);
        await expect(fixture.sync.settingsHost.performSync(undefined, { manual: true })).rejects.toBe(fatal);
        expect(fixture.calls.slice(at)).toEqual([]);
        expect([...fixture.kv]).toEqual(before);
        expect(files.memory.read(uri)).toEqual(new Uint8Array([1, 2, 3]));
        expect(files.calls).not.toContain('deleteNow');
    });

    it('never treats Test verification as an automatic timestamp or cooldown recovery', async () => {
        resetForTests(); globalThis.fetch = failingFetch;
        let now = 100_000;
        spyOn(Date, 'now').mockImplementation(() => now);
        const fixture = configured();
        expect(await fixture.sync.performStoredAutomaticSync('startup')).toEqual({ success: false, skipped: false });
        now += 30_001;
        expect(await fixture.sync.settingsHost.performSync(undefined, {
            manual: true, activationProbe: true, configOverride: { backend: 'off' },
        })).toMatchObject({ success: true });
        expect(await fixture.sync.performStoredAutomaticSync('resume')).toEqual({ success: true, skipped: true });
        expect(fixture.sync.state().cycles).toBe(2);
    });

    it('refuses Android stored/resume calls without any port access', async () => {
        globals.__mindwtrHostPlatform = 'android';
        const fixture = host();
        await expect(fixture.sync.performStoredAutomaticSync('startup')).rejects.toThrow('unavailable');
        await expect(fixture.sync.performStoredAutomaticSync('resume')).rejects.toThrow('unavailable');
        expect(fixture.calls).toEqual([]);
    });
});

describe('invocation-owned iOS service settlement', () => {
    for (const platform of ['ios', 'android'] as const) {
        it(`${platform} ${platform === 'ios' ? 'defers' : 'preserves'} the ordinary remote-fence follow-up`, async () => {
            resetForTests();
            if (platform === 'ios') iosFiles();
            else globals.__mindwtrHostPlatform = 'android';
            const date = '2026-10-06T00:00:00.000Z';
            const data: AppData = { tasks: [{ id: 'follow-up-fixture', title: 'Synthetic local Task', status: 'inbox',
                contexts: [], tags: [], createdAt: date, updatedAt: date }], projects: [], sections: [], areas: [], settings: {} };
            let reads = 0;
            const serverNow = Math.floor(Date.now() / 1000) * 1000;
            globalThis.fetch = (async (input: RequestInfo | URL) => {
                if (String(input).endsWith('/data.json')) return new Response(JSON.stringify({
                    tasks: [], projects: [], sections: [], areas: [], settings: {},
                }), { status: 200, headers: { Date: new Date(serverNow).toUTCString(), ETag: '"fixture-data"' } });
                expect(String(input)).toContain('.mindwtr-sync-fence-v1.json');
                reads += 1;
                if (reads !== 1) return new Response('', { status: 403 });
                return new Response(JSON.stringify({ schema: 1, leaseId: 'synthetic-peer-lease', ownerId: 'synthetic-peer',
                    purpose: 'ordinary-sync', expiresAt: serverNow + 1_000 }),
                    { status: 200, headers: { Date: new Date(serverNow).toUTCString(), ETag: '"fixture-fence"' } });
            }) as typeof fetch;
            const fixture = host({ [SYNC_BACKEND_KEY]: 'webdav', [WEBDAV_URL_KEY]: 'https://fixture.invalid/data.json' }, false,
                async () => structuredClone(data), platform === 'ios' ? async () => false : undefined);
            try {
                await fixture.sync.settingsHost.rememberWebdavCapabilityProof({
                    url: 'https://fixture.invalid/data.json', username: '', password: '', allowInsecureHttp: false,
                });
                expect(await fixture.sync.settingsHost.performSync(undefined, { manual: true })).toMatchObject({
                    success: true, skipped: 'remoteFenceBusy', retryAfterMs: 1_000,
                });
                expect(reads).toBe(1);
                const at = fixture.calls.length;
                await new Promise((resolve) => setTimeout(resolve, 1_200));
                expect(reads).toBe(platform === 'ios' ? 1 : 2);
                if (platform === 'ios') {
                    expect(fixture.calls.slice(at)).toEqual([]);
                    expect(fixture.lines).not.toContain('Sync follow-up scheduled');
                } else expect(fixture.lines).toContain('Sync follow-up scheduled');
            } finally { resetForTests(); }
        });

        it(`${platform} ${platform === 'ios' ? 'awaits' : 'keeps detached'} its own configuration refresh`, async () => {
            resetForTests();
            if (platform === 'ios') iosFiles();
            else globals.__mindwtrHostPlatform = 'android';
            const fixture = host({}, false, undefined, platform === 'ios' ? async () => false : undefined);
            let entered!: () => void, release!: () => void;
            const reached = new Promise<void>((resolve) => { entered = resolve; });
            const gate = new Promise<void>((resolve) => { release = resolve; });
            const get = fixture.bindings.keyValue.get;
            let backendReads = 0;
            fixture.bindings.keyValue.get = async (key) => {
                const value = await get(key);
                if (key === SYNC_BACKEND_KEY && ++backendReads === 2) { entered(); await gate; }
                return value;
            };
            let settled = false;
            const operation = fixture.sync.settingsHost.performSync(undefined, { manual: true });
            void operation.then(() => { settled = true; });
            try {
                await reached;
                await Promise.resolve(); await Promise.resolve();
                expect(settled).toBe(platform === 'android');
                release();
                expect(await operation).toMatchObject({ success: true });
                await Promise.resolve(); await Promise.resolve();
                expect(fixture.sync.state().cycles).toBe(1);
            } finally {
                release(); await operation; resetForTests();
            }
        });
    }
});

describe('native background sync binding', () => {
    it('manual sync preserves fatal cleanup identity without a cycle increment or any post-fatal host work', async () => {
        globalThis.fetch = (async () => new Response('', { status: 404 })) as typeof fetch;
        const fatal = new NativeAttachmentCleanupUnconfirmedError();
        let at!: { cycles: number; calls: number; lines: number; traces: number; kv: [string, string][] };
        const fixture = host({ [SYNC_BACKEND_KEY]: 'webdav', [WEBDAV_URL_KEY]: 'https://dav.example.com' }, false, async () => {
            at = { cycles: fixture.sync.state().cycles, calls: fixture.calls.length, lines: fixture.lines.length,
                traces: fixture.traces.length, kv: [...fixture.kv] };
            throw fatal;
        });
        const result = await fixture.sync.settingsHost.performSync(undefined, { manual: true }).catch((error: unknown) => error);
        expect(at).toBeDefined();
        expect(result).toBe(fatal);
        await Promise.resolve();
        await Promise.resolve();
        expect(fixture.sync.state().cycles).toBe(at.cycles);
        expect(fixture.calls.slice(at.calls)).toEqual([]);
        expect(fixture.lines.slice(at.lines)).toEqual([]);
        expect(fixture.traces.slice(at.traces)).toEqual([]);
        expect([...fixture.kv]).toEqual(at.kv);
    });

    it('manual sync with an ordinary same-name error retains the normal cycle and configuration refresh', async () => {
        globalThis.fetch = (async () => new Response('', { status: 404 })) as typeof fetch;
        let read = false;
        const fixture = host({ [SYNC_BACKEND_KEY]: 'webdav', [WEBDAV_URL_KEY]: 'https://dav.example.com' }, false, async () => {
            read = true;
            throw Object.assign(new Error('ordinary local read failure'), { name: 'NativeAttachmentCleanupUnconfirmedError' });
        });
        expect(await fixture.sync.settingsHost.performSync(undefined, { manual: true })).toMatchObject({ success: false });
        expect(read).toBe(true);
        expect(fixture.sync.state().cycles).toBe(1);
        await fixture.sync.settingsHost.reconcileBackgroundSync();
        expect(fixture.calls).toContain('get');
        expect(fixture.traces.some((line) => line.includes('cycles=1'))).toBe(true);
    });

    it('a successful disabled manual cycle refreshes configuration and emits its new cycle count', async () => {
        const { sync, traces } = host();
        expect(await sync.settingsHost.performSync(undefined, { manual: true })).toMatchObject({ success: true });
        expect(sync.state().cycles).toBe(1);
        await sync.settingsHost.reconcileBackgroundSync();
        expect(traces.some((line) => line.includes('cycles=1'))).toBe(true);
    });

    for (const completion of ['resolve', 'reject'] as const) {
        it(`fences earlier configuration refresh and scheduling when held reads ${completion} after a fatal manual sync`, async () => {
            globalThis.fetch = (async () => new Response('', { status: 404 })) as typeof fetch;
            const fatal = new NativeAttachmentCleanupUnconfirmedError();
            const fixture = host({ [SYNC_BACKEND_KEY]: 'webdav', [WEBDAV_URL_KEY]: 'https://dav.example.com' }, false, async () => { throw fatal; });
            const held: { resolve: (value: string | null) => void; reject: (error: Error) => void }[] = [];
            let allEntered!: () => void;
            const entered = new Promise<void>((resolve) => { allEntered = resolve; });
            let holding = true;
            const get = fixture.bindings.keyValue.get;
            fixture.bindings.keyValue.get = async (key) => {
                const value = await get(key);
                if (holding && key === WEBDAV_URL_KEY) {
                    return new Promise<string | null>((resolve, reject) => {
                        held.push({ resolve, reject });
                        if (held.length === 3) allEntered();
                    });
                }
                return value;
            };
            // Successful verification's finally refresh uses this same path; an Off
            // cycle admits it here without a second synthetic remote-write fixture.
            expect(await fixture.sync.settingsHost.performSync(undefined, { manual: true, configOverride: { backend: 'off' } })).toMatchObject({ success: true });
            const reconcile = fixture.sync.settingsHost.reconcileBackgroundSync().catch((error: unknown) => error);
            await entered;
            holding = false;
            await expect(fixture.sync.settingsHost.performSync(undefined, { manual: true })).rejects.toBe(fatal);
            const at = { calls: fixture.calls.length, schedules: fixture.schedules.length, lines: fixture.lines.length,
                traces: fixture.traces.length, state: fixture.sync.state() };
            expect(held).toHaveLength(3);
            for (const read of held) {
                if (completion === 'resolve') read.resolve('https://dav.example.com');
                else read.reject(fatal);
            }
            expect(await reconcile).toBe(fatal);
            await Promise.resolve();
            expect(fixture.calls.slice(at.calls)).toEqual([]);
            expect(fixture.schedules.slice(at.schedules)).toEqual([]);
            expect(fixture.lines.slice(at.lines)).toEqual([]);
            expect(fixture.traces.slice(at.traces)).toEqual([]);
            expect(fixture.sync.state()).toEqual(at.state);
            expect(fixture.sync.state().cycles).toBe(1);
            await expect(fixture.sync.settingsHost.reconcileBackgroundSync()).rejects.toBe(fatal);
            expect(fixture.calls.slice(at.calls)).toEqual([]);
        });
    }

    it('keeps the ordinary fallback emission when an earlier refresh read rejects', async () => {
        const fixture = host({ [SYNC_BACKEND_KEY]: 'webdav', [WEBDAV_URL_KEY]: 'https://dav.example.com' });
        const held: ((error: Error) => void)[] = [];
        let allEntered!: () => void;
        const entered = new Promise<void>((resolve) => { allEntered = resolve; });
        const get = fixture.bindings.keyValue.get;
        fixture.bindings.keyValue.get = async (key) => {
            const value = await get(key);
            if (key === WEBDAV_URL_KEY) return new Promise<string | null>((_resolve, reject) => {
                held.push(reject);
                if (held.length === 2) allEntered();
            });
            return value;
        };
        const ordinary = new Error('ordinary configuration read failure');
        const reconcile = fixture.sync.settingsHost.reconcileBackgroundSync().catch((error: unknown) => error);
        await entered;
        for (const reject of held) reject(ordinary);
        expect(await reconcile).toBe(ordinary);
        await Promise.resolve();
        expect(fixture.traces).toContain('Native Android sync state badge=hidden cycles=0');
        expect(fixture.calls).toContain('emit');
        expect(fixture.schedules).toEqual([]);
    });

    it('schedules the background job only for a configured WebDAV or cloud backend (core\'s decision)', async () => {
        const off = host();
        await off.sync.settingsHost.reconcileBackgroundSync();
        expect(off.schedules).toEqual([false]);
        const webdav = host({ [SYNC_BACKEND_KEY]: 'webdav', [WEBDAV_URL_KEY]: 'http://127.0.0.1:1/dav' });
        await webdav.sync.settingsHost.reconcileBackgroundSync();
        expect(webdav.schedules).toEqual([true]);
        const file = host({ [SYNC_BACKEND_KEY]: 'file', '@mindwtr_sync_path': 'content://folder' });
        await file.sync.settingsHost.reconcileBackgroundSync();
        expect(file.schedules).toEqual([false]);
    });

    // Review S4a 4: the schedule is reported only once WorkManager stored it; a refusal reaches the caller (and is retried at the
    // next start, resume or leave, which reconcile again).
    it('reports the job scheduled only once the host stored it; a refusal fails the reconcile', async () => {
        const { sync, traces } = host({ [SYNC_BACKEND_KEY]: 'webdav', [WEBDAV_URL_KEY]: 'http://127.0.0.1:1/dav' }, true);
        await expect(sync.settingsHost.reconcileBackgroundSync()).rejects.toThrow('WorkManager did not store the work');
        expect(traces.filter((line) => line.startsWith('Native Android background sync schedule'))).toEqual([]);
        const stored = host({ [SYNC_BACKEND_KEY]: 'webdav', [WEBDAV_URL_KEY]: 'http://127.0.0.1:1/dav' });
        await stored.sync.settingsHost.reconcileBackgroundSync();
        expect(stored.traces).toContain('Native Android background sync schedule=on');
    });

    it('a capture run with nothing imported sends nothing; one with an import syncs and records its failure', async () => {
        globalThis.fetch = failingFetch;
        const { sync, kv } = host({ [SYNC_BACKEND_KEY]: 'webdav', [WEBDAV_URL_KEY]: 'http://127.0.0.1:1/dav' });
        expect(await sync.backgroundSync('capture', 0)).toEqual({ schedule: true });
        expect(kv.has(BACKGROUND_SYNC_FAILURE_STATE_KEY)).toBe(false);
        await sync.backgroundSync('capture', 1);
        expect(JSON.parse(kv.get(BACKGROUND_SYNC_FAILURE_STATE_KEY)!).consecutiveFailures).toBe(1);
    });

    it('a scheduled run inside the failure cooldown is skipped and fetches nothing', async () => {
        globalThis.fetch = failingFetch;
        const { sync, lines } = host({
            [SYNC_BACKEND_KEY]: 'webdav',
            [WEBDAV_URL_KEY]: 'http://127.0.0.1:1/dav',
            [BACKGROUND_SYNC_FAILURE_STATE_KEY]: JSON.stringify({ lastFailureAt: Date.now(), consecutiveFailures: 1 }),
        });
        expect(await sync.backgroundSync('scheduled', 0)).toEqual({ schedule: true });
        expect(fetches).toEqual([]);
        expect(lines).toContain('Mobile background sync skipped during failure cooldown');
    });

    it('answers schedule false once sync is off, so the running job does not queue its next run', async () => {
        const { sync } = host();
        expect(await sync.backgroundSync('scheduled', 0)).toEqual({ schedule: false });
    });

    it('refuses a sync request that would start past the run\'s deadline (RN\'s setMobileSyncRequestDeadline)', async () => {
        const deadline = createDeadlineFetch(failingFetch);
        expect((await deadline.fetch('http://a/1')).status).toBe(401);
        deadline.setDeadline(Date.now() - 1);
        await expect(deadline.fetch('http://a/2')).rejects.toMatchObject({ name: 'AbortError' });
        deadline.setDeadline(null);
        expect((await deadline.fetch('http://a/3')).status).toBe(401);
        expect(fetches).toEqual(['http://a/1', 'http://a/3']);
    });

    // About 35 s: the aborted cycle's WebDAV read retries (core's backoff) before it ends; none of them is sent (the signal is
    // aborted, so the host's fetch refuses each before it starts).
    it('a run abandoned at its deadline ends its cycle with no follow-up: the job, not a timer, retries it (review S4a 1)', async () => {
        const sent: string[] = [];
        globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_, reject) => {
            const cancelled = () => reject(Object.assign(new Error('Request cancelled'), { name: 'AbortError' }));
            if (init?.signal?.aborted) return cancelled();
            sent.push(String(input));
            init?.signal?.addEventListener('abort', cancelled);
        })) as typeof fetch;
        const { sync, kv, lines } = host({ [SYNC_BACKEND_KEY]: 'webdav', [WEBDAV_URL_KEY]: 'http://127.0.0.1:1/dav' });
        await sync.backgroundSync('scheduled', 0, 50);
        expect(lines).toContain('Mobile background sync did not finish before its deadline and was abandoned');
        expect(JSON.parse(kv.get(BACKGROUND_SYNC_FAILURE_STATE_KEY)!).consecutiveFailures).toBe(1);
        for (let waited = 0; waited < 50_000 && !lines.includes('Sync aborted at the background run\'s deadline'); waited += 500) {
            await new Promise((done) => setTimeout(done, 500));
        }
        expect(lines).toContain('Sync aborted at the background run\'s deadline');
        await new Promise((done) => setTimeout(done, 1_000));
        expect(lines).not.toContain('Sync follow-up scheduled');
        expect(sent).toHaveLength(1);
    }, 60_000);
});
