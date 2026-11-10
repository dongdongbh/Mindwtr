import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createContext, runInContext } from 'node:vm';
import { transform } from 'esbuild';
import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test';
import * as core from '@mindwtr/core';
import {
    BACKGROUND_SYNC_FAILURE_STATE_KEY,
    CLOUD_PROVIDER_KEY,
    CLOUD_TOKEN_KEY,
    CLOUD_URL_KEY,
    NativeAttachmentCleanupUnconfirmedError,
    SyncEncryptionArtifactCapacityError,
    SYNC_BACKEND_KEY,
    SYNC_ENCRYPTION_KEY_KEY,
    SYNC_ENCRYPTION_STATE_KEY,
    SYNC_CRYPTO_DEFAULT_KDF_PARAMS,
    WEBDAV_URL_KEY,
    resetForTests,
    setSha256HexProvider,
    setLogger,
    consoleLogger,
    type AppData,
} from '@mindwtr/core';
import { createDeadlineFetch, createIosDirectoryFileSync, createNativeSync } from './host-sync';
import { serveWebdav, webdavDocument } from '../scripts/webdav-harness.mjs';
import type { NativeAttachmentBindings } from './host-attachments';
import { createMemoryFileSystem, CACHE, DOCUMENTS, MANAGED } from '../../../packages/core/src/__fixtures__/mobile-attachment-fakes';


const globals = globalThis as unknown as Record<string, unknown>;
const realFetch = globalThis.fetch;
const nativeGlobals = ['__mindwtrHostPlatform', '__mindwtrNative', '__mindwtrFileCall', '__mindwtrInstallerCall'];
const originalGlobals = new Map(nativeGlobals.map((name) => [name, globals[name]]));

const host = (stored: Record<string, string> = {}, refuseSchedule = false, getData?: () => Promise<AppData>,
    retireLocalAttachment?: NativeAttachmentBindings['retireLocalAttachment']) => {
    const kv = new Map(Object.entries(stored));
    const schedules: boolean[] = [];
    const lines: string[] = [];
    const entries: core.DiagnosticsLogEntry[] = [];
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
        localData: () => ({
            getData: getData ?? (async () => { throw new Error('no local data in this test'); }),
            saveData: async () => undefined,
            readTokenOf: () => undefined,
            prepareSaveRows: function* () {                          },
        }),
        networkState: () => { calls.push('networkState'); return { isConnected: true, isInternetReachable: true }; },
        appendLog: async (entry) => { calls.push('appendLog'); lines.push(entry.message); entries.push(entry); return null; },
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
    return { sync, kv, schedules, lines, entries, traces, calls, bindings };
};

it.each(['android', 'ios'] as const)('forwards the shared WebDAV setup failure receipt through the %s log binding', async (platform) => {
    resetForTests();
    core.useTaskStore.setState({ _allTasks: [], _allProjects: [], _allSections: [], _allAreas: [], _allPeople: [], settings: {} } as never);
    if (platform === 'ios') iosFiles();
    globals.__mindwtrHostPlatform = platform;
    const data: AppData = { tasks: [], projects: [], sections: [], areas: [], settings: {} };
    core.setStorageAdapter({ getData: async () => structuredClone(data), saveData: async () => undefined });
    const fixture = host({ [SYNC_BACKEND_KEY]: 'webdav', [WEBDAV_URL_KEY]: 'https://dav.example.com/data.json' }, false,
        async () => structuredClone(data), async () => false);
    const receipts: { entry: core.DiagnosticsLogEntry; force?: boolean }[] = [];
    fixture.bindings.appendLog = async (entry, force) => { receipts.push({ entry, force }); return null; };
    const contract = core.createNativeHostContract({ syncSettings: fixture.sync.settingsHost });
    expect((await contract.activate({ writeSafetyReady: true })).ok).toBe(true);
    expect((await contract.openSyncSettings({})).ok).toBe(true);
    globalThis.fetch = (async () => new Response('private server body', { status: 401 })) as typeof fetch;
    const tested = await contract.testSyncConnection({ webdav: {
        url: 'https://dav.example.com/data.json', username: 'alice', password: 'secret', allowInsecureHttp: false,
    } });
    expect(tested.ok).toBe(true);
    expect(receipts.filter(({ entry }) => entry.context?.releaseCheck === 'v1.3.5/webdav-setup-probe')).toEqual([{
        force: true, entry: expect.objectContaining({ message: 'WebDAV setup compatibility probe', scope: 'sync-settings', context: {
            releaseCheck: 'v1.3.5/webdav-setup-probe', phase: 'compatibility', outcome: 'failed',
            reason: 'http', requireStrongEtag: 'false', httpStatus: '401',
        } }),
    }]);
    expect(JSON.stringify(receipts)).not.toContain('private server body');
    expect(fixture.kv.get(SYNC_BACKEND_KEY)).toBe('webdav');
    resetForTests();
});

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
            try { await provide('synthetic secret'); } catch {                                       }
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
        entries.length = 0;
        sync.settingsHost.encryption.mode = 'saved-webdav-or-local';
        expect(await provide('synthetic secret')).toBe('ok');
        expect(entries).toHaveLength(platform === 'ios' ? 1 : 0);
    }
});

