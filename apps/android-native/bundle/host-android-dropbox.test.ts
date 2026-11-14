import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as core from '@mindwtr/core';
import {
    CLOUD_PROVIDER_KEY,
    DROPBOX_ASYNC_TOKENS_KEY,
    DROPBOX_LAST_REV_KEY,
    DROPBOX_SECURESTORE_TOKENS_KEY,
    SYNC_BACKEND_KEY,
    resetForTests,
    type AppData,
} from '@mindwtr/core';
import { createNativeSync } from './host-sync';
import { readNativeAndroidDropboxConfiguration, readNativeIosDropboxConfiguration, type NativeIosDropboxCapability } from './host-ios-dropbox';
import { createDropboxFake } from '../scripts/dropbox-harness.mjs';
import { createHash } from 'node:crypto';
import { createMemoryFileSystem, CACHE, DOCUMENTS, MANAGED } from '../../../packages/core/src/__fixtures__/mobile-attachment-fakes';

const globals = globalThis as unknown as Record<string, unknown>;
const realFetch = globalThis.fetch;
const CLIENT = 'fakeAppKey1';
const REDIRECT = 'mindwtr://redirect';
const date = '2026-11-14T00:00:00.000Z';
const local = (title: string): AppData => ({ tasks: [{ id: `t-${title}`, title, status: 'inbox', contexts: [], tags: [], createdAt: date, updatedAt: date }],
    projects: [], sections: [], areas: [], settings: {} });

const fixture = (options: { kv?: Record<string, string>; secrets?: Record<string, string>; foss?: boolean; data?: AppData } = {}) => {
    const fake = createDropboxFake({ clientId: CLIENT });
    const kv = new Map(Object.entries(options.kv ?? {}));
    const secrets = new Map(Object.entries(options.secrets ?? {}));
    const entries: core.DiagnosticsLogEntry[] = [];
    let stored = options.data ?? local('Native Dropbox task');
    const authorizations: unknown[] = [];
    let answer: 'redirect' | 'dismiss' = 'redirect';
    const verifier = 'n'.repeat(43);
    const capability: NativeIosDropboxCapability = {
        configuration: () => ({ version: 1, clientId: CLIENT, redirectUri: REDIRECT }),
        assertCurrent: () => {},
        authorizationRequestId: core.generateUUID,
        authorize: async (request) => {
            authorizations.push(request);
            if (answer === 'dismiss') throw new Error('Dropbox authorization failed');
            const query = new URLSearchParams({ response_type: 'code', client_id: CLIENT, redirect_uri: REDIRECT, code_challenge_method: 'S256',
                code_challenge: fake.challengeOf(verifier), state: `s${authorizations.length}`, token_access_type: 'offline',
                scope: 'files.content.read files.content.write files.metadata.read' });
            await fake.fetch(`https://www.dropbox.com/oauth2/authorize?${query}`);
            const code = new URL(fake.redirectFor(fake.state.authorizes.at(-1))).searchParams.get('code');
            return { version: 1, ...request, clientId: CLIENT, redirectUri: REDIRECT, code, codeVerifier: verifier };
        },
    };
    globalThis.fetch = fake.fetch as typeof fetch;
    core.setStorageAdapter({ getData: async () => structuredClone(stored), saveData: async (data) => { stored = structuredClone(data); } });
    const sync = createNativeSync({
        dropbox: capability,
        keyValue: {
            get: async (key) => kv.get(key) ?? null,
            set: async (key, value) => { kv.set(key, value); },
            remove: async (key) => { kv.delete(key); },
            multiGet: async (keys) => keys.map((key) => [key, kv.get(key) ?? null] as [string, string | null]),
            multiSet: async (pairs) => { for (const [key, value] of pairs) kv.set(key, value); },
        },
        secrets: {
            getSecret: async (key) => secrets.get(key) ?? null,
            setSecret: async (key, value) => { secrets.set(key, value); },
            deleteSecret: async (key) => { secrets.delete(key); },
        },
        localData: () => ({
            getData: async () => structuredClone(stored),
            saveData: async (data) => { stored = structuredClone(data); },
            readTokenOf: () => ({ epoch: 0, generation: 0 }),
            prepareSaveRows: function* () {},
        }) as unknown as ReturnType<Parameters<typeof createNativeSync>[0]['localData']>,
        networkState: () => ({ isConnected: true, isInternetReachable: true }),
        appendLog: async (entry) => { entries.push(entry); return null; },
        translate: (key) => key,
        emit: () => {},
        trace: () => {},
        scheduleBackgroundSync: () => {},
        isFossBuild: options.foss === true,
    });
    const contract = core.createNativeHostContract({ syncSettings: sync.settingsHost });
    const outcomes = () => entries.filter((entry) => entry.context?.releaseCheck === 'v1.3.9/native-dropbox').map((entry) => entry.context?.outcome);
    const tokens = () => JSON.parse(secrets.get(DROPBOX_SECURESTORE_TOKENS_KEY) ?? 'null') as core.DropboxAuthTokens | null;
    const view = async () => {
        const read = await contract.getSyncSettings({});
        if (!read.ok) throw new Error(JSON.stringify(read));
        return read.value as unknown as { panel: { kind: string; connected?: boolean; status?: string; redirect?: string; notConfigured?: string | null } | null };
    };
    return { fake, kv, secrets, entries, sync, contract, outcomes, tokens, view, authorizations, dismiss: () => { answer = 'dismiss'; }, stored: () => stored };
};

