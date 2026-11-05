import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createNativeAITextConfigurationMethods, nativeAITextConfigurationWitness, type AITextConfigurationRequest,
    type AITextConfigurationChange } from './native-ai-text-configuration';
import { NativeReceiptSqliteAdapter, loadNativeRequestReceipts, resetNativeRequestReceipts } from './native-request-receipts';
import { flushPendingSave, getPersistenceStatus, resetForTests, setStorageAdapter, useTaskStore } from './store';
import { createNativeHostContract } from './native-host-contract';
import { getTranslator } from './i18n';
import type { SqliteClient } from './sqlite-adapter';
import type { AppData } from './types';
import type { AIProviderId } from './ai/types';
import { getAIConsentPrompt, getAIProviderDefaultsPatch, createAISettingsTranslator } from './ai-settings-model';
import { nativeAITextConfigurationWitnessV2, type AITextConfigurationRequestV2, type AITextConfigurationChangeV2 } from './native-ai-text-configuration';

const require = createRequire(import.meta.url);
type Database = { exec: (sql: string) => void; prepare: (sql: string) => {
    run: (...params: unknown[]) => unknown; all: (...params: unknown[]) => unknown[]; get: (...params: unknown[]) => unknown }; close: () => void };
const DatabaseSync = (require('node:sqlite') as { DatabaseSync: new (path: string) => Database }).DatabaseSync;
const ID = '00000000-0000-4000-8000-000000000590', AT = '2026-10-11T00:00:00.000Z';
const future = '2090-10-11T00:00:00.000Z';
const sentinel = 'PRIVATE_SENTINEL_590';
const seedData = (): AppData => ({ tasks: [{ id: 'raw', title: 'Raw', status: 'done', tags: ['keep'], contexts: ['@raw'],
    focusOrder: 9, deletedAt: AT, createdAt: AT, updatedAt: AT, rev: 7 }], projects: [], sections: [], areas: [], people: [],
    settings: { deviceId: 'device', ai: { provider: 'openai', model: 'custom-assistant', copilotModel: 'custom-copilot', baseUrl: sentinel,
        openAIExtraBodyParams: { nested: sentinel }, speechToText: { offlineModelPath: sentinel, baseUrl: sentinel, unknown: sentinel },
        unknown: { nested: sentinel } }, unknown: sentinel,
        syncPreferencesUpdatedAt: { ai: future, language: AT } } as unknown as AppData['settings'] });
const tempRoot = join(process.cwd(), '.orchestrator/tmp/ai-text-configuration');
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
async function open(path: string, seed = false, data = seedData()) {
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
    if (seed) await new NativeReceiptSqliteAdapter(client).saveData(data);
    const adapter = new NativeReceiptSqliteAdapter(client, { rejectConcurrentWrites: true });
    await loadNativeRequestReceipts(client, { durableCommands: ['aiTextConfiguration', 'aiTextConfigurationV2'] });
    setStorageAdapter(adapter);
    useTaskStore.setState({ _allTasks: [], _allProjects: [], _allSections: [], _allAreas: [], _allPeople: [],
        settings: {}, error: null, persistenceFailure: null, isLoading: false, lastDataChangeAt: 0 } as never);
    await useTaskStore.getState().fetchData({ throwOnError: true }); await flushPendingSave();
    expect(await createNativeHostContract().activate({ writeSafetyReady: true })).toMatchObject({ ok: true });
    await flushPendingSave();
    if (seed) db.prepare('UPDATE tasks SET contexts = ?, tags = ?, focusOrder = ? WHERE id = ?').run('[ "@raw" ]', '[ "keep" ]', 9, 'raw');
    const create = () => createNativeAITextConfigurationMethods({ readiness: () => ({ ok: true, value: null }),
        t: () => getTranslator('en'), save: async () => {
            try { await flushPendingSave(); if (useTaskStore.getState().persistenceFailure) throw new Error(); return { ok: true, value: null }; }
            catch { return { ok: false, error: { code: 'SAVE_FAILED', message: 'AI text configuration save failed' } }; }
        } });
    return { db, adapter, methods: create(), create, fault };
}
type Env = Awaited<ReturnType<typeof open>>;
async function plan(env: Env, change: AITextConfigurationChange = { type: 'copilotModel', value: 'new-copilot' },
    id = ID, consent = false, consentRecorded = false) {
    const options = await env.methods.options({}); if (!options.ok) throw new Error(JSON.stringify(options));
    const request: AITextConfigurationRequest = { requestId: id, change, expected: options.value.expected, consent };
    const result = await env.methods.prepare(request, () => {}, consentRecorded);
    if (!result.ok || result.value.kind !== 'prepared') throw new Error(JSON.stringify(result));
    return { request, envelope: { request, prepared: result.value.prepared } };
}
const rows = (db: Database) => db.prepare('SELECT * FROM tasks').all();
const settings = (db: Database) => db.prepare('SELECT data FROM settings WHERE id = 1').get();
const receipts = (db: Database) => db.prepare('SELECT * FROM native_request_receipts').all();