it.each(['saved-webdav', 'saved-webdav-or-local'] as const)('records selected iOS encryption settlement for %s without changing a completed outcome when logging fails', async (mode) => {
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
    sync.settingsHost.encryption.mode = mode;
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

const failingFetch = (async (input: RequestInfo | URL) => {
    fetches.push(String(input));
    return new Response('', { status: 401, statusText: 'Unauthorized' });
}) as typeof fetch;

afterEach(() => {
    mock.restore();
    globalThis.fetch = realFetch;
    fetches.length = 0;
    delete globals.__mindwtrCryptoCall;
    setLogger(consoleLogger);
    setSha256HexProvider(null);
    for (const name of nativeGlobals) {
        const original = originalGlobals.get(name);
        if (original === undefined) delete globals[name];
        else globals[name] = original;
    }
});


const iosFiles = () => {
    setLogger(() => undefined);
    const memory = createMemoryFileSystem();
    const calls: string[] = [];
    globals.__mindwtrHostPlatform = 'ios';
    globals.__mindwtrNative = {
        fileDirectories: () => JSON.stringify({ document: DOCUMENTS, cache: CACHE }),
        fileDeleteNow: () => { calls.push('deleteNow'); throw new Error('Unexpected raw delete'); },
    };
    globals.__mindwtrFileCall = async (request: Record<string, unknown>, bytes?: Uint8Array) => {
        const op = String(request.op);
        const uri = String(request.uri ?? '');
        calls.push(op);
        switch (op) {
            case 'sha256': if (!bytes) throw new Error('Missing hash body'); return createHash('sha256').update(bytes).digest('hex');
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
    it('binds cloud and WebDAV buffered upload caps only on iOS through the real attachment factory', () => {
        const create = core.createMobileAttachmentBackends;
        const captured: Parameters<typeof create>[] = [];
        spyOn(core, 'createMobileAttachmentBackends').mockImplementation((options) => {
            captured.push([options]);
            return create(options);
        });
        for (const platform of ['ios', 'android']) {
            iosFiles();
            globals.__mindwtrHostPlatform = platform;
            host({}, false, undefined, async () => false);
            const options = captured.at(-1)![0];
            expect(options.maxCloudBufferedUploadBytes).toBe(platform === 'ios' ? 8 * 1024 * 1024 : undefined);
            expect(options.maxWebdavBufferedUploadBytes).toBe(platform === 'ios' ? 8 * 1024 * 1024 : undefined);
            expect(options.boundedWebdavResponses).toBe(true);
        }
        expect(captured).toHaveLength(2);
    });

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

describe('iOS self-hosted foreground admission', () => {
    const endpoint = 'https://fixture.invalid/v1/data';
    const token = 'synthetic-token-for-398';
    const data = (): AppData => ({ tasks: [], projects: [], sections: [], areas: [], settings: {} });
    const configured = async (extra: Record<string, string> = {}, local = data()) => {
        resetForTests(); iosFiles();

        core.useTaskStore.setState({ _allTasks: [], _allProjects: [], _allSections: [], _allAreas: [], _allPeople: [], settings: {} } as never);
        const fixture = host({ [SYNC_BACKEND_KEY]: 'cloud', [CLOUD_URL_KEY]: endpoint, ...extra }, false,
            async () => structuredClone(local), async () => false);
        fixture.sync.settingsHost.encryption.mode = 'saved-webdav-or-local';
        core.setStorageAdapter({ getData: async () => structuredClone(local), saveData: async () => undefined });
        const secrets = new Map<string, string>();
        fixture.bindings.secrets.getSecret = async (name) => secrets.get(name) ?? null;
        fixture.bindings.secrets.setSecret = async (name, value) => { secrets.set(name, value); };
        fixture.bindings.secrets.deleteSecret = async (name) => { secrets.delete(name); };
        await fixture.sync.settingsHost.secrets.set(CLOUD_TOKEN_KEY, token);
        return { ...fixture, secrets };
    };
    const serve = () => {
        const requests: { method: string; body: string; authorization: string | null }[] = [];
        globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
            requests.push({ method: init?.method ?? 'GET', body: String(init?.body ?? ''),
                authorization: new Headers(init?.headers).get('Authorization') });
            return new Response(init?.method === 'HEAD' ? null : JSON.stringify(data()), {
                status: 200, headers: { ETag: '"fixture-data"' },
            });
        }) as typeof fetch;
        return requests;
    };

    it.each(['enable', 'change-passphrase', 'disable'] as const)('refuses a stored self-hosted %s interruption before any HTTP or mutation', async (kind) => {
        const state = JSON.stringify({ state: kind === 'enable' ? 'off' : 'enabled', incompleteTransition: kind });
        const fixture = await configured({ [CLOUD_PROVIDER_KEY]: 'selfhosted', [SYNC_ENCRYPTION_STATE_KEY]: state });
        const requests = serve();
        const before = [...fixture.kv];
        const secretsBefore = [...fixture.secrets];

        await expect(fixture.sync.settingsHost.performSync(undefined, { manual: true }))
            .rejects.toBeInstanceOf(core.SyncEncryptionTransitionIncompleteError);

        expect(requests).toEqual([]);
        expect([...fixture.kv]).toEqual(before);
        expect([...fixture.secrets]).toEqual(secretsBefore);
        expect(fixture.schedules).toEqual([]);
        expect(fixture.lines).toContain('Native iOS self-hosted encryption admission refused');
        expect(fixture.entries.filter((entry) => entry.message === 'Native iOS self-hosted encryption admission refused')
            .map((entry) => entry.context)).toEqual([{
            releaseCheck: 'v1.3.5/ios-selfhosted-encryption-guard', operation: 'admission', outcome: 'refused',
        }]);
    });

    it('checks the activation override instead of trusting the previously stored WebDAV provider', async () => {
        const fixture = await configured({ [SYNC_BACKEND_KEY]: 'webdav', [WEBDAV_URL_KEY]: 'https://fixture.invalid/data.json',
            [SYNC_ENCRYPTION_STATE_KEY]: JSON.stringify({ state: 'off', incompleteTransition: 'enable' }) });
        const requests = serve();

        await expect(fixture.sync.settingsHost.performSync(undefined, { manual: true, activationProbe: true,
            configOverride: { backend: 'cloud', cloudProvider: 'selfhosted', cloud: { url: endpoint, token: 'synthetic-token', allowInsecureHttp: false } },
        })).rejects.toBeInstanceOf(core.SyncEncryptionTransitionIncompleteError);

        expect(requests).toEqual([]);
        expect(fixture.kv.get(SYNC_BACKEND_KEY)).toBe('webdav');
    });

    it('retains the original incomplete-transition refusal when diagnostics reject', async () => {
        const fixture = await configured({ [SYNC_ENCRYPTION_STATE_KEY]: JSON.stringify({ state: 'off', incompleteTransition: 'enable' }) });
        fixture.bindings.appendLog = async () => { throw new Error('sink unavailable'); };
        const requests = serve();

        await expect(fixture.sync.assertSelfHostedSyncAdmission()).rejects.toBeInstanceOf(core.SyncEncryptionTransitionIncompleteError);

        expect(requests).toEqual([]);
    });

    it('inherits the stored provider when an activation override omits it instead of admitting an unbound provider', async () => {
        const fixture = await configured({ [CLOUD_PROVIDER_KEY]: 'dropbox' });
        const requests = serve();

        await expect(fixture.sync.settingsHost.performSync(undefined, { manual: true, activationProbe: true,
            configOverride: { backend: 'cloud' },
        })).rejects.toThrow('provider is not available');

        expect(requests).toEqual([]);
        expect(fixture.kv.get(CLOUD_PROVIDER_KEY)).toBe('dropbox');
    });

    const open = async (fixture: Awaited<ReturnType<typeof configured>>) => {
        await core.flushPendingSave();
        const contract = core.createNativeHostContract({ syncSettings: fixture.sync.settingsHost });
        const activated = await contract.activate({ writeSafetyReady: true });
        if (!activated.ok) throw new Error(activated.error.message);
        const model = await contract.openSyncSettings({});
        if (!model.ok) throw new Error(model.error.message);
        return { contract, model: model.value };
    };

    it('uses the actual shared self-hosted Test/Save/Sync contract with null-token reuse, exact replay and stale revision refusal', async () => {
        const fixture = await configured({ [CLOUD_PROVIDER_KEY]: 'selfhosted' });
        const requests = serve();
        const { contract, model } = await open(fixture);
        const fields = { url: endpoint, token: null, allowInsecureHttp: false };
        const before = [...fixture.kv];
        const secretsBefore = [...fixture.secrets];
        await fixture.sync.assertSelfHostedSyncAdmission();
        expect((await contract.testSyncConnection({ selfHosted: fields })).ok).toBe(true);
        expect(requests.map((request) => request.method)).toEqual(['GET']);
        expect([...fixture.kv]).toEqual(before);
        const save = { requestId: core.generateUUID(), revision: model.configRevision, selfHosted: fields };
        const saved = await contract.saveSyncBackend(save);
        expect(saved.ok).toBe(true);
        const count = requests.length;
        expect(await contract.saveSyncBackend(save)).toEqual(saved);
        expect(requests).toHaveLength(count);
        expect([...fixture.secrets]).toEqual(secretsBefore);
        expect(requests.every((request) => request.authorization === `Bearer ${token}`)).toBe(true);
        const fresh = contract.getSyncSettings({});
        if (!fresh.ok) throw new Error(fresh.error.message);
        expect((await contract.syncNow({ requestId: core.generateUUID(), revision: fresh.value.configRevision, selfHosted: fields })).ok).toBe(true);
        await core.flushPendingSave();
        const stable = contract.getSyncSettings({});
        if (!stable.ok) throw new Error(stable.error.message);
        fixture.kv.set(CLOUD_URL_KEY, 'https://external.invalid/v1/data');
        const at = requests.length;
        expect(await contract.saveSyncBackend({ ...save, requestId: core.generateUUID(), revision: stable.value.configRevision }))
            .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        expect(requests).toHaveLength(at);
        expect(fixture.kv.get(CLOUD_URL_KEY)).toBe('https://external.invalid/v1/data');
        await contract.closeSyncSettings({});
    });

    it('keeps the proven WebDAV configuration and secure token when shared self-hosted selection/activation fails', async () => {
        const fixture = await configured({ [SYNC_BACKEND_KEY]: 'webdav', [WEBDAV_URL_KEY]: 'https://old.invalid/data.json' });
        const { contract } = await open(fixture);
        const before = [...fixture.kv];
        const secretsBefore = [...fixture.secrets];
        const requests: string[] = [];
        globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
            requests.push(init?.method ?? 'GET');
            return new Response('synthetic failure', { status: 403 });
        }) as typeof fetch;

        const result = await contract.selectSyncBackend({ requestId: core.generateUUID(), option: 'selfhosted' });

        expect(result.ok).toBe(true);
        if (!result.ok) throw new Error(result.error.message);
        expect(result.value.toasts.some((toast) => toast.tone === 'error')).toBe(true);
        expect(requests.length).toBeGreaterThan(0);
        expect(requests).not.toContain('PUT');
        expect([...fixture.kv]).toEqual(before);
        expect([...fixture.secrets]).toEqual(secretsBefore);
        await contract.closeSyncSettings({});
    });

    it.each([undefined, '', 'selfhosted', ' selfhosted '])('admits the shared self-hosted provider default %s through the existing stored foreground owner', async (provider) => {
        const fixture = await configured(provider === undefined ? {} : { [CLOUD_PROVIDER_KEY]: provider });
        const requests = serve();

        expect(await fixture.sync.performStoredAutomaticSync('startup')).toMatchObject({ success: true });

        expect(requests.some((request) => request.method === 'GET')).toBe(true);
        expect(requests.every((request) => request.authorization === `Bearer ${token}`)).toBe(true);
        expect(fixture.kv.get(CLOUD_PROVIDER_KEY)).toBe(provider);
        expect(fixture.schedules).toEqual([]);
    });

    it.each(['dropbox', 'cloudkit', 'file', 'unknown'])('refuses explicit unsupported stored cloud provider %s before HTTP', async (provider) => {
        const fixture = await configured({ [CLOUD_PROVIDER_KEY]: provider });
        const requests = serve();
        const before = [...fixture.kv];

        await expect(fixture.sync.performStoredAutomaticSync('startup')).rejects.toThrow('provider is not available');

        expect(requests).toEqual([]);
        expect([...fixture.kv]).toEqual(before);
    });

    it.each(['enabled', 'remote-encrypted-no-key', 'remote-plaintext', 'quarantine elsewhere'] as const)(
        'uses self-hosted plaintext while retaining complete local posture %s and material', async (posture) => {
            const state = JSON.stringify(posture === 'quarantine elsewhere'
                ? { state: 'off', partlyEncryptedScope: JSON.stringify(['webdav', 'https://elsewhere.invalid', 'synthetic']) }
                : { state: posture, discoveredScope: JSON.stringify(['webdav', 'https://elsewhere.invalid', 'synthetic']),
                    discoveredSalt: '01'.repeat(16), discoveredParams: SYNC_CRYPTO_DEFAULT_KDF_PARAMS });
            const local = data();
            local.tasks.push({ id: 'local-398', title: 'Synthetic', status: 'inbox', tags: [], contexts: [],
                createdAt: '2026-10-07T00:00:00.000Z', updatedAt: '2026-10-07T00:00:00.000Z' });
            const fixture = await configured({ [CLOUD_PROVIDER_KEY]: 'selfhosted', [SYNC_ENCRYPTION_STATE_KEY]: state }, local);
            await fixture.sync.settingsHost.secrets.set(SYNC_ENCRYPTION_KEY_KEY, Buffer.alloc(32, 7).toString('base64'));
            const secretsBefore = [...fixture.secrets];
            const requests = serve();

            expect(await fixture.sync.settingsHost.performSync(undefined, { manual: true })).toMatchObject({ success: true });

            expect(requests.some((request) => request.method === 'GET')).toBe(true);
            expect(requests.filter((request) => request.method === 'PUT')).toHaveLength(1);
            expect(requests.filter((request) => request.method === 'PUT').every((request) => {
                try { return Array.isArray(JSON.parse(request.body).tasks); } catch { return false; }
            })).toBe(true);
            expect(fixture.kv.get(SYNC_ENCRYPTION_STATE_KEY)).toBe(state);
            expect([...fixture.secrets]).toEqual(secretsBefore);
            await core.flushPendingSave();
            const contract = core.createNativeHostContract({ syncSettings: fixture.sync.settingsHost });
            expect(await contract.activate({ writeSafetyReady: true })).toEqual({ ok: true, value: null });
            const model = await contract.openSyncSettings({});
            expect(model.ok).toBe(true);
            if (!model.ok) throw new Error('Expected shared self-hosted model');
            expect(model.value.panel?.kind).toBe('selfhosted');
            expect(model.value.encryption).toBeNull();
        },
    );
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

    it('runs iCloud startup and resume through the shared automatic controller like RN', async () => {
        resetForTests();
        let now = 100_000;
        spyOn(Date, 'now').mockImplementation(() => now);
        iosFiles();
        const calls: string[] = [];
        let account: 'available' | 'noAccount' = 'available';
        const port = {
            isAvailable: () => true,
            getAccountStatus: async () => account,
            ensureReady: async () => { calls.push('ensureReady'); if (account !== 'available') throw new Error('Native CloudKit account is unavailable'); },
            read: async () => { calls.push('read'); return null; },
            write: async () => { calls.push('write'); },
            assets: { saveAttachmentAsset: async () => {}, fetchAttachmentAsset: async () => { throw new Error('no asset'); },
                deleteAttachmentAssets: async () => {}, isAttachmentNotFoundError: () => false },
        };
        const fixture = host({ [SYNC_BACKEND_KEY]: 'cloudkit' }, false, async () => data(), async () => false);
        const sync = createNativeSync({ ...fixture.bindings, cloudKit: port });

        expect(await sync.performStoredAutomaticSync('startup')).toEqual({ success: true, skipped: false });
        expect(calls).toContain('ensureReady');
        expect(calls).toContain('read');
        expect(sync.state().cycles).toBe(1);
        now += 1_000;
        expect(await sync.performStoredAutomaticSync('resume')).toEqual({ success: true, skipped: true });
        expect(sync.state().cycles).toBe(1);
        now += 60_000;
        account = 'noAccount';
        calls.length = 0;
        expect(await sync.performStoredAutomaticSync('resume')).toEqual({ success: false, skipped: false });
        expect(calls).toEqual(['ensureReady']);
        expect(fixture.kv.get(SYNC_BACKEND_KEY)).toBe('cloudkit');
        expect(fixture.schedules).toEqual([]);
    });

    it('reports an unsynced local edit and syncs it when the app leaves like RN', async () => {
        resetForTests(); serve();
        let now = 100_000;
        spyOn(Date, 'now').mockImplementation(() => now);
        const edit = () => core.useTaskStore.setState((state) => ({
            _allTasks: [...state._allTasks, { id: `local-${now}`, title: 'Synthetic', status: 'inbox', tags: [], contexts: [],
                createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString() }],
            lastDataChangeAt: core.getNextDataChangeAt(state.lastDataChangeAt, now) }) as never);
        const fixture = configured();
        expect(await fixture.sync.performStoredAutomaticSync('startup')).toEqual({ success: true, skipped: false });
        expect(fixture.sync.syncChangeObservation()).toEqual({ pending: false });
        now += 1_000;
        edit();
        expect(fixture.sync.syncChangeObservation()).toEqual({ pending: true });
        expect(await fixture.sync.performStoredAutomaticSync('leave')).toEqual({ success: true, skipped: false });
        expect(fixture.sync.state().cycles).toBe(2);
        expect(fixture.sync.syncChangeObservation()).toEqual({ pending: false });
        expect(fixture.schedules).toEqual([]);
    });

    it('runs an explicit stored pull despite automatic resume pacing and preserves configuration', async () => {
        resetForTests(); serve();
        spyOn(Date, 'now').mockReturnValue(100_000);
        const fixture = configured();
        await fixture.sync.performStoredAutomaticSync('startup');
        const before = [fixture.kv.get(SYNC_BACKEND_KEY), fixture.kv.get(WEBDAV_URL_KEY)];
        expect(await fixture.sync.performStoredAutomaticSync('resume')).toEqual({ success: true, skipped: true });
        expect(await fixture.sync.performStoredManualSync()).toMatchObject({ success: true });
        expect(fixture.sync.state().cycles).toBe(2);
        expect([fixture.kv.get(SYNC_BACKEND_KEY), fixture.kv.get(WEBDAV_URL_KEY)]).toEqual(before);
        expect(fixture.schedules).toEqual([]);
    });

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


describe('pull down to sync', () => {
    it('asks for setup while sync is off, runs no cycle, and logs the outcome', async () => {
        const fixture = host();
        expect(await fixture.sync.pullSync()).toEqual({ indicator: 'error', toast: {
            title: 'Notice', message: 'Please set up sync first', tone: 'warning', durationMs: 3600,
        } });
        expect(fixture.sync.state().cycles).toBe(0);
        expect(fixture.entries.filter((entry) => entry.context?.releaseCheck === 'v1.3.8/native-pull-sync').map((entry) => entry.context))
            .toEqual([{ releaseCheck: 'v1.3.8/native-pull-sync', outcome: 'error', toast: 'yes' }]);
    });

    it('runs one manual cycle on a configured backend, and a failed one ends on the error flash', async () => {
        globalThis.fetch = (async () => new Response('', { status: 404 })) as typeof fetch;
        const fixture = host({ [SYNC_BACKEND_KEY]: 'webdav', [WEBDAV_URL_KEY]: 'https://dav.example.com' }, false, async () => {
            throw new Error('ordinary local read failure');
        });
        expect(await fixture.sync.pullSync()).toMatchObject({ indicator: 'error', toast: { title: 'Sync failed', tone: 'error' } });
        expect(fixture.sync.state().cycles).toBe(1);
    });
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

it.each(['android', 'ios'] as const)('binds a complete CloudKit port only to an explicit iOS invocation on %s', async (platform) => {
    if (platform === 'ios') iosFiles();
    globals.__mindwtrHostPlatform = platform;
    const fixture = host({}, false, undefined, async () => false);
    const port = {
        isAvailable: () => true,
        getAccountStatus: async () => 'available' as const,
        ensureReady: async () => {}, read: async () => null, write: async () => {},
        assets: { saveAttachmentAsset: async () => {}, fetchAttachmentAsset: async () => { throw new Error('no asset'); },
            deleteAttachmentAssets: async () => {}, isAttachmentNotFoundError: () => false },
    };
    const create = core.createMobileSyncService;
    let serviceHost: Parameters<typeof core.createMobileSyncService>[0] | undefined;
    spyOn(core, 'createMobileSyncService').mockImplementation((options) => {
        serviceHost = options; return create(options);
    });
    const sync = createNativeSync({ ...fixture.bindings, cloudKit: port });
    if (platform === 'ios') {
        expect(serviceHost!.cloudKit?.read).toBe(port.read);
        expect(typeof serviceHost!.cloudKit?.syncAttachments).toBe('function');
    } else expect(serviceHost!.cloudKit).toBeUndefined();
    expect(sync.settingsHost.platform.cloudKitAvailable).toBe(platform === 'ios');
    expect(await sync.settingsHost.cloudKit?.getAccountStatus()).toBe(platform === 'ios' ? 'available' : undefined);
    expect(fixture.sync.settingsHost.platform.cloudKitAvailable).toBe(false);
});

it.each(['android', 'ios'] as const)('binds sliceYield on %s only when the host is Android, with the token ports', async (platform) => {
    if (platform === 'ios') iosFiles();
    globals.__mindwtrHostPlatform = platform;
    const create = core.createMobileSyncService;
    let serviceHost: Parameters<typeof core.createMobileSyncService>[0] | undefined;
    spyOn(core, 'createMobileSyncService').mockImplementation((options) => {
        serviceHost = options;
        return create(options);
    });
    host({}, false, undefined, async () => false);
    expect(serviceHost).toBeDefined();
    expect(typeof serviceHost!.sliceYield).toBe(platform === 'android' ? 'function' : 'undefined');
    expect(typeof serviceHost!.localData.readTokenOf).toBe('function');
    expect(typeof serviceHost!.localData.prepareSave).toBe('function');
    if (platform === 'android') {

        let resumed = false;
        const slice = serviceHost!.sliceYield!().then(() => { resumed = true; });
        await Promise.resolve();
        expect(resumed).toBe(false);
        await slice;
        expect(resumed).toBe(true);
    }
});


describe('leaving the app during a sync', () => {
    const waitFor = async (what: string, holds: () => boolean, ms = 20_000) => {
        for (const deadline = Date.now() + ms; !holds(); await new Promise((done) => setTimeout(done, 50))) {
            if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        }
    };

    it('aborts a write in flight, then publishes the library and leaves no fence', async () => {
        resetForTests();

        setLogger(() => undefined);
        globals.__mindwtrHostPlatform = 'android';
        globalThis.fetch = realFetch;
        const dav = await serveWebdav({ port: 18_796, username: 'alice', password: 'secret' });
        const folder = `/dav/leave-${Date.now()}`;
        const url = `http://127.0.0.1:18796${folder}/data.json`;
        const task = { id: 't-leave', title: 'Kept through a leave', status: 'inbox', createdAt: '2026-10-25T00:00:00.000Z',
            updatedAt: '2026-10-25T00:00:00.000Z' };
        let data: AppData = { tasks: [task as AppData['tasks'][number]], projects: [], sections: [], areas: [], settings: {} };
        core.setStorageAdapter({ getData: async () => structuredClone(data), saveData: async (next) => { data = structuredClone(next); } });
        const fixture = host({ [SYNC_BACKEND_KEY]: 'webdav', [WEBDAV_URL_KEY]: url, '@mindwtr_webdav_username': 'alice' }, false,
            async () => structuredClone(data));
        fixture.bindings.secrets.getSecret = async (key) => (key.includes('webdav_password') ? 'secret' : null);

        fixture.bindings.localData = () => ({
            getData: async () => structuredClone(data),
            saveData: async (next: AppData) => { data = structuredClone(next); },
            readTokenOf: () => ({ epoch: 0, generation: 0 }),
            prepareSaveRows: function* () {                          },
        }) as unknown as ReturnType<typeof fixture.bindings.localData>;
        let release!: () => void;
        dav.state.holdWrites = new Promise<void>((done) => { release = done; });
        const fences = () => [...dav.state.files.keys()].filter((path) => path.startsWith(`${folder}/`) && path.includes('fence'));
        try {
            await core.useTaskStore.getState().fetchData();
            fixture.sync.start('active');
            await waitFor('the cycle\'s write of the sync document', () => dav.state.heldAt.length > 0);

            fixture.sync.appState('background');
            release();
            dav.state.holdWrites = null;
            await waitFor('the library in the folder', () => webdavDocument(dav, folder)?.tasks?.some((row: { id: string }) => row.id === 't-leave') === true, 60_000);
            await waitFor('the fence released', () => fences().length === 0, 20_000);

            const document = webdavDocument(dav, folder);

            expect(document.tasks.map((row: { id: string }) => row.id)).toContain('t-leave');
            expect(data.tasks.map((row) => row.id)).toContain('t-leave');
            fixture.sync.appState('active');
        } finally {
            release?.();
            dav.state.holdWrites = null;
            await dav.close();
            resetForTests();
        }
    }, 90_000);
});


describe('a keystore error, then a restart', () => {
    it('fails the sync without deleting anything, and the restarted app syncs with the same secret', async () => {
        resetForTests();
        setLogger(() => undefined);
        globals.__mindwtrHostPlatform = 'android';
        globalThis.fetch = realFetch;
        const dav = await serveWebdav({ port: 18_797, username: 'alice', password: 'secret' });
        const folder = `/dav/keystore-${Date.now()}`;
        const stored = { [SYNC_BACKEND_KEY]: 'webdav', [WEBDAV_URL_KEY]: `http://127.0.0.1:18797${folder}/data.json`, '@mindwtr_webdav_username': 'alice' };
        const task = { id: 't-keystore', title: 'Kept through a keystore error', status: 'inbox', createdAt: '2026-10-25T00:00:00.000Z',
            updatedAt: '2026-10-25T00:00:00.000Z' };
        let data: AppData = { tasks: [task as AppData['tasks'][number]], projects: [], sections: [], areas: [], settings: {} };
        core.setStorageAdapter({ getData: async () => structuredClone(data), saveData: async (next) => { data = structuredClone(next); } });
        const secrets = new Map([['mindwtr_webdav_password', 'secret']]);
        const deleted: string[] = [];
        const boot = (keystoreFails: boolean) => {
            const fixture = host(stored, false, async () => structuredClone(data));
            fixture.bindings.localData = () => ({
                getData: async () => structuredClone(data),
                saveData: async (next: AppData) => { data = structuredClone(next); },
                readTokenOf: () => ({ epoch: 0, generation: 0 }),
                prepareSaveRows: function* () {                          },
            }) as unknown as ReturnType<typeof fixture.bindings.localData>;
            fixture.bindings.secrets = {
                getSecret: async (key) => {
                    if (keystoreFails) throw new Error('android.security.KeyStoreException: Keystore operation failed');
                    return [...secrets].find(([name]) => key.includes(name) || name.includes(key))?.[1] ?? null;
                },
                setSecret: async (key, value) => { secrets.set(key, value); },
                deleteSecret: async (key) => { deleted.push(key); secrets.delete(key); },
            };
            return fixture;
        };
        try {
            await core.useTaskStore.getState().fetchData();
            const failing = boot(true);
            const failed = await failing.sync.settingsHost.performSync(undefined, { manual: true }).catch((error: unknown) => ({ success: false, error }));
            expect(failed).toMatchObject({ success: false });
            expect(deleted).toEqual([]);
            expect(secrets.get('mindwtr_webdav_password')).toBe('secret');
            expect(Object.fromEntries([...failing.kv].filter(([key]) => key in stored))).toEqual(stored);
            expect(webdavDocument(dav, folder)).toBeNull();


            const restarted = boot(false);
            for (const [key, value] of failing.kv) restarted.kv.set(key, value);
            expect(await restarted.sync.settingsHost.performSync(undefined, { manual: true })).toMatchObject({ success: true });

            expect(webdavDocument(dav, folder)).not.toBeNull();
            expect(deleted).toEqual([]);
        } finally {
            await dav.close();
            resetForTests();
        }
    }, 60_000);
});


describe('the store content a finished cycle reports', () => {
    const AT = '2026-01-01T00:00:00.000Z';
    const task = { id: 't1', title: 'Task', status: 'inbox', tags: [], contexts: [], createdAt: AT, updatedAt: AT, rev: 1 };
    const start = () => {
        resetForTests();
        globals.__mindwtrHostPlatform = 'android';
        core.useTaskStore.setState({ _allTasks: [task], _allProjects: [], _allSections: [], _allAreas: [], _allPeople: [], settings: {} } as never);
        return host({ [SYNC_BACKEND_KEY]: 'off' }, false, undefined, async () => false).sync;
    };

    const moved = async (sync: ReturnType<typeof start>, write?: () => void) => {
        const before = sync.state();
        const running = sync.settingsHost.performSync(undefined, { manual: true });
        write?.();
        await running;
        const after = sync.state();
        expect(after.cycles).toBe(before.cycles + 1);
        return after.contentRevision !== before.contentRevision;
    };
    afterEach(() => resetForTests());

    it('keeps it for a cycle that wrote nothing', async () => {
        expect(await moved(start())).toBe(false);
    });
    it('moves it for a merge that brought a task', async () => {
        expect(await moved(start(), () => core.useTaskStore.setState((state) => ({ _allTasks: [...state._allTasks, { ...task, id: 't2' }] }) as never))).toBe(true);
    });
    it('moves it for a settings-only write (a sync status or error)', async () => {
        expect(await moved(start(), () => core.useTaskStore.setState({ settings: { lastSyncStatus: 'error', lastSyncError: 'offline' } } as never))).toBe(true);
    });
    it("moves it for an attachment's local state with no revision change", async () => {
        expect(await moved(start(), () => core.useTaskStore.setState((state) => ({ _allTasks: state._allTasks.map((row) => ({ ...row,
            attachments: [{ id: 'a', kind: 'file', title: 'a.pdf', uri: 'file:///a.pdf', localStatus: 'available', createdAt: AT, updatedAt: AT }] })) }) as never))).toBe(true);
    });
});


it('requires an exact injected File path while default and saved File admission stay closed', async () => {
    resetForTests(); iosFiles();
    const data: AppData = { tasks: [], projects: [], sections: [], areas: [], settings: {} };
    core.setStorageAdapter({ getData: async () => structuredClone(data), saveData: async () => undefined });
    const fixture = host({ [SYNC_BACKEND_KEY]: 'file' }, false, async () => structuredClone(data), async () => false);
    const path = 'file:///app/Sync%20%E8%B3%87%E6%96%99/data.json';
    let admitted = 0;
    const port: core.MobileSyncFileSyncPort<import('./host-file-sync').NativeFileSyncLease> = {
        acquireLease: async () => { admitted += 1; throw new Error('Reached actual service lease seam'); },
        revalidateLease: async () => {}, releaseLease: async () => {},
        readVersioned: async () => { throw new Error('No owner'); }, write: async () => { throw new Error('No owner'); },
        resolveUri: async () => { throw new Error('No owner'); }, isBookmarksAvailable: () => false, resolveBookmark: async () => null,
    };
    await expect(fixture.sync.settingsHost.performSync(undefined, { manual: true })).rejects.toThrow('not available');
    const explicit = createNativeSync({ ...fixture.bindings, fileSync: { canonicalPath: path, port } });
    await expect(explicit.settingsHost.performSync(undefined, { manual: true, configOverride: { backend: 'file', syncPath: path + '.other' } })).rejects.toThrow('not available');
    expect(admitted).toBe(0);
    const result = await explicit.settingsHost.performSync(undefined, { manual: true, configOverride: { backend: 'file', syncPath: path } });
    expect(result.success).toBe(false); expect(admitted).toBe(1);
    expect(fixture.kv.get(SYNC_BACKEND_KEY)).toBe('file'); expect(fixture.kv.has('@mindwtr_sync_path')).toBe(false);
});


it('runs picked activation through two fresh real shared File cycles, then one saved manual cycle', async () => {
    resetForTests(); iosFiles();
    const data: AppData = { tasks: [], projects: [], sections: [], areas: [], settings: {} };
    core.setStorageAdapter({ getData: async () => structuredClone(data), saveData: async () => undefined });
    const fixture = host({ [SYNC_BACKEND_KEY]: 'off' }, false, async () => structuredClone(data), async () => false);
    const root = 'file:///app/selected/', path = root + 'data.json', bookmark = 'b3JpZ2luYWw=';
    core.useTaskStore.setState({ _allTasks: [], _allProjects: [], _allSections: [], _allAreas: [], _allPeople: [], settings: {}, error: null, persistenceFailure: null, isLoading: false, editLockCount: 0, lastDataChangeAt: 0 } as never);
    await core.useTaskStore.getState().fetchData({ throwOnError: true });
    await core.flushPendingSave();
    const files = new Map<string, Uint8Array>(), phases: string[] = [], requests: string[] = [];
    let turn = 0, active: string | null = null, opens = 0;
    const control = (text: string) => {
        const request = JSON.parse(text);
        if (request.phase === 'begin') {
            expect(active).toBeNull(); active = 'directory-' + (++turn);
            phases.push('begin:' + turn + ':' + fixture.kv.get(SYNC_BACKEND_KEY));
            return JSON.stringify({ turn: active, bookmark, expectedPath: request.picked ? null : fixture.kv.get('@mindwtr_sync_path') });
        }
        expect(request.turn).toBe(active);
        phases.push('finish:' + turn + ':' + fixture.kv.get(SYNC_BACKEND_KEY) + ':' + request.admit);
        active = null;
        return JSON.stringify({ closed: true });
    };
    const call: import('./host-file-sync').NativeFileSyncCall = async (request) => {
        expect(request.turn).toBe(active); requests.push(String(request.op));
        const uri = String(request.uri), bytes = files.get(uri);
        const reply = (value: unknown) => ({ id: 'reply', value });
        switch (request.op) {
        case 'prepare': return reply({ rootURI: root, canonicalPath: path });
        case 'open': opens += 1; return reply(null);
        case 'revalidate': case 'close': return reply(null);
        case 'list': return reply([...files.keys()].map((name) => name.slice(root.length)));
        case 'info': return reply(uri === root ? { exists: true, size: 0 } : bytes ? { exists: true, size: bytes.length } : { exists: false });
        case 'read': return bytes ? { id: 'reply', value: 'bytes', body: true, base64: core.bytesToBase64(bytes) } : reply('absent');
        case 'create': if (files.has(uri)) return reply('exists'); files.set(uri, new Uint8Array()); return reply('created');
        case 'writeCreated': files.set(uri, core.base64ToBytes(String(request.base64))); return reply(null);
        case 'renameObserved': {
            expect(bytes).toEqual(core.base64ToBytes(String(request.base64)));
            const target = root + encodeURIComponent(String(request.name)); expect(files.has(target)).toBe(false);
            files.set(target, bytes!); files.delete(uri); return reply(target);
        }
        case 'deleteOwned': expect(bytes).toEqual(core.base64ToBytes(String(request.base64))); files.delete(uri); return reply(null);
        default: throw new Error('Unexpected native operation');
        }
    };
    const directory = createIosDirectoryFileSync(fixture.bindings, call, control);
    const sync = createNativeSync({ ...fixture.bindings, ...directory });
    const contract = core.createNativeHostContract({ syncSettings: sync.settingsHost });
    const activation = await contract.activate({ writeSafetyReady: true });
    expect(activation).toEqual({ ok: true, value: null });
    expect((await contract.openSyncSettings({})).ok).toBe(true);
    expect((await contract.selectSyncBackend({ requestId: crypto.randomUUID(), option: 'file' })).ok).toBe(true);
    expect(turn).toBe(0); expect(fixture.kv.get(SYNC_BACKEND_KEY)).toBe('off');
    const read = contract.getSyncSettings(); if (!read.ok) throw new Error('No Settings view');
    const picked = await contract.pickSyncFolder({ requestId: crypto.randomUUID(), revision: read.value.configRevision });
    expect(picked).toMatchObject({ ok: true, value: { toasts: expect.not.arrayContaining([expect.objectContaining({ tone: 'error' })]) } });
    expect(phases).toEqual(['begin:1:off', 'finish:1:off:true', 'begin:2:file', 'finish:2:file:true']);
    expect(turn).toBe(2); expect(opens).toBe(2);
    expect(fixture.kv.get('@mindwtr_sync_path')).toBe(path);
    expect(fixture.kv.get('@mindwtr_sync_path_bookmark')).toBe(bookmark);
    const first = core.bytesToBase64(files.get(path)!);
    const fresh = contract.getSyncSettings(); if (!fresh.ok) throw new Error('No Settings view');
    expect((await contract.syncNow({ requestId: crypto.randomUUID(), revision: fresh.value.configRevision })).ok).toBe(true);
    expect(turn).toBe(3); expect(opens).toBe(3); expect(core.bytesToBase64(files.get(path)!)).toBe(first);
    expect(requests.filter((op) => op === 'prepare')).toHaveLength(3);
    await contract.closeSyncSettings({});
    expect(await sync.performStoredManualSync()).toEqual({ success: true, skipped: false });
    expect(turn).toBe(4); expect(opens).toBe(4); expect(active).toBeNull();
    expect(core.bytesToBase64(files.get(path)!)).toBe(first);
    expect(fixture.kv.get('@mindwtr_sync_path_bookmark')).toBe(bookmark);
    await contract.openSyncSettings({});
    expect((await contract.selectSyncBackend({ requestId: crypto.randomUUID(), option: 'off' })).ok).toBe(true);
    expect(turn).toBe(4); expect(fixture.kv.get(SYNC_BACKEND_KEY)).toBe('off');
    directory.close(); resetForTests();
});

const missingFilesFolder = async (stored: Record<string, string>) => {
    resetForTests(); iosFiles();
    const at = '2026-11-01T00:00:00.000Z';
    const task = { id: 't-old-file', title: 'Tax return', status: 'inbox', tags: [], contexts: [], createdAt: at, updatedAt: at,
        attachments: [{ id: 'att-1', kind: 'file', title: 'scan.pdf', uri: '', cloudKey: 'attachments/att-1.pdf', localStatus: 'missing', createdAt: at, updatedAt: at }] };
    const data = { tasks: [task], projects: [], sections: [], areas: [], settings: {} } as unknown as AppData;
    core.setStorageAdapter({ getData: async () => structuredClone(data), saveData: async () => undefined });
    const fixture = host(stored, false, async () => structuredClone(data), async () => false);
    const root = 'file:///app/selected/', path = root + 'data.json', bookmark = 'b3JpZ2luYWw=';
    core.useTaskStore.setState({ _allTasks: [], _allProjects: [], _allSections: [], _allAreas: [], _allPeople: [], settings: {}, error: null, persistenceFailure: null, isLoading: false, editLockCount: 0, lastDataChangeAt: 0 } as never);
    await core.useTaskStore.getState().fetchData({ throwOnError: true });
    await core.flushPendingSave();
    const files = new Map<string, Uint8Array>(), phases: string[] = [];
    let turn = 0;
    const state = { active: null as string | null };
    const control = (text: string) => {
        const request = JSON.parse(text);
        if (request.phase === 'begin') {
            state.active = 'directory-' + (++turn);
            phases.push('begin:' + turn + ':' + request.picked);
            return JSON.stringify({ turn: state.active, bookmark, expectedPath: request.picked ? null : fixture.kv.get('@mindwtr_sync_path') });
        }
        phases.push('finish:' + turn + ':' + request.admit);
        state.active = null;
        return JSON.stringify({ closed: true });
    };
    const call: import('./host-file-sync').NativeFileSyncCall = async (request) => {
        const uri = String(request.uri), bytes = files.get(uri);
        const reply = (value: unknown) => ({ id: 'reply', value });
        switch (request.op) {
        case 'prepare': return reply({ rootURI: root, canonicalPath: path });
        case 'open': case 'revalidate': case 'close': return reply(null);
        case 'list': return reply([...files.keys()].map((name) => name.slice(root.length)));
        case 'info': return reply(uri === root ? { exists: true, size: 0 } : bytes ? { exists: true, size: bytes.length } : { exists: false });
        case 'read': return bytes ? { id: 'reply', value: 'bytes', body: true, base64: core.bytesToBase64(bytes) } : reply('absent');
        case 'create': if (files.has(uri)) return reply('exists'); files.set(uri, new Uint8Array()); return reply('created');
        case 'writeCreated': files.set(uri, core.base64ToBytes(String(request.base64))); return reply(null);
        case 'renameObserved': {
            const target = root + encodeURIComponent(String(request.name));
            files.set(target, bytes!); files.delete(uri); return reply(target);
        }
        case 'deleteOwned': files.delete(uri); return reply(null);
        case 'attachmentDirectory': return reply(null);
        case 'attachmentInfo': return reply(uri.endsWith('/attachments/') ? { exists: true, isDirectory: true, size: 0, modificationTime: 1 } : { exists: false });
        case 'attachmentList': return reply([]);
        case 'attachmentRead': return reply('absent');
        default: throw new Error('Unexpected native operation');
        }
    };
    const directory = createIosDirectoryFileSync(fixture.bindings, call, control);
    const sync = createNativeSync({ ...fixture.bindings, ...directory });
    const contract = core.createNativeHostContract({ syncSettings: sync.settingsHost });
    expect(await contract.activate({ writeSafetyReady: true })).toEqual({ ok: true, value: null });
    expect((await contract.openSyncSettings({})).ok).toBe(true);
    const ask = async () => {
        const read = contract.getSyncSettings(); if (!read.ok) throw new Error('No Settings view');
        expect(await contract.pickSyncFolder({ requestId: crypto.randomUUID(), revision: read.value.configRevision })).toEqual({ ok: true, value: { toasts: [] } });
        const asked = contract.getSyncSettings(); if (!asked.ok) throw new Error('No Settings view');
        expect(asked.value.missingFiles?.message).toContain('• scan.pdf (Tax return)');
        return asked.value.missingFiles!.questionId;
    };
    return { fixture, sync, directory, contract, phases, state, path, ask };
};

it('returns a picked folder\'s missing attachment files to core, then activates it on Continue with the same pick', async () => {
    const { fixture, sync, directory, contract, phases, state, path, ask } = await missingFilesFolder({ [SYNC_BACKEND_KEY]: 'off' });
    expect(sync.settingsHost.defersMissingFilesQuestion).toBe(true);
    expect(sync.settingsHost.answersMissingFilesQuestion).toBe(false);
    expect((await contract.selectSyncBackend({ requestId: crypto.randomUUID(), option: 'file' })).ok).toBe(true);
    const questionId = await ask();
    expect(phases).toEqual(['begin:1:true', 'finish:1:false']);
    expect(fixture.kv.get(SYNC_BACKEND_KEY)).toBe('off'); expect(state.active).toBeNull();
    const storedBefore = new Map(fixture.kv);
    await directory.pickSyncFolder();
    const continued = await contract.continueSyncWithoutFiles({ requestId: crypto.randomUUID(), questionId });
    expect(continued).toMatchObject({ ok: true, value: { toasts: expect.not.arrayContaining([expect.objectContaining({ tone: 'error' })]) } });
    expect(phases).toEqual(['begin:1:true', 'finish:1:false', 'begin:2:true', 'finish:2:true', 'begin:3:false', 'finish:3:true']);
    expect(fixture.kv.get(SYNC_BACKEND_KEY)).toBe('file');
    expect(fixture.kv.get('@mindwtr_sync_path')).toBe(path);
    expect(fixture.kv.get('mindwtr-unreachable-attachments')).toContain('att-1');
    const swiftKV = readFileSync(join(import.meta.dir, '../../ios-native/Sources/MindwtrNativeCore/NativeDeviceKV.swift'), 'utf8');
    const writableList = /static let writable: Set<Data> = Set\(\[([\s\S]*?)\]\.map/.exec(swiftKV)![1];
    const writable = new Set([...writableList.matchAll(/"([^"]+)"/g)].map((match) => match[1]));
    const written = [...fixture.kv].filter(([name, value]) => storedBefore.get(name) !== value).map(([name]) => name);
    expect(written.filter((name) => !writable.has(name))).toEqual([]);
    const settled = contract.getSyncSettings(); if (!settled.ok) throw new Error('No Settings view');
    expect(settled.value.missingFiles).toBeNull();
    directory.close(); resetForTests();
});

it('cancels a new folder\'s missing-files question through the foreground entry while a stored folder stays as it was', async () => {
    const stored = { [SYNC_BACKEND_KEY]: 'file', '@mindwtr_sync_path': 'file:///app/old/data.json', '@mindwtr_sync_path_bookmark': 'b2xkLWZvbGRlcg==' };
    const { fixture, directory, contract, phases, ask } = await missingFilesFolder(stored);
    const manifest = () => JSON.stringify([...fixture.kv.entries()].filter(([name]) => name.startsWith('@mindwtr_sync') || name === 'mindwtr-unreachable-attachments').sort());
    const before = manifest();
    const questionId = await ask();
    directory.close();
    expect(phases).toEqual(['begin:1:true', 'finish:1:false']);

    const source = readFileSync(join(import.meta.dir, 'host-entry.ts'), 'utf8');
    const capabilityStart = source.indexOf('let iosDropboxControl:');
    const capabilityEnd = source.indexOf('const ensureIosManualSync', capabilityStart);
    const methodStart = source.indexOf('    iosForegroundSync(name:');
    const methodEnd = source.indexOf('    gettingStartedOutcome(json: string): string {', methodStart);
    expect([capabilityStart, capabilityEnd, methodStart, methodEnd].every((value) => value >= 0)).toBe(true);
    const sandbox = createContext({ TextEncoder, AbortController, JSON, Error, Object, Array,
        readNativeIosDropboxConfiguration: () => null, __mindwtrHostPlatform: 'ios', __mindwtrSyncSecrets: {},
        submit: (work: (signal: AbortSignal) => Promise<unknown>) => work(new AbortController().signal),
        localAttachments: {}, nativeSync: null, bootAdapter: {}, iosForegroundFailure: null,
        iosCleanupCallback: null, iosTaskAttachmentPreparation: false, iosProjectFilePreparation: false,
        isSandboxMode: () => false, isWorkspaceTransitionActive: () => false, native: () => ({ kvMultiGet: () => '' }),
        iosCloudKitAvailable: () => false, requireSaved: () => undefined, getPersistenceStatus: () => ({}),
        keyValue: { get: async (name: string) => fixture.kv.get(name) ?? null }, SYNC_BACKEND_KEY, CLOUD_PROVIDER_KEY,
        isNativeIosSelfHostedProvider: () => false, contract,
        iosManualSync: { settingsHost: { encryption: { mode: 'saved-webdav-or-local' } } },
        ensureIosManualSync: () => undefined, diagnosticsLog: { append: async () => undefined },
        NativeAttachmentCleanupUnconfirmedError, MENU_COMMANDS: {
            answerSyncMissingFiles: (input: { questionId: string; continue: boolean }) => contract.answerSyncMissingFiles(input),
            saveSyncBackend: () => { throw new Error('A stored folder refuses other foreground commands'); },
        },
    });
    const program = source.slice(capabilityStart, capabilityEnd) + '\n' + 'globalThis.entry = {' + source.slice(methodStart, methodEnd) + '};';
    runInContext((await transform(program, { loader: 'ts', target: 'es2022' })).code, sandbox);

    const cancelled = await sandbox.entry.iosForegroundSync('answerSyncMissingFiles', JSON.stringify({ questionId, continue: false }), () => '{}');
    const refused = await sandbox.entry.iosForegroundSync('saveSyncBackend', JSON.stringify({ requestId: crypto.randomUUID(), revision: 'r',
        webdav: { url: 'https://dav.example.com', username: 'u', password: null, allowInsecureHttp: false } }), () => '{}');

    expect(cancelled).toEqual({ ok: true, value: null });
    expect(refused).toMatchObject({ ok: false, error: { code: 'ACTION_FAILED' } });
    const after = contract.getSyncSettings(); if (!after.ok) throw new Error('No Settings view');
    expect(after.value.missingFiles).toBeNull();
    expect(manifest()).toBe(before);
    expect(fixture.kv.get(SYNC_BACKEND_KEY)).toBe('file');
    resetForTests();
});

it('native directory projection failure closes before core can activate a picked target', async () => {
    resetForTests(); iosFiles();
    const fixture = host({ [SYNC_BACKEND_KEY]: 'off' }, false, undefined, async () => false);
    const phases: string[] = [];
    const directory = createIosDirectoryFileSync(fixture.bindings,
        async () => ({ id: 'reply', value: { rootURI: 'file:///app/folder/', canonicalPath: 'file:///app/other/data.json' } }),
        (text) => {
            const request = JSON.parse(text); phases.push(request.phase);
            return JSON.stringify(request.phase === 'begin' ? { turn: 'one', bookmark: 'b3JpZ2luYWw=', expectedPath: null } : { closed: true });
        });
    await expect(directory.pickSyncFolder()).rejects.toThrow();
    expect(phases).toEqual(['begin', 'finish']);
    expect(fixture.kv.get(SYNC_BACKEND_KEY)).toBe('off');
    directory.close(); resetForTests();
});