const open = async (f: ReturnType<typeof fixture>) => {
    expect(await f.contract.activate({ writeSafetyReady: true })).toMatchObject({ ok: true });
    expect((await f.contract.openSyncSettings({})).ok).toBe(true);
};
const remoteTitles = (f: ReturnType<typeof fixture>) => {
    const file = f.fake.state.files.get('/data.json');
    return file ? (JSON.parse(file.body.toString('utf8')) as AppData).tasks.map((task) => task.title) : null;
};
const connect = async (f: ReturnType<typeof fixture>) => {
    expect(await f.contract.selectSyncBackend({ requestId: core.generateUUID(), option: 'dropbox' })).toMatchObject({ ok: true });
    return f.contract.connectDropbox({ requestId: core.generateUUID() });
};
const seedConnected = (f: ReturnType<typeof fixture>, expiresAt = Date.now() + 3_600_000) => {
    const refresh = 'rn-refresh-token-1';
    f.fake.state.refresh.add(refresh);
    const access = 'rn-access-token-1';
    f.fake.state.access.set(access, { refresh, expiresAt });
    return { accessToken: access, refreshToken: refresh, expiresAt };
};
const rnStored = (tokens: core.DropboxAuthTokens) => ({ [DROPBOX_SECURESTORE_TOKENS_KEY]: JSON.stringify(tokens) });
const rnDropboxBackend = { [SYNC_BACKEND_KEY]: 'cloud', [CLOUD_PROVIDER_KEY]: 'dropbox' };

beforeEach(() => {
    resetForTests();
    globals.__mindwtrHostPlatform = 'android';
    core.useTaskStore.setState({ _allTasks: [], _allProjects: [], _allSections: [], _allAreas: [], _allPeople: [], settings: {} } as never);
});
afterEach(async () => {
    await core.flushPendingSave().catch(() => undefined);
    globalThis.fetch = realFetch;
    for (const name of ['__mindwtrHostPlatform', '__mindwtrNative', '__mindwtrFileCall', '__mindwtrInstallerCall']) delete globals[name];
    core.setSha256HexProvider(null);
    resetForTests();
});

