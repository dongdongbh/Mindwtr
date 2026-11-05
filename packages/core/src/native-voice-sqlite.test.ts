import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createNativeVoiceMethods, type NativeVoiceCaptureRequest, type NativeVoiceResultRequest } from './native-voice';
import { NativeReceiptSqliteAdapter, loadNativeRequestReceipts, resetNativeRequestReceipts } from './native-request-receipts';
import { flushPendingSave, resetForTests, setStorageAdapter, useTaskStore } from './store';
import { createNativeHostContract } from './native-host-contract';
import { createQuickCaptureOptions } from './quick-capture-model';
import { getTranslator } from './i18n';
import type { SqliteClient } from './sqlite-adapter';
import type { AppData } from './types';
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
        openAIExtraBodyParams: { nested: sentinel }, speechToText: { enabled: true, provider: 'gemini', offlineModelPath: sentinel, baseUrl: sentinel, unknown: sentinel },
        unknown: { nested: sentinel } }, unknown: sentinel,
        syncPreferencesUpdatedAt: { ai: future, language: AT } } as unknown as AppData['settings'] });
const tempRoot = join(process.cwd(), '.orchestrator/tmp/voice-capture');
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
    await loadNativeRequestReceipts(client, { durableCommands: ['voiceSettings', 'voiceCapture', 'voiceResult'] });
    setStorageAdapter(adapter);
    useTaskStore.setState({ _allTasks: [], _allProjects: [], _allSections: [], _allAreas: [], _allPeople: [],
        settings: {}, error: null, persistenceFailure: null, isLoading: false, lastDataChangeAt: 0 } as never);
    await useTaskStore.getState().fetchData({ throwOnError: true }); await flushPendingSave();
    expect(await createNativeHostContract().activate({ writeSafetyReady: true })).toMatchObject({ ok: true });
    await flushPendingSave();
    if (seed) db.prepare('UPDATE tasks SET contexts = ?, tags = ?, focusOrder = ? WHERE id = ?').run('[ "@raw" ]', '[ "keep" ]', 9, 'raw');
    const create = () => createNativeVoiceMethods({ revision: () => "voice-fixture", formatDate: () => () => "fixture date", requestIdPattern: /^[0-9a-f-]{36}$/, readiness: () => ({ ok: true, value: null }),
        t: () => getTranslator('en'), save: async () => {
            try { await flushPendingSave(); if (useTaskStore.getState().persistenceFailure) throw new Error(); return { ok: true, value: null }; }
            catch { return { ok: false, error: { code: 'SAVE_FAILED', message: 'AI text configuration save failed' } }; }
        } });
    return { db, adapter, methods: create(), create, fault };
}

type Env = Awaited<ReturnType<typeof open>>;
const command = <T>(value: { ok: true; value: T } | { ok: false; error: unknown }): T => { if (!value.ok) throw new Error(JSON.stringify(value)); return value.value; };
const captureRequest = (extra: Partial<NativeVoiceCaptureRequest> = {}): NativeVoiceCaptureRequest => ({ version: 1, requestId: ID,
    text: '', options: createQuickCaptureOptions({ projects: [], defaultAreaId: null }), recordedAt: AT, openAfterSave: false, applied: null,
    attachment: { id: 'audio', kind: 'file', title: 'Audio note', uri: 'file:///managed/attachments/audio.m4a', mimeType: 'audio/mp4',
        size: 10, fileHash: 'a'.repeat(64), localStatus: 'available', createdAt: AT, updatedAt: AT }, ...extra });
const preparedCapture = async (env: Env, request = captureRequest()) => {
    const plan = command(await env.methods.prepareCapture(request)); if (plan.kind !== 'prepared') throw new Error('not prepared');
    return { request, prepared: plan.prepared };
};
const preparedResult = async (env: Env, capture: NativeVoiceCaptureRequest, result: NativeVoiceResultRequest['result'], id = '00000000-0000-4000-8000-000000000591') => {
    const request: NativeVoiceResultRequest = { version: 1, requestId: id, capture, result, at: '2026-10-29T12:00:00.000Z' };
    const plan = command(await env.methods.prepareResult(request)); if (plan.kind !== 'prepared') throw new Error(JSON.stringify(plan));
    return { request, prepared: plan.prepared };
};
const rows = (db: Database) => db.prepare('SELECT * FROM tasks ORDER BY id').all();
const settings = (db: Database) => db.prepare('SELECT data FROM settings WHERE id = 1').get();
const receipts = (db: Database) => db.prepare('SELECT * FROM native_request_receipts').all();