describe('private AI text setup actual SQLite ownership', () => {
    it('writes only the selected scalar, preserves raw rows and private settings, and advances a future AI stamp', async () => {
        const env = await open(newPath(), true), raw = rows(env.db), before = (await env.adapter.getData({ rawTasks: true })).settings;
        const { envelope } = await plan(env);
        expect(await env.methods.commit(envelope)).toEqual({ ok: true,
            value: { change: { type: 'copilotModel', value: 'new-copilot' }, changed: true } });
        const after = (await env.adapter.getData({ rawTasks: true })).settings;
        expect(after).toEqual({ ...before, ai: { ...before.ai, copilotModel: 'new-copilot' },
            syncPreferencesUpdatedAt: { ...before.syncPreferencesUpdatedAt, ai: '2090-10-11T00:00:00.001Z' } });
        expect(rows(env.db)).toEqual(raw);
        expect(receipts(env.db)).toHaveLength(1);
        expect(JSON.stringify(envelope)).not.toContain(sentinel);
        expect(JSON.stringify(receipts(env.db))).not.toContain(sentinel);
    });

    it('asks for shared consent without writing, then persists an explicit enabled choice and skips its stored replay', async () => {
        const env = await open(newPath(), true), before = settings(env.db), raw = rows(env.db);
        const options = await env.methods.options({}); if (!options.ok) throw new Error('options');
        const request: AITextConfigurationRequest = { requestId: ID, change: { type: 'enabled', value: true },
            expected: options.value.expected, consent: false };
        const prompt = await env.methods.prepare(request);
        expect(prompt).toMatchObject({ ok: true, value: { kind: 'consent', prompt: { title: expect.any(String), agree: expect.any(String) } } });
        expect(settings(env.db)).toEqual(before); expect(rows(env.db)).toEqual(raw); expect(receipts(env.db)).toEqual([]);
        const agreed = { ...request, requestId: '00000000-0000-4000-8000-000000000591', consent: true };
        const prepared = await env.methods.prepare(agreed);
        if (!prepared.ok || prepared.value.kind !== 'prepared') throw new Error('prepare');
        const envelope = { request: agreed, prepared: prepared.value.prepared };
        expect(await env.methods.commit(envelope)).toEqual({ ok: true, value: { change: agreed.change, changed: true } });
        const next = await env.methods.options({}); if (!next.ok) throw new Error('options');
        expect(await env.methods.prepare({ ...request, requestId: '00000000-0000-4000-8000-000000000592', expected: next.value.expected }))
            .toEqual({ ok: true, value: { kind: 'noop', result: { change: request.change, changed: false } } });
        expect(receipts(env.db)).toHaveLength(1);
        expect((await env.adapter.getData({ rawTasks: true })).settings.ai?.enabled).toBe(true);
    });

    it('accepts already recorded consent as native authority without adding device-local state to the synced settings', async () => {
        const env = await open(newPath(), true), { envelope } = await plan(env, { type: 'enabled', value: true }, ID, false, true);
        expect(await env.methods.commit(envelope)).toMatchObject({ ok: true });
        const saved = (await env.adapter.getData({ rawTasks: true })).settings;
        expect(saved.ai?.enabled).toBe(true);
        expect(Object.keys(saved)).not.toContain('consent');
    });

    it('retries the exact raw snapshot after a failed SQLite COMMIT and writes a single receipt', async () => {
        const env = await open(newPath(), true), beforeRows = rows(env.db), beforeSettings = settings(env.db);
        const { envelope } = await plan(env, { type: 'model', value: 'replacement' });
        env.fault.commits = 10;
        expect(await env.methods.commit(envelope)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
        expect(env.fault.failed).toBeGreaterThan(0); expect(receipts(env.db)).toEqual([]);
        expect(rows(env.db)).toEqual(beforeRows); expect(settings(env.db)).toEqual(beforeSettings);
        env.fault.commits = 0;
        expect(await env.methods.commit(envelope)).toMatchObject({ ok: true, value: { changed: true } });
        expect(rows(env.db)).toEqual(beforeRows); expect(receipts(env.db)).toHaveLength(1);
        expect(JSON.stringify(settings(env.db))).toContain(sentinel);
        expect(await env.methods.commit(envelope)).toMatchObject({ ok: true, value: { changed: true } });
        expect(receipts(env.db)).toHaveLength(1);
    }, 20_000);

    it('returns a proved cold receipt after a later edit and refuses receipt-less equality and UUID reuse', async () => {
        const path = newPath(), env = await open(path, true), a = await plan(env);
        expect(await env.methods.commit(a.envelope)).toMatchObject({ ok: true });
        const b = await plan(env, { type: 'copilotModel', value: 'later' }, '00000000-0000-4000-8000-000000000591');
        expect(await env.methods.commit(b.envelope)).toMatchObject({ ok: true });
        close(env.db);
        const cold = await open(path), before = settings(cold.db);
        expect(await cold.methods.commit(a.envelope)).toEqual({ ok: true, value: { change: a.request.change, changed: true } });
        expect(settings(cold.db)).toEqual(before);
        expect(cold.methods.outcome({ ...a.request, change: { type: 'model', value: 'reuse' } }))
            .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        const request = { ...b.request, requestId: '00000000-0000-4000-8000-000000000592' };
        expect(await cold.methods.commit({ request, prepared: { version: 1, request } }))
            .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        expect(settings(cold.db)).toEqual(before); expect(receipts(cold.db)).toHaveLength(2);
    });

    it('CAS checks the complete witness at the production store mutation boundary', async () => {
        const env = await open(newPath(), true), { request } = await plan(env), before = settings(env.db);
        const state = useTaskStore.getState(), snapshot = await env.adapter.getData({ rawTasks: true });
        snapshot.settings.ai!.model = 'concurrent';
        expect(await state.commitPreparedAITextConfiguration(request, { state, snapshot })).toMatchObject({ success: false });
        snapshot.settings.ai!.model = 'custom-assistant'; snapshot.settings.syncPreferencesUpdatedAt!.ai = AT;
        expect(await state.commitPreparedAITextConfiguration(request, { state, snapshot })).toMatchObject({ success: false });
        snapshot.settings.syncPreferencesUpdatedAt!.ai = future; snapshot.settings.ai!.provider = 'gemini';
        expect(await state.commitPreparedAITextConfiguration(request, { state, snapshot })).toMatchObject({ success: false });
        expect(settings(env.db)).toEqual(before); expect(receipts(env.db)).toEqual([]);
    });

    it('rejects malformed prepared requests, stale owners and replaced unapplied intents without writing', async () => {
        const env = await open(newPath(), true), a = await plan(env), before = settings(env.db);
        for (const invalid of [{ ...a.envelope, extra: sentinel },
            { ...a.envelope, prepared: { ...a.envelope.prepared, version: 2 } },
            { ...a.envelope, request: { ...a.request, consent: true } }])
            expect(await env.methods.commit(invalid)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(await env.methods.commit(a.envelope, () => { throw new Error('retired owner'); })).toMatchObject({ ok: false });
        expect(settings(env.db)).toEqual(before);
        // A new factory represents the explicit native reload after retirement.
        env.methods = env.create();
        const first = await plan(env), second = await plan(env, { type: 'model', value: 'current' }, '00000000-0000-4000-8000-000000000591');
        expect(await env.methods.commit(first.envelope)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        expect(await env.methods.commit(second.envelope)).toMatchObject({ ok: true });
        expect(receipts(env.db)).toHaveLength(1);
    });
});


const providers: AIProviderId[] = ['openai', 'gemini', 'anthropic'];
const requestV2 = async (env: Env, change: AITextConfigurationChangeV2, id = ID, consent = false): Promise<AITextConfigurationRequestV2> => {
    const options = await env.methods.optionsV2({}); if (!options.ok) throw new Error(JSON.stringify(options));
    return { version: 2, requestId: id, change, expected: options.value.expected, consent };
};
async function planV2(env: Env, change: AITextConfigurationChangeV2, id = ID, consent = false, consentRecordedFor: AIProviderId | null = null) {
    const request = await requestV2(env, change, id, consent);
    const result = await env.methods.prepareV2(request, () => {}, consentRecordedFor);
    if (!result.ok || result.value.kind !== 'prepared') throw new Error(JSON.stringify(result));
    return { request, envelope: { request, prepared: result.value.prepared } };
}
const dataFor = (provider: AIProviderId, enabled = false) => {
    const data = seedData(); data.settings.ai = { ...data.settings.ai, provider, enabled, reasoningEffort: 'high', thinkingBudget: 32000 };
    return data;
};

describe('version 2 AI provider setup through production SQLite/store ownership', () => {
    it.each(providers)('atomically switches to %s defaults while preserving raw rows and private/unrelated settings', async target => {
        const env = await open(newPath(), true, dataFor(target === 'openai' ? 'anthropic' : 'openai'));
        const raw = rows(env.db), before = (await env.adapter.getData({ rawTasks: true })).settings;
        const { envelope } = await planV2(env, { type: 'provider', value: target });
        expect(await env.methods.commitV2(envelope)).toEqual({ ok: true, value: { change: envelope.request.change, changed: true } });
        expect((await env.adapter.getData({ rawTasks: true })).settings).toEqual({ ...before,
            ai: { ...before.ai, ...getAIProviderDefaultsPatch(target, false) },
            syncPreferencesUpdatedAt: { ...before.syncPreferencesUpdatedAt, ai: '2090-10-11T00:00:00.001Z' } });
        expect(rows(env.db)).toEqual(raw); expect(receipts(env.db)).toHaveLength(1);
        expect(JSON.stringify(envelope)).not.toContain(sentinel); expect(JSON.stringify(receipts(env.db))).not.toContain(sentinel);
        const options = await env.methods.optionsV2({}); expect(options).toMatchObject({ ok: true, value: { provider: target } });
    });

    it.each(providers)('opens a saved %s configuration without writes and no-ops its current choice without resetting custom models', async provider => {
        const env = await open(newPath(), true, dataFor(provider, true)), before = settings(env.db), raw = rows(env.db);
        const request = await requestV2(env, { type: 'provider', value: provider });
        expect(await env.methods.prepareV2(request)).toEqual({ ok: true, value: { kind: 'noop', result: { change: request.change, changed: false } } });
        expect(settings(env.db)).toEqual(before); expect(rows(env.db)).toEqual(raw); expect(receipts(env.db)).toEqual([]);
        if (provider === 'openai') {
            const v1 = await env.methods.options({}); expect(v1).toMatchObject({ ok: true });
            if (v1.ok) expect(Object.keys(v1.value).sort()).toEqual(['enabled', 'model', 'copilotModel', 'modelOptions', 'copilotModelOptions', 'expected'].sort());
        } else expect(await env.methods.options({})).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    });

    it.each(['gemini', 'anthropic'] as const)('asks for the actual %s switch target, honors only matching recorded consent, and leaves cancellation unwritten', async target => {
        const env = await open(newPath(), true, dataFor('openai', true)), before = settings(env.db);
        const request = await requestV2(env, { type: 'provider', value: target });
        const t = getTranslator('en');
        expect(await env.methods.prepareV2(request, () => {}, 'openai')).toEqual({ ok: true, value: { kind: 'consent', provider: target,
            prompt: getAIConsentPrompt(target, false, { t, tr: createAISettingsTranslator(t) }) } });
        expect(settings(env.db)).toEqual(before); expect(receipts(env.db)).toEqual([]);
        // A dismissed dialog has no authorization and cannot be committed by manufacturing an envelope.
        expect(await env.methods.commitV2({ request, prepared: { version: 2, request } })).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        const agreed = await planV2(env, request.change, '00000000-0000-4000-8000-000000000591', target === 'gemini', target === 'anthropic' ? target : null);
        expect(await env.methods.commitV2(agreed.envelope)).toMatchObject({ ok: true });
        expect((await env.adapter.getData({ rawTasks: true })).settings.ai).toMatchObject({ provider: target, enabled: true });
        expect(receipts(env.db)).toHaveLength(1);
    });

    it.each(providers)('uses selected %s consent for enable, and disable/model changes need no agreement', async provider => {
        const env = await open(newPath(), true, dataFor(provider));
        const request = await requestV2(env, { type: 'enabled', value: true });
        const wrong = provider === 'openai' ? 'gemini' : 'openai';
        expect(await env.methods.prepareV2(request, () => {}, wrong)).toMatchObject({ ok: true, value: { kind: 'consent', provider } });
        const a = await planV2(env, request.change, '00000000-0000-4000-8000-000000000591', false, provider);
        expect(await env.methods.commitV2(a.envelope)).toMatchObject({ ok: true });
        const b = await planV2(env, { type: 'model', value: 'saved-custom' }, '00000000-0000-4000-8000-000000000592');
        expect(await env.methods.commitV2(b.envelope)).toMatchObject({ ok: true });
        const c = await planV2(env, { type: 'enabled', value: false }, '00000000-0000-4000-8000-000000000593');
        expect(await env.methods.commitV2(c.envelope)).toMatchObject({ ok: true });
        const after = (await env.adapter.getData({ rawTasks: true })).settings;
        expect(after.ai).toMatchObject({ provider, enabled: false, model: 'saved-custom' });
        expect(Object.keys(after)).not.toContain('consent');
    });

    it('retries every default as one failed snapshot and recovers its cold receipt without resetting later custom models', async () => {
        const path = newPath(), env = await open(path, true, dataFor('openai')), before = settings(env.db), raw = rows(env.db);
        const a = await planV2(env, { type: 'provider', value: 'gemini' });
        env.fault.commits = 10;
        expect(await env.methods.commitV2(a.envelope)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
        expect(env.fault.failed).toBeGreaterThan(0); expect(settings(env.db)).toEqual(before); expect(rows(env.db)).toEqual(raw);
        expect(receipts(env.db)).toEqual([]);
        env.fault.commits = 0;
        expect(await env.methods.commitV2(a.envelope)).toMatchObject({ ok: true });
        expect(rows(env.db)).toEqual(raw); expect(receipts(env.db)).toHaveLength(1);
        const b = await planV2(env, { type: 'copilotModel', value: 'later-custom' }, '00000000-0000-4000-8000-000000000591');
        expect(await env.methods.commitV2(b.envelope)).toMatchObject({ ok: true }); close(env.db);
        const cold = await open(path), saved = settings(cold.db);
        expect(cold.methods.outcomeV2(a.request)).toEqual({ ok: true, value: { change: a.request.change, changed: true } });
        expect(await cold.methods.commitV2(a.envelope)).toMatchObject({ ok: true }); expect(settings(cold.db)).toEqual(saved);
        const missing = { ...b.request, requestId: '00000000-0000-4000-8000-000000000592' };
        expect(await cold.methods.commitV2({ request: missing, prepared: { version: 2, request: missing } }))
            .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        expect(cold.methods.outcomeV2({ ...a.request, change: { type: 'provider', value: 'anthropic' } }))
            .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(settings(cold.db)).toEqual(saved); expect(receipts(cold.db)).toHaveLength(2);
    }, 20_000);

    it('rechecks provider, model, effort, budget and stamp at the production mutation boundary', async () => {
        const env = await open(newPath(), true, dataFor('openai')), { request } = await planV2(env, { type: 'provider', value: 'gemini' });
        const before = settings(env.db), raw = rows(env.db), state = useTaskStore.getState();
        for (const patch of [{ provider: 'anthropic' }, { model: 'concurrent' }, { copilotModel: 'concurrent' },
            { enabled: true }, { reasoningEffort: 'low' }, { thinkingBudget: 128 }]) {
            const snapshot = await env.adapter.getData({ rawTasks: true });
            snapshot.settings.ai = { ...snapshot.settings.ai, ...patch } as NonNullable<AppData['settings']['ai']>;
            expect(await state.commitPreparedAITextConfiguration(request, { state, snapshot })).toMatchObject({ success: false });
        }
        const snapshot = await env.adapter.getData({ rawTasks: true }); snapshot.settings.syncPreferencesUpdatedAt!.ai = AT;
        expect(await state.commitPreparedAITextConfiguration(request, { state, snapshot })).toMatchObject({ success: false });
        expect(settings(env.db)).toEqual(before); expect(rows(env.db)).toEqual(raw); expect(receipts(env.db)).toEqual([]);
    });

    it('keeps v1/v2 envelopes separate and replays saved v1 receipts after later v2 selection', async () => {
        const path = newPath(), env = await open(path, true), a = await plan(env);
        expect(env.methods.validateV2(a.envelope)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(await env.methods.commit(a.envelope)).toMatchObject({ ok: true });
        const b = await planV2(env, { type: 'provider', value: 'anthropic' }, '00000000-0000-4000-8000-000000000591');
        expect(env.methods.validate(b.envelope)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        for (const invalid of [{ ...b.envelope, extra: sentinel },
            { ...b.envelope, prepared: { ...b.envelope.prepared, version: 1 } },
            { ...b.envelope, request: { ...b.request, expected: nativeAITextConfigurationWitnessV2({}) } }])
            expect(env.methods.validateV2(invalid)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(await env.methods.commitV2(b.envelope)).toMatchObject({ ok: true }); close(env.db);
        const cold = await open(path), before = settings(cold.db);
        expect(cold.methods.outcome(a.request)).toMatchObject({ ok: true });
        expect(await cold.methods.commit(a.envelope)).toMatchObject({ ok: true }); expect(settings(cold.db)).toEqual(before);
        expect(await cold.methods.prepareV2({ ...b.request, requestId: a.request.requestId }))
            .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(receipts(cold.db)).toHaveLength(2);
    });
});


describe('Anthropic thinking through saved SQLite configuration authority', () => {
    const anthropicData = (budget?: number) => {
        const data = dataFor('anthropic');
        if (budget === undefined) delete data.settings.ai!.thinkingBudget;
        else data.settings.ai!.thinkingBudget = budget;
        return data;
    };
    it('opens a coherent closed options read and leaves absent/custom settings, rows and receipts untouched', async () => {
        const env = await open(newPath(), true, anthropicData()), before = settings(env.db), raw = rows(env.db);
        const options = await env.methods.anthropicThinkingOptions({});
        expect(options).toMatchObject({ ok: true, value: { version: 1, enabled: false, value: 0, expected: { budgetPresent: false } } });
        if (!options.ok) throw new Error('options');
        expect(options.value.options.map(choice => choice.value)).toEqual([1024, 2048, 4096]);
        const setup = await env.methods.optionsV2({}); if (!setup.ok) throw new Error('setup');
        expect(options.value.expected).toEqual(setup.value.expected);
        expect(await env.methods.anthropicThinkingOptions({ extra: true })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        const request = await requestV2(env, { type: 'anthropicThinking', value: false });
        expect(await env.methods.prepareV2(request)).toEqual({ ok: true, value: { kind: 'noop', result: { change: request.change, changed: false } } });
        expect(settings(env.db)).toEqual(before); expect(rows(env.db)).toEqual(raw); expect(receipts(env.db)).toEqual([]);
    });

    it('writes on, exact presets and off without consent while preserving private fields/raw rows and future stamps', async () => {
        const env = await open(newPath(), true, anthropicData()), raw = rows(env.db);
        const before = (await env.adapter.getData({ rawTasks: true })).settings;
        const changes: AITextConfigurationChangeV2[] = [{ type: 'anthropicThinking', value: true },
            { type: 'thinkingBudget', value: 2048 }, { type: 'thinkingBudget', value: 4096 }, { type: 'anthropicThinking', value: false }];
        for (const [index, change] of changes.entries()) {
            const { envelope } = await planV2(env, change, `00000000-0000-4000-8000-00000000059${index}`);
            expect(envelope.request.consent).toBe(false);
            expect(await env.methods.commitV2(envelope)).toEqual({ ok: true, value: { change, changed: true } });
            const after = (await env.adapter.getData({ rawTasks: true })).settings;
            expect(after).toEqual({ ...before, ai: { ...before.ai, thinkingBudget: [1024, 2048, 4096, 0][index] },
                syncPreferencesUpdatedAt: { ...before.syncPreferencesUpdatedAt, ai: `2090-10-11T00:00:00.00${index + 1}Z` } });
            expect(rows(env.db)).toEqual(raw);
            expect(JSON.stringify(envelope)).not.toContain(sentinel);
        }
        expect(receipts(env.db)).toHaveLength(4);
        expect(JSON.stringify(receipts(env.db))).not.toContain(sentinel);
        const off = await requestV2(env, { type: 'thinkingBudget', value: 1024 }, '00000000-0000-4000-8000-000000000594');
        expect(await env.methods.prepareV2(off)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    });

    it('preserves a custom positive budget on repeated On without saving or taking consent', async () => {
        const env = await open(newPath(), true, anthropicData(7777)), before = settings(env.db);
        expect(await env.methods.anthropicThinkingOptions({})).toMatchObject({ ok: true, value: { enabled: true, value: 7777 } });
        const request = await requestV2(env, { type: 'anthropicThinking', value: true });
        expect(await env.methods.prepareV2(request)).toEqual({ ok: true, value: { kind: 'noop', result: { change: request.change, changed: false } } });
        expect(settings(env.db)).toEqual(before); expect(receipts(env.db)).toEqual([]);
    });

    it('refuses options and new writes for another provider instead of reporting a no-op', async () => {
        const env = await open(newPath(), true, dataFor('gemini')), before = settings(env.db);
        expect(await env.methods.anthropicThinkingOptions({})).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        for (const change of [{ type: 'anthropicThinking' as const, value: true }, { type: 'thinkingBudget' as const, value: 2048 }]) {
            const request = await requestV2(env, change);
            expect(await env.methods.prepareV2(request)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
            expect(env.methods.validateV2({ request, prepared: { version: 2, request } })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        }
        expect(settings(env.db)).toEqual(before); expect(receipts(env.db)).toEqual([]);
    });

    it('CAS refuses provider, budget and stamp changes at the production store mutation boundary', async () => {
        const env = await open(newPath(), true, anthropicData(1024));
        const { request } = await planV2(env, { type: 'thinkingBudget', value: 2048 }), before = settings(env.db);
        const state = useTaskStore.getState();
        for (const field of ['provider', 'thinkingBudget', 'stamp']) {
            const snapshot = await env.adapter.getData({ rawTasks: true });
            if (field === 'provider') snapshot.settings.ai!.provider = 'openai';
            if (field === 'thinkingBudget') snapshot.settings.ai!.thinkingBudget = 4096;
            if (field === 'stamp') snapshot.settings.syncPreferencesUpdatedAt!.ai = AT;
            expect(await state.commitPreparedAITextConfiguration(request, { state, snapshot })).toMatchObject({ success: false });
        }
        expect(settings(env.db)).toEqual(before); expect(receipts(env.db)).toEqual([]);
    });

    it('drains a failed save with exact retry then cold receipt preserves a later budget', async () => {
        const path = newPath(), env = await open(path, true, anthropicData()), before = settings(env.db), raw = rows(env.db);
        const a = await planV2(env, { type: 'anthropicThinking', value: true });
        env.fault.commits = 10;
        expect(await env.methods.commitV2(a.envelope)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
        expect(settings(env.db)).toEqual(before); expect(rows(env.db)).toEqual(raw); expect(receipts(env.db)).toEqual([]);
        env.fault.commits = 0;
        expect(await env.methods.commitV2(a.envelope)).toMatchObject({ ok: true, value: { changed: true } });
        const b = await planV2(env, { type: 'thinkingBudget', value: 4096 }, '00000000-0000-4000-8000-000000000591');
        expect(await env.methods.commitV2(b.envelope)).toMatchObject({ ok: true });
        close(env.db);
        const cold = await open(path), later = settings(cold.db);
        expect(await cold.methods.commitV2(a.envelope)).toEqual({ ok: true, value: { change: a.request.change, changed: true } });
        expect(settings(cold.db)).toEqual(later); expect(receipts(cold.db)).toHaveLength(2);
        expect((await cold.adapter.getData({ rawTasks: true })).settings.ai!.thinkingBudget).toBe(4096);
    }, 20_000);
});