describe('native Android Dropbox configuration', () => {
    it('accepts the RN redirect and the native dev and upgrade-test redirects, and nothing else', () => {
        for (const redirectUri of ['mindwtr://redirect', 'mindwtr-native-dev://redirect', 'mindwtr-upgradetest://redirect']) {
            expect(readNativeAndroidDropboxConfiguration({ version: 1, clientId: CLIENT, redirectUri })).not.toBeNull();
        }
        for (const bad of [null, {}, { version: 1, clientId: CLIENT, redirectUri: 'mindwtr-native-bench://redirect' },
            { version: 1, clientId: 'bad key', redirectUri: REDIRECT }, { version: 1, clientId: CLIENT, redirectUri: REDIRECT, extra: 1 }]) {
            expect(readNativeAndroidDropboxConfiguration(bad)).toBeNull();
        }
        expect(readNativeIosDropboxConfiguration({ version: 1, clientId: CLIENT, redirectUri: REDIRECT })).toBeNull();
    });

    it('shows the RN panel with the app key and redirect, and hides Dropbox in the FOSS build as RN does', async () => {
        const f = fixture({ kv: rnDropboxBackend });
        await open(f);
        expect((await f.view()).panel).toMatchObject({ kind: 'dropbox', connected: false, redirect: `Redirect URI: ${REDIRECT}`, notConfigured: null });
        const foss = fixture({ kv: rnDropboxBackend, foss: true });
        await open(foss);
        expect((await foss.view()).panel?.kind).not.toBe('dropbox');
        expect(foss.sync.settingsHost.platform.dropboxAppKey).toBe('');
    });
});

