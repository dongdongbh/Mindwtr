import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createNativeAIRequestTimeoutMethods, nativeAIRequestTimeoutWitness, type AIRequestTimeoutRequest,
    type AIRequestTimeoutValue } from './native-ai-request-timeout';
import { NativeReceiptSqliteAdapter, loadNativeRequestReceipts, resetNativeRequestReceipts } from './native-request-receipts';
import { flushPendingSave, getPersistenceStatus, resetForTests, setStorageAdapter, useTaskStore } from './store';
import { createNativeHostContract } from './native-host-contract';
import { mergeSettingsForSync } from './sync-merge-settings';
import type { SqliteClient } from './sqlite-adapter';
import type { AppData } from './types';
import type { PreparedAreaAuthority } from './store-types';

const require = createRequire(import.meta.url);
type Database = { exec: (sql: string) => void; prepare: (sql: string) => {
    run: (...params: unknown[]) => unknown; all: (...params: unknown[]) => unknown[]; get: (...params: unknown[]) => unknown }; close: () => void };
const DatabaseSync = (require('node:sqlite') as { DatabaseSync: new (path: string) => Database }).DatabaseSync;
const ID = '00000000-0000-4000-8000-000000000590', AT = '2026-10-11T00:00:00.000Z';
const future = '2090-10-11T00:00:00.000Z';
const sentinel = 'PRIVATE_SENTINEL_590';
const seedData = (): AppData => ({ tasks: [{ id: 'raw', title: 'Raw', status: 'done', tags: ['keep'], contexts: ['@raw'],
    focusOrder: 9, deletedAt: AT, createdAt: AT, updatedAt: AT, rev: 7 }], projects: [], sections: [], areas: [], people: [],
    settings: { deviceId: 'device', ai: { provider: 'openai', model: sentinel, baseUrl: sentinel,
        openAIExtraBodyParams: { nested: sentinel }, speechToText: { offlineModelPath: sentinel, baseUrl: sentinel, unknown: sentinel },
        unknown: { nested: sentinel } }, unknown: sentinel,
        syncPreferencesUpdatedAt: { ai: future, language: AT } } as unknown as AppData['settings'] });
const tempRoot = join(process.cwd(), '.orchestrator/tmp/ai-timeout');
mkdirSync(tempRoot, { recursive: true });
const directories: string[] = [], databases: Database[] = [];
afterEach(async () => {
    await flushPendingSave(); resetForTests(); resetNativeRequestReceipts();
    for (const db of databases.splice(0)) db.close();
    for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
}, 20_000);
const newPath = () => { const dir = mkdtempSync(join(tempRoot, 'sqlite-')); directories.push(dir); return join(dir, 'library.db'); };
const close = (db: Database) => { db.close(); databases.splice(databases.indexOf(db), 1); };
async function open(path: string, seed = false) {
    await flushPendingSave(); resetForTests(); resetNativeRequestReceipts();
    const db = new DatabaseSync(path); databases.push(db);
    const fault = { commits: 0, failed: 0 };
    const client: SqliteClient = {
        run: async (sql, params = []) => {
            if (sql === 'COMMIT' && fault.commits > 0) { fault.commits--; fault.failed++; throw new Error('injected timeout COMMIT failure'); }
            db.prepare(sql).run(...params);
        },
        all: async <T,>(sql: string, params: unknown[] = []) => db.prepare(sql).all(...params) as T[],
        get: async <T,>(sql: string, params: unknown[] = []) => db.prepare(sql).get(...params) as T | undefined,
        exec: async sql => { db.exec(sql); },
    };
    if (seed) await new NativeReceiptSqliteAdapter(client).saveData(seedData());
    const adapter = new NativeReceiptSqliteAdapter(client, { rejectConcurrentWrites: true });
    await loadNativeRequestReceipts(client, { durableCommands: ['aiRequestTimeout'] });
    setStorageAdapter(adapter);
    useTaskStore.setState({ _allTasks: [], _allProjects: [], _allSections: [], _allAreas: [], _allPeople: [],
        settings: {}, error: null, persistenceFailure: null, isLoading: false, lastDataChangeAt: 0 } as never);
    await useTaskStore.getState().fetchData({ throwOnError: true }); await flushPendingSave();
    expect(await createNativeHostContract().activate({ writeSafetyReady: true })).toMatchObject({ ok: true });
    await flushPendingSave();
    if (seed) db.prepare('UPDATE tasks SET contexts = ?, tags = ?, focusOrder = ? WHERE id = ?').run('[ "@raw" ]', '[ "keep" ]', 9, 'raw');
    const create = () => createNativeAIRequestTimeoutMethods({ readiness: () => ({ ok: true, value: null }),
        save: async () => {
            try { await flushPendingSave(); if (useTaskStore.getState().persistenceFailure) throw new Error(); return { ok: true, value: null }; }
            catch { return { ok: false, error: { code: 'SAVE_FAILED', message: 'AI timeout save failed' } }; }
        } });
    return { db, adapter, methods: create(), create, fault };
}
type Env = Awaited<ReturnType<typeof open>>;
async function plan(env: Env, value: AIRequestTimeoutValue = 60, id = ID) {
    const options = await env.methods.options({}); if (!options.ok) throw new Error(JSON.stringify(options));
    const request: AIRequestTimeoutRequest = { requestId: id, value, expected: options.value.expected };
    const result = await env.methods.prepare(request);
    if (!result.ok || result.value.kind !== 'prepared') throw new Error(JSON.stringify(result));
    return { request, envelope: { request, prepared: result.value.prepared } };
}
const rows = (db: Database) => db.prepare('SELECT * FROM tasks').all();
const settings = (db: Database) => db.prepare('SELECT data FROM settings WHERE id = 1').get();
const receipts = (db: Database) => db.prepare('SELECT * FROM native_request_receipts').all();

