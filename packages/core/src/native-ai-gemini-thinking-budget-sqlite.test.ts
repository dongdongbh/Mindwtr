import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { AIGeminiThinkingBudgetRequest, AIGeminiThinkingBudgetValue } from './native-ai-gemini-thinking-budget';
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
    focusOrder: 9, deletedAt: AT, createdAt: AT, updatedAt: AT, rev: 7 }],
    projects: [{ id: 'p', title: 'Project', status: 'active', color: '#123456', order: 7, tagIds: ['keep'],
        supportNotes: sentinel, createdAt: AT, updatedAt: AT }],
    sections: [{ id: 's', projectId: 'p', title: 'Section', order: 3, createdAt: AT, updatedAt: AT }],
    areas: [{ id: 'a', name: 'Area', order: 5, createdAt: AT, updatedAt: AT }],
    people: [{ id: 'person', name: 'Person', note: sentinel, createdAt: AT, updatedAt: AT }],
    settings: { deviceId: 'device', ai: { enabled: false, provider: 'gemini', model: sentinel, baseUrl: sentinel,
        openAIExtraBodyParams: { nested: sentinel }, speechToText: { offlineModelPath: sentinel, baseUrl: sentinel, unknown: sentinel },
        unknown: { nested: sentinel } }, unknown: sentinel,
        syncPreferencesUpdatedAt: { ai: future, language: AT } } as unknown as AppData['settings'] });