describe('native Android Dropbox sign-in and sync (RN fix history)', () => {
    it('21ba81b8b + #1034: Connect exchanges the PKCE code offline, then activates Dropbox and syncs at once', async () => {
        const f = fixture();
        await open(f);
        const result = await connect(f);
        expect(result).toMatchObject({ ok: true });
        expect(f.fake.state.tokens).toEqual(['authorization_code']);
        expect(f.fake.state.authorizes[0]).toMatchObject({ client_id: CLIENT, redirect_uri: REDIRECT, token_access_type: 'offline', code_challenge_method: 'S256' });
        expect(f.kv.get(SYNC_BACKEND_KEY)).toBe('cloud');
        expect(f.kv.get(CLOUD_PROVIDER_KEY)).toBe('dropbox');
        expect(remoteTitles(f)).toEqual(['Native Dropbox task']);
        expect(f.tokens()?.refreshToken).toStartWith('refresh-');
        expect(f.kv.get(DROPBOX_LAST_REV_KEY)).toBe(f.fake.state.files.get('/data.json')?.rev);
        expect((await f.view()).panel).toMatchObject({ kind: 'dropbox', connected: true, status: 'Status: Connected' });
        expect(f.outcomes()).toEqual(['connected']);
    });

    it('a closed browser stores nothing and keeps the panel disconnected', async () => {
        const f = fixture();
        await open(f);
        f.dismiss();
        await connect(f);
        expect(f.fake.state.tokens).toEqual([]);
        expect(f.secrets.size).toBe(0);
        expect(f.kv.get(SYNC_BACKEND_KEY)).toBeUndefined();
        expect((await f.view()).panel).toMatchObject({ kind: 'dropbox', connected: false });
    });

    it('f87b35211 + staged auth: a failed first Dropbox sync never promotes the staged tokens nor the backend', async () => {
        const f = fixture({ kv: { [SYNC_BACKEND_KEY]: 'off' } });
        await open(f);
        const handle = f.fake.handle;
        f.fake.handle = (request) => request.url.startsWith('/2/files/') ? { status: 500, headers: {}, body: Buffer.from('down') } : handle(request);
        await connect(f);
        expect(f.fake.state.tokens).toEqual(['authorization_code']);
        expect(f.secrets.has(DROPBOX_SECURESTORE_TOKENS_KEY)).toBe(false);
        expect(f.kv.get(SYNC_BACKEND_KEY)).toBe('off');
        expect(f.outcomes()).toEqual(['connected', 'first-sync-failed']);
    });

    it('migrates an RN user: RN SecureStore tokens and cursor sync with no sign-in, and log migrated-from-rn once', async () => {
        const f = fixture({ kv: rnDropboxBackend });
        const seeded = seedConnected(f);
        f.secrets.set(DROPBOX_SECURESTORE_TOKENS_KEY, JSON.stringify(seeded));
        f.fake.state.files.set('/data.json', { body: Buffer.from(JSON.stringify(local('From RN device'))), rev: '0rnrev01' });
        f.kv.set(DROPBOX_LAST_REV_KEY, '0rnold00');
        await open(f);
        expect((await f.view()).panel).toMatchObject({ kind: 'dropbox', connected: true });
        expect(await f.sync.settingsHost.performSync(undefined, { manual: true })).toMatchObject({ success: true });
        expect(f.authorizations).toEqual([]);
        expect(f.fake.state.tokens).toEqual([]);
        expect(remoteTitles(f)?.sort()).toEqual(['From RN device', 'Native Dropbox task']);
        expect(f.kv.get(DROPBOX_LAST_REV_KEY)).toBe(f.fake.state.files.get('/data.json')?.rev);
        expect(f.tokens()).toEqual(seeded);
        expect(f.outcomes().filter((outcome) => outcome === 'migrated-from-rn')).toHaveLength(1);
        expect(JSON.stringify(f.entries)).not.toContain(seeded.accessToken);
        expect(JSON.stringify(f.entries)).not.toContain(seeded.refreshToken);
    });

    it('logs no migrated-from-rn when the once-only flag cannot be written, and still syncs', async () => {
        const f = fixture({ kv: rnDropboxBackend });
        f.secrets.set(DROPBOX_SECURESTORE_TOKENS_KEY, JSON.stringify(seedConnected(f)));
        const set = f.kv.set.bind(f.kv);
        f.kv.set = (key: string, value: string) => { if (key === 'mindwtr-native-dropbox-seen') throw new Error('disk full'); return set(key, value); };
        await open(f);
        expect(await f.sync.settingsHost.performSync(undefined, { manual: true })).toMatchObject({ success: true });
        expect(f.outcomes()).not.toContain('migrated-from-rn');
    });

    it('moves RN legacy AsyncStorage tokens into the secret store and removes the plain copy', async () => {
        const f = fixture({ kv: rnDropboxBackend });
        const seeded = seedConnected(f);
        f.kv.set(DROPBOX_ASYNC_TOKENS_KEY, JSON.stringify(seeded));
        await open(f);
        expect(await f.sync.settingsHost.performSync(undefined, { manual: true })).toMatchObject({ success: true });
        expect(f.tokens()).toEqual(seeded);
        expect(f.kv.has(DROPBOX_ASYNC_TOKENS_KEY)).toBe(false);
        expect(f.authorizations).toEqual([]);
        expect(f.outcomes().filter((outcome) => outcome === 'migrated-from-rn')).toHaveLength(1);
    });

    it('refreshes an expired RN access token with the stored refresh token, keeps it, and logs refreshed', async () => {
        const f = fixture({ kv: rnDropboxBackend });
        const seeded = seedConnected(f, Date.now() - 1_000);
        f.secrets.set(DROPBOX_SECURESTORE_TOKENS_KEY, JSON.stringify(seeded));
        await open(f);
        expect(await f.sync.settingsHost.performSync(undefined, { manual: true })).toMatchObject({ success: true });
        expect(f.fake.state.tokens).toEqual(['refresh_token']);
        expect(f.fake.state.rejected).toBe(0);
        expect(f.tokens()?.refreshToken).toBe(seeded.refreshToken);
        expect(f.tokens()?.accessToken).not.toBe(seeded.accessToken);
        expect(f.outcomes()).toContain('refreshed');
        expect(remoteTitles(f)).toEqual(['Native Dropbox task']);
    });

    it('b550ed89a: a 401 refreshes once and retries; a token that stays refused stops after a bounded number of refreshes', async () => {
        const f = fixture({ kv: rnDropboxBackend });
        f.secrets.set(DROPBOX_SECURESTORE_TOKENS_KEY, JSON.stringify(seedConnected(f)));
        await open(f);
        f.fake.state.failNextAuth = 1;
        expect(await f.sync.settingsHost.performSync(undefined, { manual: true })).toMatchObject({ success: true });
        expect(f.fake.state.tokens).toEqual(['refresh_token']);
        f.fake.state.failNextAuth = 1_000;
        f.fake.state.tokens.length = 0;
        expect(await f.sync.settingsHost.performSync(undefined, { manual: true })).toMatchObject({ success: false });
        expect(f.fake.state.tokens.length).toBeGreaterThan(0);
        expect(f.fake.state.tokens.length).toBeLessThanOrEqual(3);
    });

    it('a refresh token revoked on Dropbox fails sync and logs refresh-failed; Disconnect then Connect recovers, as in RN', async () => {
        const f = fixture({ kv: rnDropboxBackend });
        const seeded = seedConnected(f, Date.now() - 1_000);
        f.secrets.set(DROPBOX_SECURESTORE_TOKENS_KEY, JSON.stringify(seeded));
        f.fake.state.refresh.delete(seeded.refreshToken);
        await open(f);
        expect(await f.sync.settingsHost.performSync(undefined, { manual: true })).toMatchObject({ success: false });
        expect(f.outcomes()).toContain('refresh-failed');
        expect((await f.view()).panel).toMatchObject({ kind: 'dropbox', connected: true });
        expect(await f.contract.disconnectDropbox({ requestId: core.generateUUID() })).toMatchObject({ ok: true });
        expect(f.secrets.has(DROPBOX_SECURESTORE_TOKENS_KEY)).toBe(false);
        expect(await connect(f)).toMatchObject({ ok: true });
        expect(f.tokens()?.refreshToken).not.toBe(seeded.refreshToken);
        expect(await f.sync.settingsHost.performSync(undefined, { manual: true })).toMatchObject({ success: true });
    });

    it('Disconnect revokes the token, clears it, logs revoked; reconnecting signs in fresh', async () => {
        const f = fixture({ kv: rnDropboxBackend });
        const seeded = seedConnected(f);
        f.secrets.set(DROPBOX_SECURESTORE_TOKENS_KEY, JSON.stringify(seeded));
        await open(f);
        expect((await f.contract.disconnectDropbox({ requestId: core.generateUUID() })).ok).toBe(true);
        expect(f.fake.state.revoked).toEqual([seeded.accessToken]);
        expect(f.secrets.has(DROPBOX_SECURESTORE_TOKENS_KEY)).toBe(false);
        expect(f.outcomes()).toContain('revoked');
        expect((await connect(f)).ok).toBe(true);
        expect(f.authorizations).toHaveLength(1);
        expect(f.tokens()?.refreshToken).toStartWith('refresh-');
    });

    it('Disconnect with an expired access token still revokes the grant at Dropbox', async () => {
        const f = fixture({ kv: rnDropboxBackend });
        const seeded = seedConnected(f, Date.now() - 1_000);
        f.secrets.set(DROPBOX_SECURESTORE_TOKENS_KEY, JSON.stringify(seeded));
        await open(f);
        expect((await f.contract.disconnectDropbox({ requestId: core.generateUUID() })).ok).toBe(true);
        expect(f.fake.state.refresh.has(seeded.refreshToken)).toBe(false);
        expect(f.secrets.has(DROPBOX_SECURESTORE_TOKENS_KEY)).toBe(false);
        expect(f.outcomes()).toEqual(['migrated-from-rn', 'refreshed', 'revoked']);
    });

    it('a revoke Dropbox refuses logs revoke-failed, not revoked, and still clears the tokens', async () => {
        const f = fixture({ kv: rnDropboxBackend });
        f.secrets.set(DROPBOX_SECURESTORE_TOKENS_KEY, JSON.stringify(seedConnected(f)));
        await open(f);
        const handle = f.fake.handle;
        f.fake.handle = (request) => request.url === '/2/auth/token/revoke' ? { status: 500, headers: {}, body: Buffer.from('down') } : handle(request);
        expect((await f.contract.disconnectDropbox({ requestId: core.generateUUID() })).ok).toBe(true);
        expect(f.outcomes()).toEqual(['migrated-from-rn', 'revoke-failed']);
        expect(f.secrets.has(DROPBOX_SECURESTORE_TOKENS_KEY)).toBe(false);
    });

    it('95f1e4b77: a transient network failure retries instead of skipping as offline', async () => {
        const f = fixture({ kv: rnDropboxBackend });
        f.secrets.set(DROPBOX_SECURESTORE_TOKENS_KEY, JSON.stringify(seedConnected(f)));
        await open(f);
        const fetcher = f.fake.fetch;
        let failed = 0;
        globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
            if (failed === 0 && String(input).includes('/2/files/')) { failed += 1; throw new TypeError('Network request failed'); }
            return fetcher(input, init);
        }) as typeof fetch;
        const result = await f.sync.settingsHost.performSync(undefined, { manual: true });
        expect(result).toMatchObject({ success: true });
        expect(result.skipped).toBeUndefined();
        expect(failed).toBe(1);
        expect(remoteTitles(f)).toEqual(['Native Dropbox task']);
    });

    it('f4bda00f5: an error that echoes the Dropbox token reaches no log, result or stored status', async () => {
        const f = fixture({ kv: rnDropboxBackend });
        const seeded = seedConnected(f);
        f.secrets.set(DROPBOX_SECURESTORE_TOKENS_KEY, JSON.stringify(seeded));
        await open(f);
        const fetcher = f.fake.fetch;
        globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
            if (String(input).includes('/2/files/')) throw new Error(`Dropbox rejected token ${seeded.accessToken}`);
            return fetcher(input, init);
        }) as typeof fetch;
        const result = await f.sync.settingsHost.performSync(undefined, { manual: true });
        expect(result).toMatchObject({ success: false });
        const text = JSON.stringify({ result, entries: f.entries, kv: [...f.kv], store: core.useTaskStore.getState().settings });
        expect(text).toContain('Dropbox rejected token');
        expect(text).not.toContain(seeded.accessToken);
    });

    it('#1207: a mindwtr://redirect callback routes to Sync settings', () => {
        expect(core.resolveSystemPath('mindwtr://redirect?code=x&state=y', false)).toEqual({ kind: 'dropboxCallback', path: '/settings?settingsScreen=sync' });
    });
});