describe('native voice real SQLite metadata ownership', () => {
    it('saves one generated task/audio first, then atomically creates a suggested project and applies late shared metadata', async () => {
        const env = await open(newPath(), true), beforeRaw = rows(env.db), beforeSettings = settings(env.db);
        const audio = await preparedCapture(env);
        expect(JSON.stringify(audio)).not.toContain(sentinel);
        const saved = command(await env.methods.commitCapture(audio));
        expect(saved).toMatchObject({ kind: 'saved', taskId: ID, generated: true });
        expect(saved.taskAtSave.attachments).toEqual([audio.request.attachment]);
        expect(saved.titleAtSave).toContain('fixture date');
        expect(rows(env.db).find(row => (row as { id: string }).id === 'raw')).toEqual(beforeRaw[0]);
        const speech = await preparedResult(env, audio.request, { transcript: 'Buy milk tomorrow', title: 'Buy milk', tags: ['errand'], contexts: ['shop'], projectTitle: 'Errands', dueDate: '2026-10-30' });
        expect(command(await env.methods.commitResult(speech))).toEqual({ taskId: ID, outcome: 'applied' });
        const data = await env.adapter.getData({ rawTasks: true }), task = data.tasks.find(row => row.id === ID)!;
        expect(task).toMatchObject({ title: 'Buy milk', tags: ['#errand'], contexts: ['@shop'], dueDate: '2026-10-30' });
        expect(data.projects).toHaveLength(1); expect(task.projectId).toBe(data.projects[0].id);
        expect(receipts(env.db)).toHaveLength(2); expect(JSON.stringify(receipts(env.db))).not.toContain(sentinel);
        expect(JSON.stringify(settings(env.db))).toContain(sentinel); expect(settings(env.db)).not.toEqual(beforeSettings);
        expect(rows(env.db).find(row => (row as { id: string }).id === 'raw')).toEqual(beforeRaw[0]);
    });

    it('preserves applied copilot metadata through frozen cold capture recovery and never discards it as generated', async () => {
        const path = newPath(), env = await open(path, true);
        const request = captureRequest({ applied: { tags: ['#accepted'], context: '@accepted', timeEstimate: '30min' } });
        const audio = await preparedCapture(env, request);
        expect(audio.prepared.capture.version).toBe(2);
        expect(env.methods.validateCapture({ ...audio, request: { ...request, applied: null } })).toMatchObject({ ok: false });
        const { applied: omitted, ...missingApplied } = request;
        expect(await env.methods.prepareCapture(missingApplied)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(omitted).not.toBeNull();
        close(env.db);
        const cold = await open(path);
        expect(command(await cold.methods.recoverCapture(audio))).toEqual({ kind: 'authorized' });
        const saved = command(await cold.methods.commitCapture(audio));
        expect(saved).toMatchObject({ generated: false, taskAtSave: { tags: ['#accepted'], contexts: ['@accepted'], timeEstimate: '30min' } });
        const before = rows(cold.db);
        expect(command(await cold.methods.commitCapture(audio))).toEqual(saved);
        expect(rows(cold.db)).toEqual(before);
        const empty = { version: 1, requestId: '00000000-0000-4000-8000-000000000591', capture: request,
            result: { transcript: '' }, at: AT };
        expect(command(await cold.methods.prepareResult(empty))).toEqual({ kind: 'noop', result: { taskId: ID, outcome: 'empty' } });
        expect((await cold.adapter.getData({ rawTasks: true })).tasks.find(task => task.id === ID))
            .toMatchObject({ tags: ['#accepted'], contexts: ['@accepted'], timeEstimate: '30min' });
        expect(rows(cold.db)).toEqual(before);
    });

    it.each(['gemini', 'openai', 'whisper'] as const)('independently persists %s scalars while retaining text configuration and unknown private speech values', async provider => {
        const data = seedData(); data.settings.ai!.speechToText!.provider = provider;
        const env = await open(newPath(), true, data), raw = rows(env.db), before = (await env.adapter.getData({ rawTasks: true })).settings;
        const options = command(await env.methods.settingsOptions({}));
        const request = { version: 1, requestId: ID, expected: options.expected, change: { type: 'language', value: '  en  ' } };
        const plan = command(await env.methods.prepareSettings(request)); if (plan.kind !== 'prepared') throw new Error('plan');
        expect(command(await env.methods.commitSettings({ request, prepared: plan.prepared }))).toEqual({ changed: true });
        const after = (await env.adapter.getData({ rawTasks: true })).settings;
        expect(after.ai).toEqual({ ...before.ai, speechToText: { ...before.ai?.speechToText, language: 'en' } });
        expect(after.syncPreferencesUpdatedAt?.ai).toBe('2090-10-11T00:00:00.001Z'); expect(rows(env.db)).toEqual(raw);
        expect(JSON.stringify(plan)).not.toContain(sentinel); expect(JSON.stringify(receipts(env.db))).not.toContain(sentinel);
    });

    it.each([
        ['useOpenAI', 'openai', 'gpt-transcribe'], ['useWhisper', 'whisper', 'whisper-tiny'],
    ] as const)('applies %s through the stamped guarded writer and replays the cold receipt without resetting later edits', async (type, provider, model) => {
        const path = newPath(), env = await open(path, true), raw = rows(env.db);
        const before = (await env.adapter.getData({ rawTasks: true })).settings;
        const options = command(await env.methods.settingsOptions({}));
        const request = { version: 1, requestId: ID, expected: options.expected, change: { type } };
        const plan = command(await env.methods.prepareSettings(request)); if (plan.kind !== 'prepared') throw new Error('plan');
        const envelope = { request, prepared: plan.prepared };
        expect(command(await env.methods.commitSettings(envelope))).toEqual({ changed: true });
        const switched = (await env.adapter.getData({ rawTasks: true })).settings;
        const { offlineModelPath: _offline, ...priorSpeech } = before.ai!.speechToText!;
        expect(switched.ai).toEqual({ ...before.ai, speechToText: { ...priorSpeech, provider, model } });
        expect(switched.syncPreferencesUpdatedAt?.ai).toBe('2090-10-11T00:00:00.001Z');
        expect(rows(env.db)).toEqual(raw); expect(JSON.stringify(receipts(env.db))).not.toContain(sentinel);
        expect(JSON.stringify(envelope)).not.toContain(sentinel);
        const selected = command(await env.methods.settingsOptions({}));
        expect(command(await env.methods.prepareSettings({ ...request, requestId: '00000000-0000-4000-8000-000000000592', expected: selected.expected })))
            .toEqual({ kind: 'noop', result: { changed: false } });
        expect(await env.methods.prepareSettings({ ...request, requestId: '00000000-0000-4000-8000-000000000593' }))
            .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        await useTaskStore.getState().updateSettings({ ai: { ...switched.ai, speechToText: { ...switched.ai?.speechToText, language: 'ja' } } });
        await flushPendingSave(); const later = settings(env.db), laterRows = rows(env.db), proof = receipts(env.db); close(env.db);
        const cold = await open(path);
        expect(command(await cold.methods.recoverSettings(envelope))).toEqual({ kind: 'saved', result: { changed: true } });
        expect(command(await cold.methods.commitSettings(envelope))).toEqual({ changed: true });
        expect(settings(cold.db)).toEqual(later); expect(receipts(cold.db)).toEqual(proof); expect(rows(cold.db)).toEqual(laterRows);
    });

    it('refuses explicit noncatalog Whisper models without writing and accepts a catalog model with the same private state retained', async () => {
        const data = seedData(); data.settings.ai!.speechToText = { ...data.settings.ai!.speechToText, provider: 'whisper', model: 'legacy-custom' };
        const env = await open(newPath(), true, data), raw = rows(env.db), before = settings(env.db), proof = receipts(env.db);
        const options = command(await env.methods.settingsOptions({}));
        for (const model of ['legacy-custom', 'whisper-large-v3-turbo', 'file:///private/custom.bin']) {
            expect(await env.methods.prepareSettings({ version: 1, requestId: ID, expected: options.expected, change: { type: 'model', value: model } }))
                .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        }
        expect(settings(env.db)).toEqual(before); expect(receipts(env.db)).toEqual(proof); expect(rows(env.db)).toEqual(raw);
        const request = { version: 1, requestId: ID, expected: options.expected, change: { type: 'model', value: 'whisper-base.en' } };
        const plan = command(await env.methods.prepareSettings(request)); if (plan.kind !== 'prepared') throw new Error('plan');
        expect(command(await env.methods.commitSettings({ request, prepared: plan.prepared }))).toEqual({ changed: true });
        const after = (await env.adapter.getData({ rawTasks: true })).settings;
        expect(after.ai).toEqual({ ...data.settings.ai, speechToText: { ...data.settings.ai!.speechToText, model: 'whisper-base.en' } });
        expect(rows(env.db)).toEqual(raw); expect(JSON.stringify(receipts(env.db))).not.toContain(sentinel);
    });

    it('keeps the exact canonical late title guard and merges latest tags/project selection', async () => {
        const env = await open(newPath(), true), audio = await preparedCapture(env); command(await env.methods.commitCapture(audio));
        await useTaskStore.getState().updateTask(ID, { title: 'User edit', tags: ['#latest'] }); await flushPendingSave();
        const speech = await preparedResult(env, audio.request, { transcript: 'AI title', title: 'AI title', tags: ['errand'] });
        command(await env.methods.commitResult(speech));
        const task = (await env.adapter.getData({ rawTasks: true })).tasks.find(row => row.id === ID)!;
        expect(task.title).toBe('User edit'); expect(task.tags).toEqual(['#latest', '#errand']);
    });

    it('discards only an untouched generated empty note using a durable tombstone and preserves typed/edited notes', async () => {
        const env = await open(newPath(), true), audio = await preparedCapture(env); command(await env.methods.commitCapture(audio));
        const empty = await preparedResult(env, audio.request, { transcript: '' });
        expect(command(await env.methods.commitResult(empty))).toEqual({ taskId: ID, outcome: 'discarded' });
        expect((await env.adapter.getData({ rawTasks: true })).tasks.find(row => row.id === ID)?.deletedAt).toBe(empty.request.at);
        const typed = await preparedCapture(env, captureRequest({ requestId: '00000000-0000-4000-8000-000000000592', text: 'Typed note' }));
        command(await env.methods.commitCapture(typed));
        const result = command(await env.methods.prepareResult({ version: 1, requestId: '00000000-0000-4000-8000-000000000593', capture: typed.request, result: { transcript: '' }, at: empty.request.at }));
        expect(result).toMatchObject({ kind: 'noop', result: { outcome: 'empty' } });
        expect((await env.adapter.getData({ rawTasks: true })).tasks.find(row => row.id === typed.request.requestId)?.deletedAt).toBeUndefined();
    });

    it('returns skipped for a deleted task, and never accepts a late result without its initial proved capture receipt', async () => {
        const env = await open(newPath(), true), audio = await preparedCapture(env); command(await env.methods.commitCapture(audio));
        await useTaskStore.getState().deleteTask(ID); await flushPendingSave();
        const request = { version: 1, requestId: '00000000-0000-4000-8000-000000000591', capture: audio.request, result: { transcript: 'late' }, at: '2026-10-29T12:00:00.000Z' };
        expect(command(await env.methods.prepareResult(request))).toMatchObject({ kind: 'noop', result: { outcome: 'skipped' } });
        expect(await env.methods.prepareResult({ ...request, capture: captureRequest({ requestId: '00000000-0000-4000-8000-000000000592' }) }))
            .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
    });

    it('retries a failed raw audio snapshot exactly and replays the cold receipt after later task edits', async () => {
        const path = newPath(), env = await open(path, true), before = rows(env.db), audio = await preparedCapture(env);
        env.fault.commits = 10;
        expect(await env.methods.commitCapture(audio)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
        expect(rows(env.db)).toEqual(before); expect(receipts(env.db)).toEqual([]); env.fault.commits = 0;
        command(await env.methods.commitCapture(audio)); expect(receipts(env.db)).toHaveLength(1);
        await useTaskStore.getState().updateTask(ID, { title: 'Later' }); await flushPendingSave(); close(env.db);
        const cold = await open(path), saved = rows(cold.db);
        expect(command(cold.methods.captureOutcome(audio.request))).toMatchObject({ titleAtSave: expect.stringContaining('fixture date') });
        const reordered = JSON.parse(JSON.stringify(audio, (_name, value) => value && typeof value === 'object' && !Array.isArray(value)
            ? Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right))) : value));
        command(await cold.methods.commitCapture(reordered)); expect(rows(cold.db)).toEqual(saved);
        expect(await cold.methods.commitCapture({ ...audio, request: { ...audio.request, text: 'UUID reuse' } })).toMatchObject({ ok: false });
    }, 20_000);

    it('cold unapplied journals require explicit recover admission and never infer a receipt from equal rows', async () => {
        const path = newPath(), env = await open(path, true), audio = await preparedCapture(env); close(env.db);
        const cold = await open(path);
        expect(await cold.methods.commitCapture(audio)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        expect(command(await cold.methods.recoverCapture(audio))).toEqual({ kind: 'authorized' }); command(await cold.methods.commitCapture(audio));
        cold.db.prepare('DELETE FROM native_request_receipts').run(); resetNativeRequestReceipts();
        cold.methods = cold.create();
        expect(await cold.methods.recoverCapture(audio)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        expect(await cold.methods.commitCapture(audio)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
    });

    it('rejects forged result effects and stale task state at the production row writer', async () => {
        const env = await open(newPath(), true), audio = await preparedCapture(env); command(await env.methods.commitCapture(audio));
        const speech = await preparedResult(env, audio.request, { transcript: 'Buy milk', title: 'Buy milk' });
        const forged = { ...speech, prepared: { ...speech.prepared, taskAfter: { ...speech.prepared.taskAfter, title: 'Forged' } } };
        expect(env.methods.validateResult(forged)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        await useTaskStore.getState().updateTask(ID, { title: 'Concurrent' }); await flushPendingSave();
        const before = rows(env.db), state = useTaskStore.getState(), snapshot = await env.adapter.getData({ rawTasks: true });
        expect(await state.commitPreparedVoiceRows(speech.prepared, { state, snapshot })).toMatchObject({ success: false });
        expect(rows(env.db)).toEqual(before); expect(await env.methods.commitResult(speech)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
    });

    it('keeps a failed late task/project effect atomic, retries its exact snapshot and returns a cold result receipt after later edits', async () => {
        const path = newPath(), env = await open(path, true), audio = await preparedCapture(env); command(await env.methods.commitCapture(audio));
        const speech = await preparedResult(env, audio.request, { transcript: 'New project', title: 'Parsed', projectTitle: 'Atomic project' });
        const before = rows(env.db); env.fault.commits = 10;
        expect(await env.methods.commitResult(speech)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
        expect(rows(env.db)).toEqual(before); expect(env.db.prepare('SELECT * FROM projects').all()).toEqual([]); expect(receipts(env.db)).toHaveLength(1);
        env.fault.commits = 0; command(await env.methods.commitResult(speech));
        expect(env.db.prepare('SELECT * FROM projects').all()).toHaveLength(1); expect(receipts(env.db)).toHaveLength(2);
        await useTaskStore.getState().updateTask(ID, { title: 'Later result edit' }); await flushPendingSave(); close(env.db);
        const cold = await open(path), saved = rows(cold.db);
        expect(command(await cold.methods.commitResult(speech))).toEqual({ taskId: ID, outcome: 'applied' }); expect(rows(cold.db)).toEqual(saved);
    }, 20_000);

    it('recovers a frozen unapplied late effect without HTTP and refuses equality after its receipt is lost', async () => {
        const path = newPath(), env = await open(path, true), audio = await preparedCapture(env); command(await env.methods.commitCapture(audio));
        const speech = await preparedResult(env, audio.request, { transcript: 'Late', title: 'Late' }); close(env.db);
        const cold = await open(path);
        expect(await cold.methods.commitResult(speech)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        expect(command(await cold.methods.recoverResult(speech))).toEqual({ kind: 'authorized' }); command(await cold.methods.commitResult(speech));
        cold.db.prepare('DELETE FROM native_request_receipts WHERE request_id=?').run(speech.request.requestId);
        resetNativeRequestReceipts();
        const client: SqliteClient = { run: async (sql, params = []) => { cold.db.prepare(sql).run(...params); },
            all: async <T,>(sql: string, params: unknown[] = []) => cold.db.prepare(sql).all(...params) as T[],
            get: async <T,>(sql: string, params: unknown[] = []) => cold.db.prepare(sql).get(...params) as T | undefined,
            exec: async sql => { cold.db.exec(sql); } };
        await loadNativeRequestReceipts(client, { durableCommands: ['voiceSettings', 'voiceCapture', 'voiceResult'] });
        cold.methods = cold.create();
        expect(await cold.methods.recoverResult(speech)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
    });

    it('retention-off capture stores no audio metadata and edited empty notes are retained', async () => {
        const data = seedData(); data.settings.gtd = { saveAudioAttachments: false };
        const env = await open(newPath(), true, data);
        expect(command(await env.methods.runtimeOptions({}))).toMatchObject({ provider: 'gemini', enabled: true, saveAudioAttachments: false });
        const audio = await preparedCapture(env, captureRequest({ attachment: null })); command(await env.methods.commitCapture(audio));
        expect(command(env.methods.captureOutcome(audio.request)).taskAtSave.attachments ?? []).toEqual([]);
        await useTaskStore.getState().updateTask(ID, { title: 'Keep edited note' }); await flushPendingSave();
        const request = { version: 1, requestId: '00000000-0000-4000-8000-000000000591', capture: audio.request, result: { transcript: '' }, at: '2026-10-29T12:00:00.000Z' };
        expect(command(await env.methods.prepareResult(request))).toMatchObject({ kind: 'noop', result: { outcome: 'empty' } });
        expect((await env.adapter.getData({ rawTasks: true })).tasks.find(row => row.id === ID)?.deletedAt).toBeUndefined();
    });

});