const tempRoot = join(process.cwd(), '.orchestrator/tmp/ai-gemini-thinking-budget');
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
    const fault = { commits: 0, failed: 0, attempts: 0 };
    const client: SqliteClient = {
        run: async (sql, params = []) => {
            if (sql === 'COMMIT') fault.attempts++;
            if (sql === 'COMMIT' && fault.commits > 0) { fault.commits--; fault.failed++; throw new Error('injected Gemini thinking budget COMMIT failure'); }
            db.prepare(sql).run(...params);
        },
        all: async <T,>(sql: string, params: unknown[] = []) => db.prepare(sql).all(...params) as T[],
        get: async <T,>(sql: string, params: unknown[] = []) => db.prepare(sql).get(...params) as T | undefined,
        exec: async sql => { db.exec(sql); },
    };
    if (seed) await new NativeReceiptSqliteAdapter(client).saveData(seedData());
    const adapter = new NativeReceiptSqliteAdapter(client, { rejectConcurrentWrites: true });
    await loadNativeRequestReceipts(client, { durableCommands: ['aiGeminiThinkingBudget', 'aiRequestTimeout', 'aiReasoningEffort'] });
    setStorageAdapter(adapter);
    useTaskStore.setState({ _allTasks: [], _allProjects: [], _allSections: [], _allAreas: [], _allPeople: [],
        settings: {}, error: null, persistenceFailure: null, isLoading: false, lastDataChangeAt: 0 } as never);
    await useTaskStore.getState().fetchData({ throwOnError: true }); await flushPendingSave();
    expect(await createNativeHostContract().activate({ writeSafetyReady: true })).toMatchObject({ ok: true });
    await flushPendingSave();
    if (seed) db.prepare('UPDATE tasks SET contexts = ?, tags = ?, focusOrder = ? WHERE id = ?').run('[ "@raw" ]', '[ "keep" ]', 9, 'raw');
    expect(typeof useTaskStore.getState().applyPreparedAIGeminiThinkingBudget).toBe('function');
    const { createNativeAIGeminiThinkingBudgetMethods } = await import('./native-ai-gemini-thinking-budget');
    const create = () => createNativeAIGeminiThinkingBudgetMethods({ readiness: () => ({ ok: true, value: null }),
        save: async () => {
            try { await flushPendingSave(); if (useTaskStore.getState().persistenceFailure) throw new Error(); return { ok: true, value: null }; }
            catch { return { ok: false, error: { code: 'SAVE_FAILED', message: 'AI Gemini thinking budget save failed' } }; }
        } });
    return { db, adapter, methods: create(), create, fault };
}
type Env = Awaited<ReturnType<typeof open>>;
async function plan(env: Env, value: AIGeminiThinkingBudgetValue = 256, id = ID) {
    const options = await env.methods.options({}); if (!options.ok) throw new Error(JSON.stringify(options));
    const request: AIGeminiThinkingBudgetRequest = { requestId: id, value, expected: options.value.expected };
    const result = await env.methods.prepare(request);
    if (!result.ok || result.value.kind !== 'prepared') throw new Error(JSON.stringify(result));
    return { request, envelope: { request, prepared: result.value.prepared } };
}
const rows = (db: Database) => db.prepare('SELECT * FROM tasks').all();
const settings = (db: Database) => db.prepare('SELECT data FROM settings WHERE id = 1').get();
const receipts = (db: Database) => db.prepare('SELECT * FROM native_request_receipts').all();
const domainRows = (db: Database) => Object.fromEntries(['tasks', 'projects', 'sections', 'areas', 'people']
    .map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY id`).all()]));
async function reloadSettings(env: Env, change: (settings: AppData['settings']) => void) {
    const raw = JSON.parse((settings(env.db) as { data: string }).data) as AppData['settings'];
    change(raw);
    env.db.prepare('UPDATE settings SET data=? WHERE id=1').run(JSON.stringify(raw));
    await useTaskStore.getState().fetchData({ throwOnError: true }); await flushPendingSave();
}

describe('private AI Gemini thinking budget actual SQLite and store ownership', () => {
    it.each([0, 128, 256, 512] as const)('preserves a custom saved budget through reads, then writes explicit %s while AI is disabled', async value => {
        const env = await open(newPath(), true);
        await reloadSettings(env, raw => { raw.ai!.thinkingBudget = 1024; });
        const before = settings(env.db), domain = domainRows(env.db), attempts = env.fault.attempts;
        expect(await env.methods.options({})).toMatchObject({ ok: true, value: { value: 1024,
            expected: { budgetPresent: true, budget: 1024 } } });
        expect(settings(env.db)).toEqual(before); expect(env.fault.attempts).toBe(attempts); expect(receipts(env.db)).toEqual([]);
        const { envelope } = await plan(env, value);
        expect(await env.methods.commit(envelope)).toEqual({ ok: true, value: { value, changed: true } });
        const after = (await env.adapter.getData({ rawTasks: true })).settings;
        const original = JSON.parse((before as { data: string }).data) as AppData['settings'];
        expect(after).toEqual({ ...original, ai: { ...original.ai, thinkingBudget: value },
            syncPreferencesUpdatedAt: { ...original.syncPreferencesUpdatedAt, ai: '2090-10-11T00:00:00.001Z' } });
        expect(after.ai?.enabled).toBe(false); expect(domainRows(env.db)).toEqual(domain);
        expect(receipts(env.db)).toHaveLength(1);
    });
    it.each([false, true])('refuses absent provider instead of materializing Gemini (AI group present: %s)', async aiPresent => {
        const env = await open(newPath(), true), { envelope } = await plan(env);
        await reloadSettings(env, raw => { if (aiPresent) delete raw.ai!.provider; else delete raw.ai; });
        const before = settings(env.db), domain = domainRows(env.db), attempts = env.fault.attempts;
        expect(await env.methods.options({})).toMatchObject({ ok: false, error: { code: 'ACTION_FAILED' } });
        const state = useTaskStore.getState(), snapshot = await env.adapter.getData({ rawTasks: true });
        const expected = (await import('./native-ai-gemini-thinking-budget')).nativeAIGeminiThinkingBudgetWitness(snapshot.settings)!;
        const request = { requestId: '00000000-0000-4000-8000-000000000591', value: 0 as const, expected };
        expect(await env.methods.prepare(request)).toMatchObject({ ok: false, error: { code: 'ACTION_FAILED' } });
        expect(await env.methods.commit(envelope)).toMatchObject({ ok: false, error: { code: 'ACTION_FAILED' } });
        expect(await state.applyPreparedAIGeminiThinkingBudget(request, { state, snapshot })).toMatchObject({ success: false });
        expect(settings(env.db)).toEqual(before); expect(domainRows(env.db)).toEqual(domain);
        expect(env.fault.attempts).toBe(attempts); expect(receipts(env.db)).toEqual([]);
    });
    it.each(['openai', 'anthropic'] as const)('refuses explicitly saved %s options, preparation and commit without writes', async provider => {
        const env = await open(newPath(), true), { envelope } = await plan(env);
        await reloadSettings(env, raw => { raw.ai!.provider = provider; });
        const before = settings(env.db), domain = domainRows(env.db), attempts = env.fault.attempts;
        const state = useTaskStore.getState(), snapshot = await env.adapter.getData({ rawTasks: true });
        const expected = (await import('./native-ai-gemini-thinking-budget')).nativeAIGeminiThinkingBudgetWitness(snapshot.settings)!;
        const request = { requestId: '00000000-0000-4000-8000-000000000591', value: 256 as const, expected };
        expect(await env.methods.options({})).toMatchObject({ ok: false, error: { code: 'ACTION_FAILED' } });
        expect(await env.methods.prepare(request)).toMatchObject({ ok: false, error: { code: 'ACTION_FAILED' } });
        expect(await env.methods.commit(envelope)).toMatchObject({ ok: false, error: { code: 'ACTION_FAILED' } });
        expect(await state.applyPreparedAIGeminiThinkingBudget(request, { state, snapshot })).toMatchObject({ success: false });
        expect(settings(env.db)).toEqual(before); expect(domainRows(env.db)).toEqual(domain);
        expect(env.fault.attempts).toBe(attempts); expect(receipts(env.db)).toEqual([]);
    });
    it.each([-1, 32769, 1.5, '128', null])('refuses malformed saved budget %s without changing raw bytes', async value => {
        const env = await open(newPath(), true);
        await reloadSettings(env, raw => { (raw.ai as Record<string, unknown>).thinkingBudget = value; });
        const before = settings(env.db), domain = domainRows(env.db), attempts = env.fault.attempts;
        expect(await env.methods.options({})).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(settings(env.db)).toEqual(before); expect(domainRows(env.db)).toEqual(domain);
        expect(env.fault.attempts).toBe(attempts); expect(receipts(env.db)).toEqual([]);
    });
    it('waits for an active edit and retires cancellation ownership without saving defaults', async () => {
        const env = await open(newPath(), true), before = settings(env.db), attempts = env.fault.attempts;
        useTaskStore.setState({ editLockCount: 1 });
        expect(await env.methods.options({})).toMatchObject({ ok: false, error: { code: 'ACTION_FAILED' } });
        useTaskStore.setState({ editLockCount: 0, isLoading: true });
        expect(await env.methods.options({})).toMatchObject({ ok: false, error: { code: 'ACTION_FAILED' } });
        useTaskStore.setState({ isLoading: false });
        expect(await env.methods.options({}, () => { throw new Error('retired owner'); }))
            .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        expect(await env.methods.options({})).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        expect(settings(env.db)).toEqual(before); expect(env.fault.attempts).toBe(attempts); expect(receipts(env.db)).toEqual([]);
    });
    it('never treats a timeout receipt as gemini-thinking-budget authority for the same UUID', async () => {
        const env = await open(newPath(), true);
        const { createNativeAIRequestTimeoutMethods } = await import('./native-ai-request-timeout');
        const timeout = createNativeAIRequestTimeoutMethods({ readiness: () => ({ ok: true, value: null }),
            save: async () => { await flushPendingSave(); return { ok: true, value: null }; } });
        const options = await timeout.options({}); if (!options.ok) throw new Error(JSON.stringify(options));
        const request = { requestId: ID, value: 30 as const, expected: options.value.expected };
        const prepared = await timeout.prepare(request);
        if (!prepared.ok || prepared.value.kind !== 'prepared') throw new Error(JSON.stringify(prepared));
        expect(await timeout.commit({ request, prepared: prepared.value.prepared })).toMatchObject({ ok: true });
        const budget = await env.methods.options({}); if (!budget.ok) throw new Error(JSON.stringify(budget));
        const requested = { requestId: ID, value: 0 as const, expected: budget.value.expected };
        const before = settings(env.db), attempts = env.fault.attempts;
        expect(env.methods.outcome(requested)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(await env.methods.prepare(requested)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(settings(env.db)).toEqual(before); expect(env.fault.attempts).toBe(attempts); expect(receipts(env.db)).toHaveLength(1);
        const fresh = await plan(env, 0, '00000000-0000-4000-8000-000000000591');
        expect(await env.methods.commit(fresh.envelope)).toMatchObject({ ok: true });
        expect(receipts(env.db)).toMatchObject([{ method: expect.stringMatching(/^aiRequestTimeout:/) },
            { method: expect.stringMatching(/^aiGeminiThinkingBudget:/) }]);
    });
    it('never treats an effort receipt as Gemini-budget authority for the same UUID', async () => {
        const env = await open(newPath(), true);
        await reloadSettings(env, raw => { raw.ai!.provider = 'openai'; });
        const { createNativeAIReasoningEffortMethods } = await import('./native-ai-reasoning-effort');
        const effort = createNativeAIReasoningEffortMethods({ readiness: () => ({ ok: true, value: null }),
            save: async () => { await flushPendingSave(); return { ok: true, value: null }; } });
        const options = await effort.options({}); if (!options.ok) throw new Error(JSON.stringify(options));
        const request = { requestId: ID, value: 'high' as const, expected: options.value.expected };
        const prepared = await effort.prepare(request);
        if (!prepared.ok || prepared.value.kind !== 'prepared') throw new Error(JSON.stringify(prepared));
        expect(await effort.commit({ request, prepared: prepared.value.prepared })).toMatchObject({ ok: true });
        await reloadSettings(env, raw => { raw.ai!.provider = 'gemini'; });
        env.methods = env.create();
        const budget = await env.methods.options({}); if (!budget.ok) throw new Error(JSON.stringify(budget));
        const reused = { requestId: ID, value: 128 as const, expected: budget.value.expected };
        const before = settings(env.db), attempts = env.fault.attempts;
        expect(env.methods.outcome(reused)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(await env.methods.prepare(reused)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(settings(env.db)).toEqual(before); expect(env.fault.attempts).toBe(attempts);
        const fresh = await plan(env, 128, '00000000-0000-4000-8000-000000000591');
        expect(await env.methods.commit(fresh.envelope)).toMatchObject({ ok: true });
        expect(receipts(env.db)).toMatchObject([{ method: expect.stringMatching(/^aiReasoningEffort:/) },
            { method: expect.stringMatching(/^aiGeminiThinkingBudget:/) }]);
    });
    it('writes an absent default explicitly, skips an explicit no-op and advances a future group stamp under clock rollback', async () => {
        const env = await open(newPath(), true), raw = domainRows(env.db), before = (await env.adapter.getData({ rawTasks: true })).settings;
        const passive = await env.methods.options({});
        expect(passive).toMatchObject({ ok: true, value: { value: 0, expected: { budgetPresent: false } } });
        expect((await env.adapter.getData({ rawTasks: true })).settings).toEqual(before);
        const { request, envelope } = await plan(env, 0);
        expect(request.expected.budgetPresent).toBe(false);
        expect(await env.methods.commit(envelope)).toEqual({ ok: true, value: { value: 0, changed: true } });
        const after = (await env.adapter.getData({ rawTasks: true })).settings;
        expect(after).toEqual({ ...before, ai: { ...before.ai, thinkingBudget: 0 },
            syncPreferencesUpdatedAt: { ...before.syncPreferencesUpdatedAt, ai: '2090-10-11T00:00:00.001Z' } });
        expect(domainRows(env.db)).toEqual(raw);
        const options = await env.methods.options({}); if (!options.ok) throw new Error(JSON.stringify(options));
        const noOpBytes = settings(env.db), attempts = env.fault.attempts;
        expect(await env.methods.prepare({ ...request, requestId: '00000000-0000-4000-8000-000000000591', expected: options.value.expected }))
            .toEqual({ ok: true, value: { kind: 'noop', result: { value: 0, changed: false } } });
        expect(receipts(env.db)).toHaveLength(1);
        expect(settings(env.db)).toEqual(noOpBytes); expect(env.fault.attempts).toBe(attempts);
        expect(JSON.stringify(receipts(env.db))).not.toContain(sentinel);
        expect(JSON.stringify(envelope)).not.toContain(sentinel);
    });
    it('retries the exact raw snapshot after an actual failed SQLite COMMIT and records a single receipt', async () => {
        const env = await open(newPath(), true);
        await reloadSettings(env, raw => { raw.ai!.thinkingBudget = 1024; });
        const beforeRows = domainRows(env.db), beforeSettings = settings(env.db);
        const { envelope } = await plan(env);
        const attempts = env.fault.attempts;
        env.fault.commits = 5;
        expect(await env.methods.commit(envelope)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
        expect(env.fault.failed).toBe(5); expect(receipts(env.db)).toEqual([]);
        expect(env.fault.attempts).toBe(attempts + 5);
        expect(domainRows(env.db)).toEqual(beforeRows); expect(settings(env.db)).toEqual(beforeSettings);
        const failure = useTaskStore.getState().persistenceFailure, status = getPersistenceStatus();
        const changed = { ...envelope.request, value: 512 as const };
        expect(await env.methods.commit({ request: changed, prepared: { version: 1, request: changed } }))
            .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(useTaskStore.getState().persistenceFailure).toBe(failure); expect(getPersistenceStatus()).toEqual(status);
        env.fault.commits = 0;
        expect(await env.methods.commit(envelope)).toEqual({ ok: true, value: { value: 256, changed: true } });
        expect(env.fault.attempts).toBe(attempts + 6);
        expect(domainRows(env.db)).toEqual(beforeRows); expect(receipts(env.db)).toHaveLength(1);
        expect(JSON.stringify(settings(env.db))).toContain(sentinel);
        expect(await env.methods.commit(envelope)).toEqual({ ok: true, value: { value: 256, changed: true } });
        expect(receipts(env.db)).toHaveLength(1);
        expect(env.fault.attempts).toBe(attempts + 6);
    }, 20_000);
    it('returns receipt A after B and restart without overwriting B; refuses UUID reuse and cold receipt-less equality/ABA', async () => {
        const path = newPath(), env = await open(path, true), a = await plan(env, 256);
        expect(await env.methods.commit(a.envelope)).toMatchObject({ ok: true });
        const beforeB = (settings(env.db) as { data: string }).data;
        const b = await plan(env, 512, '00000000-0000-4000-8000-000000000591');
        expect(await env.methods.commit(b.envelope)).toMatchObject({ ok: true });
        close(env.db);
        const cold = await open(path), before = settings(cold.db);
        expect(await cold.methods.commit(a.envelope)).toEqual({ ok: true, value: { value: 256, changed: true } });
        expect(settings(cold.db)).toEqual(before);
        const reused = { ...a.request, value: 512 };
        expect(cold.methods.outcome(reused)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        const unknown = { request: { ...b.request, requestId: '00000000-0000-4000-8000-000000000592' },
            prepared: { version: 1, request: { ...b.request, requestId: '00000000-0000-4000-8000-000000000592' } } };
        expect(await cold.methods.commit(unknown)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        const data = await cold.adapter.getData({ rawTasks: true });
        data.settings.ai!.thinkingBudget = 256; await cold.adapter.saveData(data);
        expect(await cold.methods.commit(unknown)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        data.settings.ai!.thinkingBudget = 512; await cold.adapter.saveData(data);
        expect(await cold.methods.commit(unknown)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        cold.db.prepare('UPDATE settings SET data=? WHERE id=1').run(beforeB);
        await useTaskStore.getState().fetchData({ throwOnError: true }); await flushPendingSave();
        expect((await import('./native-ai-gemini-thinking-budget')).nativeAIGeminiThinkingBudgetWitness(JSON.parse((settings(cold.db) as { data: string }).data))).toEqual(unknown.request.expected);
        const exactABA = settings(cold.db);
        expect(await cold.methods.commit(unknown)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        expect(settings(cold.db)).toEqual(exactABA);
        expect(receipts(cold.db)).toHaveLength(2);
    });
    it('CAS checks the provider and group stamp again at the actual store action boundary', async () => {
        const env = await open(newPath(), true), { request } = await plan(env), beforeSettings = settings(env.db);
        const state = useTaskStore.getState(), snapshot = await env.adapter.getData({ rawTasks: true });
        snapshot.settings.ai!.provider = 'openai';
        expect(await state.applyPreparedAIGeminiThinkingBudget(request, { state, snapshot })).toMatchObject({ success: false });
        snapshot.settings.ai!.provider = 'gemini'; snapshot.settings.syncPreferencesUpdatedAt!.ai = AT;
        expect(await state.applyPreparedAIGeminiThinkingBudget(request, { state, snapshot })).toMatchObject({ success: false });
        expect(settings(env.db)).toEqual(beforeSettings); expect(receipts(env.db)).toEqual([]);
    });
    it('refuses malformed envelopes and private legacy member presence before any write', async () => {
        const env = await open(newPath(), true), { request, envelope } = await plan(env), before = settings(env.db);
        for (const invalid of [{ ...envelope, private: sentinel }, { ...envelope, prepared: { ...envelope.prepared, version: 2 } },
            { ...envelope, prepared: { ...envelope.prepared, extra: true } }, { ...envelope, request: { ...request, value: 31 } }])
            expect(await env.methods.commit(invalid)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        const data = await env.adapter.getData({ rawTasks: true });
        Object.defineProperty(data.settings.ai, 'apiKey', { get() { throw new Error('legacy value accessed'); }, enumerable: true });
        expect((await import('./native-ai-gemini-thinking-budget')).nativeAIGeminiThinkingBudgetWitness(data.settings)).toBeNull();
        expect(settings(env.db)).toEqual(before); expect(receipts(env.db)).toEqual([]);
    });
    it('joins concurrent identical commits and reserves each request identity', async () => {
        const env = await open(newPath(), true), { request, envelope } = await plan(env);
        const results = await Promise.all([env.methods.commit(envelope), env.methods.commit(envelope)]);
        expect(results).toEqual([{ ok: true, value: { value: 256, changed: true } }, { ok: true, value: { value: 256, changed: true } }]);
        expect(receipts(env.db)).toHaveLength(1);
        expect(await env.methods.prepare({ ...request, value: 512 })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    });
    it('does not replace a same-UUID different-payload authorization published while a preparation read is held', async () => {
        const env = await open(newPath(), true), options = await env.methods.options({});
        if (!options.ok) throw new Error(JSON.stringify(options));
        const request = { requestId: '00000000-0000-4000-8000-000000000590', value: 256 as const, expected: options.value.expected };
        const get = env.adapter.getData.bind(env.adapter); let release!: () => void, entered!: () => void, reads = 0;
        const hold = new Promise<void>(resolve => { release = resolve; }), entry = new Promise<void>(resolve => { entered = resolve; });
        env.adapter.getData = async args => { if (++reads === 1) { entered(); await hold; } return get(args); };
        const first = env.methods.prepare(request); await entry;
        const secondRequest = { ...request, value: 512 }, second = await env.methods.prepare(secondRequest);
        expect(second).toMatchObject({ ok: true, value: { kind: 'prepared' } });
        release(); expect(await first).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        env.adapter.getData = get;
        if (!second.ok || second.value.kind !== 'prepared') throw new Error('Second request must retain its authorization');
        expect(await env.methods.commit({ request: secondRequest, prepared: second.value.prepared }))
            .toEqual({ ok: true, value: { value: 512, changed: true } });
        expect(receipts(env.db)).toHaveLength(1);
    });
    it('retires an older unapplied preparation when a fresh UUID is prepared while preserving the current intent', async () => {
        const env = await open(newPath(), true), a = await plan(env, 256), before = settings(env.db), raw = rows(env.db);
        const b = await plan(env, 512, '00000000-0000-4000-8000-000000000591');
        expect(await env.methods.commit(a.envelope)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        expect(settings(env.db)).toEqual(before); expect(rows(env.db)).toEqual(raw); expect(receipts(env.db)).toEqual([]);
        expect(await env.methods.commit(b.envelope)).toEqual({ ok: true, value: { value: 512, changed: true } });
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
        env.fault.commits = 5;
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
            external.prepare('UPDATE settings SET data = json_set(data, ?, ?) WHERE id = 1').run('$.ai.thinkingBudget', 512);
            return get(options);
        };
        expect(await env.methods.commit(envelope)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        env.adapter.getData = get;
        await useTaskStore.getState().fetchData({ throwOnError: true }); await flushPendingSave();
        expect(await env.methods.options({})).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        env.methods = env.create();
        expect(await env.methods.options({})).toMatchObject({ ok: true, value: { value: 512 } });
        expect(receipts(env.db)).toEqual([]);
    });
    it('does not let a foreign adapter authorize an owned failed save retry', async () => {
        const env = await open(newPath(), true), { envelope } = await plan(env);
        env.fault.commits = 5; expect(await env.methods.commit(envelope)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
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
        env.fault.commits = 5;
        expect(await state.applyPreparedAIGeminiThinkingBudget(request, authority)).toMatchObject({ success: true });
        await expect(flushPendingSave()).rejects.toThrow();
        const generation = authority.saveBoundary!.generation;
        env.fault.commits = 5;
        await useTaskStore.getState().persistSnapshot(); await expect(flushPendingSave()).rejects.toThrow();
        expect(getPersistenceStatus().generation).toBeGreaterThan(generation);
        authority.saveBoundary!.failure = useTaskStore.getState().persistenceFailure;
        const failure = useTaskStore.getState().persistenceFailure, before = settings(env.db), current = getPersistenceStatus();
        expect(await useTaskStore.getState().retryPreparedAIGeminiThinkingBudgetSnapshot(authority)).toMatchObject({ success: false });
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
    it('merges explicit Gemini thinking budget against an old peer omission and produces zero changes on the second merge', async () => {
        const env = await open(newPath(), true), { envelope } = await plan(env, 512);
        expect(await env.methods.commit(envelope)).toMatchObject({ ok: true });
        const after = (await env.adapter.getData()).settings, old = { deviceId: 'old-peer', ai: { provider: 'gemini' as const },
            syncPreferencesUpdatedAt: { ai: AT } };
        const merged = mergeSettingsForSync(after, old);
        expect(merged.ai?.thinkingBudget).toBe(512);
        expect(mergeSettingsForSync(merged, old)).toEqual(merged);
    });
});