const androidFiles = () => {
    const memory = createMemoryFileSystem();
    const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
    globals.__mindwtrNative = { fileDirectories: () => JSON.stringify({ document: DOCUMENTS, cache: CACHE }), fileDeleteNow: (uri: string) => { memory.files.delete(uri); } };
    globals.__mindwtrFileCall = async (request: Record<string, unknown>, bytes?: Uint8Array) => {
        const uri = String(request.uri ?? '');
        switch (String(request.op)) {
            case 'barrier': case 'syncParent': return null;
            case 'sha256': return sha(bytes!);
            case 'sha256File': return sha(memory.read(uri)!);
            case 'getInfo': return memory.fs.getInfo(uri);
            case 'makeDirectory': return memory.fs.makeDirectory(uri);
            case 'readDirectory': return memory.fs.readDirectory(uri);
            case 'readBytes': return memory.fs.readBytes(uri);
            case 'readBytesRange': return memory.fs.readBytesRange(uri, Number(request.position), Number(request.length));
            case 'writeBytes': return memory.fs.writeBytes(uri, bytes!);
            case 'copy': return memory.fs.copy(uri, String(request.to));
            case 'move': return memory.fs.move(uri, String(request.to));
            case 'delete': return memory.fs.delete(uri);
            default: throw new Error(`Unexpected fixture file operation ${String(request.op)}`);
        }
    };
    globals.__mindwtrInstallerCall = async (request: Record<string, unknown>) => {
        if (request.op === 'hash') {
            const bytes = memory.read(String(request.path))!;
            return { sha256: sha(bytes), size: bytes.byteLength, modificationTimeMs: 1 };
        }
        if (request.op !== 'install') throw new Error('Unexpected installer operation');
        const staged = memory.read(String(request.staged))!;
        if (sha(staged) !== request.expectedDownloadSha256) throw new Error('Downloaded bytes changed');
        await memory.fs.writeBytes(String(request.target), staged);
        memory.files.delete(String(request.staged));
        return { status: 'installed' };
    };
    return memory;
};