describe('private AI timeout actual SQLite and store ownership', () => {
    it('writes an absent default explicitly, skips an explicit no-op and advances a future group stamp under clock rollback', async () => {
        const env = await open(newPath(), true), raw = rows(env.db), before = (await env.adapter.getData({ rawTasks: true })).settings;
        const { request, envelope } = await plan(env, 30);
        expect(request.expected.timeoutPresent).toBe(false);
        expect(await env.methods.commit(envelope)).toEqual({ ok: true, value: { value: 30, changed: true } });
        const after = (await env.adapter.getData({ rawTasks: true })).settings;
        expect(after).toEqual({ ...before, ai: { ...before.ai, requestTimeoutSeconds: 30 },
            syncPreferencesUpdatedAt: { ...before.syncPreferencesUpdatedAt, ai: '2090-10-11T00:00:00.001Z' } });
        expect(rows(env.db)).toEqual(raw);
        const options = await env.methods.options({}); if (!options.ok) throw new Error(JSON.stringify(options));
        expect(await env.methods.prepare({ ...request, requestId: '00000000-0000-4000-8000-000000000591', expected: options.value.expected }))
            .toEqual({ ok: true, value: { kind: 'noop', result: { value: 30, changed: false } } });
        expect(receipts(env.db)).toHaveLength(1);
        expect(JSON.stringify(receipts(env.db))).not.toContain(sentinel);
        expect(JSON.stringify(envelope)).not.toContain(sentinel);
    });
    it('retries the exact raw snapshot after an actual failed SQLite COMMIT and records a single receipt', async () => {
        const env = await open(newPath(), true), beforeRows = rows(env.db), beforeSettings = settings(env.db);
        const { envelope } = await plan(env);
        env.fault.commits = 10;
        expect(await env.methods.commit(envelope)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
        expect(env.fault.failed).toBeGreaterThan(0); expect(receipts(env.db)).toEqual([]);
        expect(rows(env.db)).toEqual(beforeRows); expect(settings(env.db)).toEqual(beforeSettings);
        env.fault.commits = 0;
        expect(await env.methods.commit(envelope)).toEqual({ ok: true, value: { value: 60, changed: true } });
        expect(rows(env.db)).toEqual(beforeRows); expect(receipts(env.db)).toHaveLength(1);
        expect(JSON.stringify(settings(env.db))).toContain(sentinel);
        expect(await env.methods.commit(envelope)).toEqual({ ok: true, value: { value: 60, changed: true } });
        expect(receipts(env.db)).toHaveLength(1);
    }, 20_000);
    it('returns receipt A after B and restart without overwriting B; refuses UUID reuse and cold receipt-less equality/ABA', async () => {
        const path = newPath(), env = await open(path, true), a = await plan(env, 60);
        expect(await env.methods.commit(a.envelope)).toMatchObject({ ok: true });
        const beforeB = (settings(env.db) as { data: string }).data;
        const b = await plan(env, 120, '00000000-0000-4000-8000-000000000591');
        expect(await env.methods.commit(b.envelope)).toMatchObject({ ok: true });
        close(env.db);
        const cold = await open(path), before = settings(cold.db);
        expect(await cold.methods.commit(a.envelope)).toEqual({ ok: true, value: { value: 60, changed: true } });
        expect(settings(cold.db)).toEqual(before);
        const reused = { ...a.request, value: 300 };
        expect(cold.methods.outcome(reused)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        const unknown = { request: { ...b.request, requestId: '00000000-0000-4000-8000-000000000592' },
            prepared: { version: 1, request: { ...b.request, requestId: '00000000-0000-4000-8000-000000000592' } } };
        expect(await cold.methods.commit(unknown)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        const data = await cold.adapter.getData({ rawTasks: true });
        data.settings.ai!.requestTimeoutSeconds = 60; await cold.adapter.saveData(data);
        expect(await cold.methods.commit(unknown)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        data.settings.ai!.requestTimeoutSeconds = 120; await cold.adapter.saveData(data);
        expect(await cold.methods.commit(unknown)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        cold.db.prepare('UPDATE settings SET data=? WHERE id=1').run(beforeB);
        await useTaskStore.getState().fetchData({ throwOnError: true }); await flushPendingSave();
        expect(nativeAIRequestTimeoutWitness(JSON.parse((settings(cold.db) as { data: string }).data))).toEqual(unknown.request.expected);
        const exactABA = settings(cold.db);
        expect(await cold.methods.commit(unknown)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        expect(settings(cold.db)).toEqual(exactABA);
        expect(receipts(cold.db)).toHaveLength(2);
    });
    it('CAS checks the provider and group stamp again at the actual store action boundary', async () => {
        const env = await open(newPath(), true), { request } = await plan(env), beforeSettings = settings(env.db);
        const state = useTaskStore.getState(), snapshot = await env.adapter.getData({ rawTasks: true });
        snapshot.settings.ai!.provider = 'gemini';
        expect(await state.commitPreparedAIRequestTimeout(request, { state, snapshot })).toMatchObject({ success: false });
        snapshot.settings.ai!.provider = 'openai'; snapshot.settings.syncPreferencesUpdatedAt!.ai = AT;
        expect(await state.commitPreparedAIRequestTimeout(request, { state, snapshot })).toMatchObject({ success: false });
        expect(settings(env.db)).toEqual(beforeSettings); expect(receipts(env.db)).toEqual([]);
    });
    it('refuses malformed envelopes and private legacy member presence before any write', async () => {
        const env = await open(newPath(), true), { request, envelope } = await plan(env), before = settings(env.db);
        for (const invalid of [{ ...envelope, private: sentinel }, { ...envelope, prepared: { ...envelope.prepared, version: 2 } },
            { ...envelope, prepared: { ...envelope.prepared, extra: true } }, { ...envelope, request: { ...request, value: 31 } }])
            expect(await env.methods.commit(invalid)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        const data = await env.adapter.getData({ rawTasks: true });
        Object.defineProperty(data.settings.ai, 'apiKey', { get() { throw new Error('legacy value accessed'); }, enumerable: true });
        expect(nativeAIRequestTimeoutWitness(data.settings)).toBeNull();
        expect(settings(env.db)).toEqual(before); expect(receipts(env.db)).toEqual([]);
    });
    it('joins concurrent identical commits and reserves each request identity', async () => {
        const env = await open(newPath(), true), { request, envelope } = await plan(env);
        const results = await Promise.all([env.methods.commit(envelope), env.methods.commit(envelope)]);
        expect(results).toEqual([{ ok: true, value: { value: 60, changed: true } }, { ok: true, value: { value: 60, changed: true } }]);
        expect(receipts(env.db)).toHaveLength(1);
        expect(await env.methods.prepare({ ...request, value: 300 })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    });
    it('does not replace a same-UUID different-payload authorization published while a preparation read is held', async () => {
        const env = await open(newPath(), true), options = await env.methods.options({});
        if (!options.ok) throw new Error(JSON.stringify(options));
        const request = { requestId: '00000000-0000-4000-8000-000000000590', value: 60, expected: options.value.expected };
        const get = env.adapter.getData.bind(env.adapter); let release!: () => void, entered!: () => void, reads = 0;
        const hold = new Promise<void>(resolve => { release = resolve; }), entry = new Promise<void>(resolve => { entered = resolve; });
        env.adapter.getData = async args => { if (++reads === 1) { entered(); await hold; } return get(args); };
        const first = env.methods.prepare(request); await entry;
        const secondRequest = { ...request, value: 300 }, second = await env.methods.prepare(secondRequest);
        expect(second).toMatchObject({ ok: true, value: { kind: 'prepared' } });
        release(); expect(await first).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        env.adapter.getData = get;
        if (!second.ok || second.value.kind !== 'prepared') throw new Error('Second request must retain its authorization');
        expect(await env.methods.commit({ request: secondRequest, prepared: second.value.prepared }))
            .toEqual({ ok: true, value: { value: 300, changed: true } });
        expect(receipts(env.db)).toHaveLength(1);
    });
    it('retires an older unapplied preparation when a fresh UUID is prepared while preserving the current intent', async () => {
        const env = await open(newPath(), true), a = await plan(env, 60), before = settings(env.db), raw = rows(env.db);
        const b = await plan(env, 300, '00000000-0000-4000-8000-000000000591');
        expect(await env.methods.commit(a.envelope)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        expect(settings(env.db)).toEqual(before); expect(rows(env.db)).toEqual(raw); expect(receipts(env.db)).toEqual([]);
        expect(await env.methods.commit(b.envelope)).toEqual({ ok: true, value: { value: 300, changed: true } });
        expect(rows(env.db)).toEqual(raw); expect(receipts(env.db)).toHaveLength(1);
    });
    it('refuses a foreign persistence failure during a held read and at retry without overwriting it', async () => {
        const env = await open(newPath(), true), { envelope } = await plan(env), before = settings(env.db);
        const get = env.adapter.getData.bind(env.adapter); let release!: () => void, entered!: () => void;
        const gate = new Promise<void>(resolve => { release = resolve; }), entry = new Promise<void>(resolve => { entered = resolve; });
        env.adapter.getData = async options => { entered(); await gate; return get(options); };
        const commit = env.methods.commit(envelope); await entry;
        const foreign = { message: 'foreign', failedAt: AT, retrying: false };
        useTaskStore.setState({ persistenceFailure: foreign }); release();
        expect(await commit).toMatchObject({ ok: false, error: { code: 'ACTION_FAILED' } });
        expect(useTaskStore.getState().persistenceFailure).toBe(foreign); expect(settings(env.db)).toEqual(before);
        env.adapter.getData = get; useTaskStore.setState({ persistenceFailure: null });
        expect(await env.methods.options({})).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        env.methods = env.create();
        const retryPlan = await plan(env);
        env.fault.commits = 10;
        expect(await env.methods.commit(retryPlan.envelope)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
        useTaskStore.setState({ persistenceFailure: foreign }); env.fault.commits = 0;
        expect(await env.methods.commit(envelope)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
        expect(useTaskStore.getState().persistenceFailure).toBe(foreign); expect(receipts(env.db)).toEqual([]);
    }, 20_000);
    it('retires raced full reads even after getData accepted a newer external epoch; only a new loaded owner can proceed', async () => {
        const path = newPath(), env = await open(path, true), { envelope } = await plan(env);
        const external = new DatabaseSync(path); databases.push(external);
        const get = env.adapter.getData.bind(env.adapter);
        env.adapter.getData = async options => {
            external.prepare('UPDATE settings SET data = json_set(data, ?, ?) WHERE id = 1').run('$.ai.requestTimeoutSeconds', 120);
            return get(options);
        };
        expect(await env.methods.commit(envelope)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        env.adapter.getData = get;
        await useTaskStore.getState().fetchData({ throwOnError: true }); await flushPendingSave();
        expect(await env.methods.options({})).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        env.methods = env.create();
        expect(await env.methods.options({})).toMatchObject({ ok: true, value: { value: 120 } });
        expect(receipts(env.db)).toEqual([]);
    });
    it('does not let a foreign adapter authorize an owned failed save retry', async () => {
        const env = await open(newPath(), true), { envelope } = await plan(env);
        env.fault.commits = 10; expect(await env.methods.commit(envelope)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
        const failure = useTaskStore.getState().persistenceFailure, status = getPersistenceStatus();
        setStorageAdapter(new NativeReceiptSqliteAdapter({ run: async () => {}, all: async () => [], get: async () => undefined }));
        env.fault.commits = 0;
        expect(await env.methods.commit(envelope)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
        expect(useTaskStore.getState().persistenceFailure).toBe(failure);
        expect(getPersistenceStatus().generation).toBe(status.generation); expect(receipts(env.db)).toEqual([]);
    }, 20_000);
    it('refuses a retry across an actual newer failed snapshot generation even if its failure identity is supplied', async () => {
        const env = await open(newPath(), true), { request } = await plan(env), state = useTaskStore.getState();
        const authority: PreparedAreaAuthority = { state, snapshot: await env.adapter.getData({ rawTasks: true }) };
        env.fault.commits = 10;
        expect(await state.commitPreparedAIRequestTimeout(request, authority)).toMatchObject({ success: true });
        await expect(flushPendingSave()).rejects.toThrow();
        const generation = authority.saveBoundary!.generation;
        await useTaskStore.getState().persistSnapshot(); await expect(flushPendingSave()).rejects.toThrow();
        expect(getPersistenceStatus().generation).toBeGreaterThan(generation);
        authority.saveBoundary!.failure = useTaskStore.getState().persistenceFailure;
        const failure = useTaskStore.getState().persistenceFailure, before = settings(env.db), current = getPersistenceStatus();
        expect(await useTaskStore.getState().retryPreparedAIRequestTimeoutSnapshot(authority)).toMatchObject({ success: false });
        expect(useTaskStore.getState().persistenceFailure).toBe(failure);
        expect(getPersistenceStatus()).toEqual(current); expect(settings(env.db)).toEqual(before); expect(receipts(env.db)).toEqual([]);
    }, 20_000);
    it('refuses a raw SQLite legacy apiKey member by presence without removing it or private neighbors', async () => {
        const env = await open(newPath(), true);
        const raw = (await env.adapter.getData()).settings;
        const withLegacy = { ...raw, ai: { ...raw.ai, apiKey: null } };
        env.db.prepare('UPDATE settings SET data=? WHERE id=1').run(JSON.stringify(withLegacy));
        await useTaskStore.getState().fetchData({ throwOnError: true }); await flushPendingSave();
        const before = settings(env.db);
        expect(await env.methods.options({})).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(settings(env.db)).toEqual(before); expect(receipts(env.db)).toEqual([]);
        expect(JSON.stringify(before)).toContain(sentinel);
    });
    it('merges explicit timeout against an old peer omission and produces zero changes on the second merge', async () => {
        const env = await open(newPath(), true), { envelope } = await plan(env, 300);
        expect(await env.methods.commit(envelope)).toMatchObject({ ok: true });
        const after = (await env.adapter.getData()).settings, old = { deviceId: 'old-peer', ai: { provider: 'openai' as const },
            syncPreferencesUpdatedAt: { ai: AT } };
        const merged = mergeSettingsForSync(after, old);
        expect(merged.ai?.requestTimeoutSeconds).toBe(300);
        expect(mergeSettingsForSync(merged, old)).toEqual(merged);
    });
});