describe('native Android Dropbox attachments through the fake', () => {
    it('uploads a local attachment and downloads a remote one in Dropbox sync', async () => {
        const memory = androidFiles();
        const at = '2026-11-14T00:00:00.000Z';
        const mine = new TextEncoder().encode('native attachment');
        const theirs = new TextEncoder().encode('remote attachment');
        await memory.fs.makeDirectory(MANAGED);
        await memory.fs.writeBytes(`${MANAGED}att-up.txt`, mine);
        const data = local('Has attachments');
        data.tasks[0].attachments = [{ id: 'att-up', kind: 'file', title: 'att-up.txt', uri: `${MANAGED}att-up.txt`, localStatus: 'available', createdAt: at, updatedAt: at }];
        const f = fixture({ kv: rnDropboxBackend, data });
        f.secrets.set(DROPBOX_SECURESTORE_TOKENS_KEY, JSON.stringify(seedConnected(f)));
        const remote = local('Remote with attachment');
        remote.tasks[0].attachments = [{ id: 'att-down', kind: 'file', title: 'att-down.txt', uri: '', cloudKey: 'attachments/att-down.txt',
            fileHash: createHash('sha256').update(theirs).digest('hex'), size: theirs.byteLength, createdAt: at, updatedAt: at }];
        f.fake.state.files.set('/data.json', { body: Buffer.from(JSON.stringify(remote)), rev: '0remote01' });
        f.fake.state.files.set('/attachments/att-down.txt', { body: Buffer.from(theirs), rev: '0remote02' });
        await open(f);
        expect(await f.sync.settingsHost.performSync(undefined, { manual: true })).toMatchObject({ success: true });
        expect(f.fake.state.files.get('/attachments/att-up.txt')?.body.toString('utf8')).toBe('native attachment');
        const uploaded = JSON.parse(f.fake.state.files.get('/data.json')!.body.toString('utf8')) as core.AppData;
        expect(uploaded.tasks.flatMap((task) => task.attachments ?? []).find((row) => row.id === 'att-up')?.cloudKey).toBe('attachments/att-up.txt');
        const downloaded = f.stored().tasks.flatMap((task) => task.attachments ?? []).find((row) => row.id === 'att-down');
        expect(downloaded?.localStatus).toBe('available');
        expect(new TextDecoder().decode(memory.read(downloaded!.uri))).toBe('remote attachment');
        expect(f.sync.settingsHost.platform.dropboxAppKey).toBe(CLIENT);
        const opened = new TextEncoder().encode('opened on demand');
        f.fake.state.files.set('/attachments/att-open.txt', { body: Buffer.from(opened), rev: '0remote03' });
        const onDemand = await f.sync.attachmentsHost!.ensureAttachmentAvailableDetailed({ id: 'att-open', kind: 'file', title: 'att-open.txt', uri: '',
            cloudKey: 'attachments/att-open.txt', localStatus: 'missing', fileHash: createHash('sha256').update(opened).digest('hex'),
            size: opened.byteLength, createdAt: at, updatedAt: at });
        expect(onDemand.status).toBe('available');
        if (onDemand.status !== 'available') throw new Error('not available');
        expect(new TextDecoder().decode(memory.read(onDemand.attachment.uri))).toBe('opened on demand');
    });
});
