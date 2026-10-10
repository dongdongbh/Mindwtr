import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCalendarSubscriptionAddMethods, type CalendarSubscriptionAddRequest,
    type CalendarSubscriptionAddEnvelope } from './native-host-contract-calendar-subscription-add';
import { calendarSubscriptionSettingSource, CALENDAR_SUBSCRIPTION_SOURCE_BYTES } from './calendar-subscription-settings-witness';
import { addCalendarFeed, addCalendarFile } from './calendar-settings-model';
import { loadNativeRequestReceipts, NativeReceiptSqliteAdapter, resetNativeRequestReceipts } from './native-request-receipts';
import { openScratchSqlite } from './screen-parity.replay';
import { SqliteAdapter, type SqliteClient } from './sqlite-adapter';
import { flushPendingSave, getPersistenceStatus, resetForTests, setStorageAdapter, useTaskStore } from './store';
import type { AppData } from './types';
import type { NativeHostResult } from './native-host-contract';

const ID = '00000000-0000-4000-8000-000000000472';
const OTHER = '00000000-0000-4000-8000-000000000473';
const AT = '2026-10-09T00:00:00.000Z';
const PRIVATE = 'https://person:secret@example.invalid/calendar?token=private';
const feed = { id: 'feed-a', name: 'Private calendar', url: PRIVATE, enabled: true,
    color: '#2563EB', areaIds: ['dangling', 'area-a'], retained: { exact: ['keep'] } };
const changed = { changed: true, toasts: [], open: null, clearDraft: true };
const value = <T,>(reply: NativeHostResult<T>): T => {
    if (!reply.ok) throw new Error(JSON.stringify(reply)); return reply.value;
};
const initial = (): AppData => ({ tasks: [{ id: 'retained-task', title: 'Retained', status: 'done', tags: [], contexts: [],
    focusOrder: 9, deletedAt: AT, rev: 7, createdAt: AT, updatedAt: AT }], projects: [], sections: [], people: [],
    areas: [{ id: 'area-a', name: 'Area A', order: 0, createdAt: AT, updatedAt: AT }],
    settings: { deviceId: 'stored-device', externalCalendars: [feed], syncPreferencesUpdatedAt: { language: AT, externalCalendars: AT },
        retained: { malformedSibling: [null, 'keep'] } } as AppData['settings'] });
type Env = Awaited<ReturnType<typeof open>>;
const environments: Env[] = [];

async function open(data = initial(), raw: string | null = JSON.stringify([{ ...feed, id: 'stale-device' }])) {
    await flushPendingSave(); resetForTests(); resetNativeRequestReceipts();
    const dir = mkdtempSync(join(tmpdir(), 'mindwtr-calendar-subscription-add-'));
    const scratch = openScratchSqlite(join(dir, 'calendar.sqlite'));
    const sql: string[] = [];
    let fault: 'none' | 'commit' | 'lostCommitReply' = 'none', lostReply = false;
    const client: SqliteClient = { ...scratch.client, run: async (statement, args) => {
        sql.push(statement);
        if (fault === 'commit' && statement === 'COMMIT' || fault === 'lostCommitReply' && lostReply && statement === 'BEGIN IMMEDIATE')
            throw new Error('Controlled SQLite boundary failure');
        await scratch.client.run(statement, args);
        if (fault === 'lostCommitReply' && !lostReply && statement === 'COMMIT') {
            lostReply = true; throw new Error('Controlled lost COMMIT reply');
        }
    } };
    await new SqliteAdapter(client).saveData(data);
    let adapter: NativeReceiptSqliteAdapter;
    let storedRaw = raw;
    let bound = { read: vi.fn(async () => storedRaw) };
    const create = () => createCalendarSubscriptionAddMethods({ readiness: () => ({ ok: true, value: null }),
        save: async () => { try { await flushPendingSave(); return { ok: true, value: null }; }
            catch { return { ok: false, error: { code: 'SAVE_FAILED', message: 'The save failed' } }; } },
        storage: () => bound });
    const load = async () => {
        resetForTests(); resetNativeRequestReceipts();
        adapter = new NativeReceiptSqliteAdapter(client); setStorageAdapter(adapter);
        const saved = await adapter.getData({ rawTasks: true });
        useTaskStore.setState({ _allTasks: saved.tasks, _allProjects: saved.projects, _allSections: saved.sections ?? [],
            _allAreas: saved.areas, _allPeople: saved.people ?? [], settings: saved.settings,
            error: null, persistenceFailure: null, isLoading: false, lastDataChangeAt: 0 } as never);
        await loadNativeRequestReceipts(client, { durableCommands: ['calendarSubscriptionAdd'] });
        sql.length = 0;
        return create();
    };
    let methods = await load();
    const env = { get methods() { return methods; }, get adapter() { return adapter; }, client, sql,
        get port() { return bound; }, raw: () => storedRaw, replaceRaw: (next: string | null) => { storedRaw = next; },
        fault: (next: typeof fault) => { fault = next; lostReply = false; },
        bind: (next: typeof bound) => { bound = next; }, create,
        data: () => new SqliteAdapter(client).getData({ rawTasks: true }),
        rows: () => client.all<{ method: string; reply: string }>('SELECT method,reply FROM native_request_receipts'),
        restart: async () => { methods = await load(); return methods; },
        close: () => { scratch.close(); rmSync(dir, { recursive: true, force: true }); } };
    environments.push(env); return env;
}
async function plan(env: Env, fields: Partial<Pick<CalendarSubscriptionAddRequest, 'name' | 'url' | 'defaultName'>> = {}, requestId = ID) {
    const source = calendarSubscriptionSettingSource((await env.data()).settings, env.raw());
    if (!source) throw new Error('Expected admissible source');
    const request: CalendarSubscriptionAddRequest = { requestId, name: '  New calendar  ', url: ' ' + PRIVATE + ' ', defaultName: 'Calendar',
        expected: source.witness, ...fields };
    const preparation = value(await env.methods.prepareCalendarSubscriptionAdd(request));
    if (preparation.kind !== 'prepared') throw new Error('Expected a changed preparation');
    const envelope: CalendarSubscriptionAddEnvelope = { request, prepared: preparation.prepared };
    return { request, envelope };
}
afterEach(async () => {
    await flushPendingSave(); resetForTests(); resetNativeRequestReceipts(); vi.restoreAllMocks(); vi.useRealTimers();
    for (const env of environments.splice(0)) env.close();
});
const writes = (env: Env) => env.sql.filter((line) => /^(INSERT|UPDATE|DELETE)/.test(line));
const legacyData = () => { const data = initial(); delete data.settings.externalCalendars; return data; };
const failedFlush = async (work: Promise<unknown>) => {
    let done = false; const settled = work.finally(() => { done = true; });
    for (let attempt = 0; !done && attempt < 30; attempt += 1) await vi.advanceTimersByTimeAsync(1_000);
    expect(done).toBe(true); return settled;
};

describe('prepared Calendar subscription URL Add with real SQLite receipts', () => {
    it('derives RN trim semantics, appends once, preserves raw saved data and keeps private intent out of receipts', async () => {
        const env = await open(), before = await env.data(), raw = env.raw();
        const { request, envelope } = await plan(env);
        const expected = addCalendarFeed(before.settings.externalCalendars!, { ...request, id: request.requestId });
        expect(JSON.stringify(envelope)).toContain(PRIVATE); // New intent must survive a crash; the old list is not copied.
        expect(JSON.stringify(envelope)).not.toContain(feed.name);
        expect(envelope.prepared).not.toHaveProperty('after');
        expect(env.methods.validatePreparedCalendarSubscriptionAdd(envelope)).toEqual({ ok: true, value: changed });
        expect(await env.methods.commitPreparedCalendarSubscriptionAdd(envelope)).toEqual({ ok: true, value: changed });
        expect(await env.data()).toEqual({ ...before, settings: { ...before.settings, externalCalendars: expected,
            syncPreferencesUpdatedAt: { ...before.settings.syncPreferencesUpdatedAt, externalCalendars: envelope.prepared.stamp } } });
        expect(env.raw()).toBe(raw); expect(env.port.read).not.toHaveBeenCalled();
        expect(await env.rows()).toHaveLength(1);
        expect(JSON.stringify(await env.rows())).not.toMatch(/secret|private|New calendar/);
        env.sql.length = 0;
        expect(await env.methods.commitPreparedCalendarSubscriptionAdd(envelope)).toEqual({ ok: true, value: changed });
        expect(writes(env)).toEqual([]); expect(await env.rows()).toHaveLength(1);
    });

    it.each(['', '   ', '  Explicit name  '])('uses the captured RN default/trim for name %j after a fresh realm', async (name) => {
        const env = await open(), { envelope } = await plan(env, { name, defaultName: '  冻结 Calendar  ' });
        await env.restart(); // No translator dependency can select a new fallback during cold replay.
        expect(await env.methods.commitPreparedCalendarSubscriptionAdd(envelope)).toEqual({ ok: true, value: changed });
        const row = (await env.data()).settings.externalCalendars!.at(-1)!;
        expect(row).toEqual({ id: ID, name: name.trim() || '冻结 Calendar', url: PRIVATE, enabled: true });
    });

    it('permits identical URLs with distinct UUIDs and refuses an existing UUID without a matching receipt', async () => {
        const env = await open();
        const first = await plan(env);
        expect(await env.methods.commitPreparedCalendarSubscriptionAdd(first.envelope)).toEqual({ ok: true, value: changed });
        const second = await plan(env, {}, OTHER);
        expect(await env.methods.commitPreparedCalendarSubscriptionAdd(second.envelope)).toEqual({ ok: true, value: changed });
        expect((await env.data()).settings.externalCalendars!.map((row) => row.id)).toEqual([feed.id, ID, OTHER]);
        expect((await env.data()).settings.externalCalendars!.map((row) => row.url)).toEqual([PRIVATE, PRIVATE, PRIVATE]);
        const later = await env.data();
        await env.client.run('DELETE FROM native_request_receipts');
        await env.restart(); env.sql.length = 0;
        const source = calendarSubscriptionSettingSource(later.settings, env.raw())!;
        expect(await env.methods.prepareCalendarSubscriptionAdd({ ...first.request, expected: source.witness }))
            .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        expect(await env.data()).toEqual(later); expect(await env.rows()).toEqual([]); expect(writes(env)).toEqual([]);
    });

    it('rejects blank, oversized, non-closed and invalid identity inputs before any save or source read', async () => {
        const env = await open(), before = await env.data(), { request } = await plan(env);
        env.sql.length = 0;
        for (const bad of [
            { ...request, url: '' }, { ...request, url: ' \n\t ' }, { ...request, url: 'x'.repeat(4001) },
            { ...request, name: 'x'.repeat(501) }, { ...request, defaultName: ' ' }, { ...request, defaultName: 'x'.repeat(501) },
            { ...request, extra: PRIVATE }, { ...request, expected: { ...request.expected, extra: PRIVATE } },
            { ...request, requestId: 'A0000000-0000-4000-8000-000000000472' },
        ]) {
            const refused = await env.methods.prepareCalendarSubscriptionAdd(bad);
            expect(refused).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
            expect(JSON.stringify(refused)).not.toContain(PRIVATE);
        }
        expect(env.port.read).not.toHaveBeenCalled(); expect(writes(env)).toEqual([]); expect(await env.rows()).toEqual([]);
        expect(await env.data()).toEqual(before);
    });

    it('purely validates the exact prepared request and derives the closed result without consulting any port', async () => {
        const env = await open(), { request, envelope } = await plan(env), before = await env.data();
        const offline = createCalendarSubscriptionAddMethods({ readiness: () => { throw new Error('No runtime'); },
            save: async () => { throw new Error('No writes'); }, storage: () => { throw new Error('No storage'); } });
        expect(offline.validatePreparedCalendarSubscriptionAdd(envelope)).toEqual({ ok: true, value: changed });
        env.sql.length = 0;
        for (const bad of [
            { ...envelope, extra: PRIVATE },
            { ...envelope, prepared: { ...envelope.prepared, after: [feed] } },
            { ...envelope, prepared: { ...envelope.prepared, stamp: AT } },
            { ...envelope, prepared: { ...envelope.prepared, deviceIdToInitialize: OTHER } },
            { ...envelope, request: { ...request, defaultName: 'Different fallback' } },
            { ...envelope, request: { ...request, url: '' }, prepared: { ...envelope.prepared, request: { ...request, url: '' } } },
        ]) {
            expect(offline.validatePreparedCalendarSubscriptionAdd(bad)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
            expect(await env.methods.commitPreparedCalendarSubscriptionAdd(bad)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        }
        expect(writes(env)).toEqual([]); expect(await env.rows()).toEqual([]); expect(await env.data()).toEqual(before);
    });

    it('promotes stable legacy identities on cold replay without changing exact private device bytes', async () => {
        const raw = JSON.stringify([{ id: 'legacy-a', url: ' ' + PRIVATE + ' ', areaIds: ['dangling'] }]);
        const env = await open(legacyData(), raw), before = await env.data(), { envelope } = await plan(env);
        expect(envelope.request.expected.source).toBe('legacy');
        await env.restart();
        expect(await env.methods.commitPreparedCalendarSubscriptionAdd(envelope)).toEqual({ ok: true, value: changed });
        const saved = await env.data();
        expect(saved.settings.externalCalendars).toEqual([
            { id: 'legacy-a', name: 'Calendar', url: PRIVATE, enabled: true, areaIds: ['dangling'] },
            { id: ID, name: 'New calendar', url: PRIVATE, enabled: true },
        ]);
        expect(saved.tasks).toEqual(before.tasks); expect(env.raw()).toBe(raw); expect(await env.rows()).toHaveLength(1);
    });

    it('makes canonical empty authoritative without opening the stale legacy port', async () => {
        const data = initial(); data.settings.externalCalendars = [];
        const env = await open(data, 'not valid JSON'), { envelope } = await plan(env);
        expect(envelope.request.expected.source).toBe('canonical');
        expect(await env.methods.commitPreparedCalendarSubscriptionAdd(envelope)).toEqual({ ok: true, value: changed });
        expect((await env.data()).settings.externalCalendars).toEqual([{ id: ID, name: 'New calendar', url: PRIVATE, enabled: true }]);
        expect(env.port.read).not.toHaveBeenCalled(); expect(env.raw()).toBe('not valid JSON');
    });

    it.each(['canonical', 'legacy'] as const)('refuses changed %s source before effects and admits freshly witnessed work', async (kind) => {
        const env = await open(kind === 'legacy' ? legacyData() : initial(), JSON.stringify([feed]));
        const { envelope } = await plan(env);
        if (kind === 'legacy') env.replaceRaw(env.raw()! + ' ');
        else {
            const before = await env.data();
            await new SqliteAdapter(env.client).saveData({ ...before, settings: { ...before.settings, externalCalendars: [] } });
        }
        const later = await env.data(); env.sql.length = 0;
        expect(await env.methods.commitPreparedCalendarSubscriptionAdd(envelope)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        expect(await env.data()).toEqual(later); expect(await env.rows()).toEqual([]); expect(writes(env)).toEqual([]);
        const fresh = await plan(env, {}, OTHER);
        expect(await env.methods.commitPreparedCalendarSubscriptionAdd(fresh.envelope)).toEqual({ ok: true, value: changed });
    });

    it('replays the receipt before later removal/import guards, never resurrecting the saved row', async () => {
        const env = await open(), { envelope, request } = await plan(env);
        expect(await env.methods.commitPreparedCalendarSubscriptionAdd(envelope)).toEqual({ ok: true, value: changed });
        const durable = await env.data(), later = { ...durable, settings: { ...durable.settings, externalCalendars: [], language: 'zh' as const } };
        await new SqliteAdapter(env.client).saveData(later); await env.restart(); env.replaceRaw('malformed private copy'); env.sql.length = 0;
        expect(await env.methods.probeCalendarSubscriptionAddOutcome(request)).toEqual({ ok: true, value: changed });
        expect(await env.methods.prepareCalendarSubscriptionAdd(request)).toEqual({ ok: true, value: { kind: 'noop', result: changed } });
        expect(await env.methods.commitPreparedCalendarSubscriptionAdd(envelope)).toEqual({ ok: true, value: changed });
        expect(await env.data()).toEqual(later); expect(writes(env)).toEqual([]); expect(await env.rows()).toHaveLength(1);
        expect(await env.methods.probeCalendarSubscriptionAddOutcome({ ...request, defaultName: '日历' }))
            .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    });

    it('keeps maximum escaped UTF16 input intact and refuses an appended list exceeding the source ceiling', async () => {
        const env = await open();
        const name = '😀'.repeat(250), url = 'https://example.invalid/' + '\u0001'.repeat(4000 - 'https://example.invalid/'.length);
        const { envelope } = await plan(env, { name, url, defaultName: '\u0001'.repeat(500) });
        expect(Buffer.byteLength(JSON.stringify(envelope))).toBeGreaterThan(50_000);
        expect(env.methods.validatePreparedCalendarSubscriptionAdd(JSON.parse(JSON.stringify(envelope)))).toEqual({ ok: true, value: changed });
        expect(await env.methods.commitPreparedCalendarSubscriptionAdd(envelope)).toEqual({ ok: true, value: changed });
        expect((await env.data()).settings.externalCalendars!.at(-1)).toEqual({ id: ID, name, url, enabled: true });
        const data = initial();
        data.settings.externalCalendars = [{ ...feed, retained: { blob: 'x'.repeat(CALENDAR_SUBSCRIPTION_SOURCE_BYTES - 2000) } }] as never;
        const crowded = await open(data);
        const expected = calendarSubscriptionSettingSource((await crowded.data()).settings, crowded.raw())!.witness;
        crowded.sql.length = 0;
        expect(await crowded.methods.prepareCalendarSubscriptionAdd({ requestId: OTHER, name, url, defaultName: 'Calendar', expected }))
            .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(writes(crowded)).toEqual([]); expect(await crowded.rows()).toEqual([]);
    });

    it('retries only the failed owned snapshot with the same row and frozen stamp', async () => {
        const env = await open(), before = await env.data(), { envelope } = await plan(env);
        env.fault('commit'); vi.useFakeTimers();
        expect(await failedFlush(env.methods.commitPreparedCalendarSubscriptionAdd(envelope))).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
        expect(await env.data()).toEqual(before); expect(await env.rows()).toEqual([]);
        const failedSettings = useTaskStore.getState().settings;
        env.fault('none'); env.sql.length = 0;
        expect(await env.methods.commitPreparedCalendarSubscriptionAdd(envelope)).toEqual({ ok: true, value: changed });
        expect(useTaskStore.getState().settings).toBe(failedSettings);
        expect((await env.data()).settings.externalCalendars!.filter((row) => row.id === ID)).toHaveLength(1);
        expect((await env.data()).settings.syncPreferencesUpdatedAt!.externalCalendars).toBe(envelope.prepared.stamp);
        expect(await env.rows()).toHaveLength(1); expect(env.sql.filter((line) => line === 'COMMIT')).toHaveLength(1);
    });

    it.each(['canonical', 'legacy'] as const)('does not flush an uncommitted %s snapshot over later durable import', async (kind) => {
        const env = await open(kind === 'legacy' ? legacyData() : initial(), JSON.stringify([feed]));
        const { envelope } = await plan(env); env.fault('commit'); vi.useFakeTimers();
        expect(await failedFlush(env.methods.commitPreparedCalendarSubscriptionAdd(envelope))).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
        env.fault('none');
        const durable = await env.data(), later = { ...durable, settings: { ...durable.settings, externalCalendars: [], retained: { later: true } } };
        await new SqliteAdapter(env.client).saveData(later); env.sql.length = 0;
        const failure = useTaskStore.getState().persistenceFailure, generation = getPersistenceStatus().generation;
        for (let retry = 0; retry < 2; retry += 1) expect(await env.methods.commitPreparedCalendarSubscriptionAdd(envelope)).toEqual({ ok: false,
            error: { code: 'SAVE_FAILED', message: 'Calendar subscription save requires fresh runtime recovery' } });
        expect(writes(env)).toEqual([]); expect(await env.data()).toEqual(later); expect(await env.rows()).toEqual([]);
        expect(useTaskStore.getState().persistenceFailure).toBe(failure); expect(getPersistenceStatus().generation).toBe(generation);
        await env.restart(); env.sql.length = 0;
        expect(await env.methods.commitPreparedCalendarSubscriptionAdd(envelope)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        expect(await env.data()).toEqual(later); expect(writes(env)).toEqual([]);
    });

    it('proves a lost COMMIT reply but requires fresh runtime before returning the original durable receipt', async () => {
        const env = await open(), { envelope, request } = await plan(env);
        env.fault('lostCommitReply'); vi.useFakeTimers();
        expect(await failedFlush(env.methods.commitPreparedCalendarSubscriptionAdd(envelope))).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
        expect(await env.rows()).toHaveLength(1);
        env.fault('none'); const durable = await env.data(), later = { ...durable, settings: { ...durable.settings, externalCalendars: [] } };
        await new SqliteAdapter(env.client).saveData(later); env.sql.length = 0;
        const recovery = { ok: false, error: { code: 'SAVE_FAILED', message: 'Calendar subscription save requires fresh runtime recovery' } };
        expect(await env.methods.probeCalendarSubscriptionAddOutcome(request)).toEqual(recovery);
        expect(await env.methods.commitPreparedCalendarSubscriptionAdd(envelope)).toEqual(recovery);
        expect(await env.data()).toEqual(later); expect(writes(env)).toEqual([]);
        await env.restart(); env.sql.length = 0;
        expect(await env.methods.commitPreparedCalendarSubscriptionAdd(envelope)).toEqual({ ok: true, value: changed });
        expect(await env.data()).toEqual(later); expect(writes(env)).toEqual([]); expect(await env.rows()).toHaveLength(1);
    });

    it.each(['webcal://person:secret@example.invalid/path?token=private', 'http://example.invalid/calendar.ics', 'not a URL'])(
        'stores RN input %j without transport normalization or a fetch', async (url) => {
            const env = await open(), network = vi.spyOn(globalThis, 'fetch'), { envelope } = await plan(env, { url: ' ' + url + ' ' });
            expect(await env.methods.commitPreparedCalendarSubscriptionAdd(envelope)).toEqual({ ok: true, value: changed });
            expect((await env.data()).settings.externalCalendars!.at(-1)!.url).toBe(url);
            expect(network).not.toHaveBeenCalled();
        },
    );

    it.each([false, true])('refuses a held legacy source after actual storage-owner replacement, rejection=%s', async (reject) => {
        const env = await open(legacyData(), JSON.stringify([feed])), { request } = await plan(env);
        let entered!: () => void, release!: (value: string) => void, refuse!: (error: Error) => void;
        const started = new Promise<void>((resolve) => { entered = resolve; });
        const held = new Promise<string>((resolve, reject) => { release = resolve; refuse = reject; });
        env.port.read.mockImplementationOnce(async () => { entered(); return held; });
        const preparing = env.methods.prepareCalendarSubscriptionAdd(request); await started;
        env.bind({ read: vi.fn(async () => JSON.stringify([{ ...feed, id: 'new-source' }])) });
        if (reject) refuse(new Error(PRIVATE)); else release(JSON.stringify([feed]));
        const result = await preparing;
        expect(result).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        expect(JSON.stringify(result)).not.toContain(PRIVATE); expect(writes(env)).toEqual([]); expect(await env.rows()).toEqual([]);
    });

    it('rechecks same-reference persistence generation after held legacy source admission', async () => {
        const env = await open(legacyData(), JSON.stringify([feed])), before = await env.data(), { envelope } = await plan(env);
        let enter!: () => void, release!: (raw: string | null) => void;
        const entered = new Promise<void>((resolve) => { enter = resolve; });
        env.port.read.mockImplementationOnce(() => { enter(); return new Promise((resolve) => { release = resolve; }); });
        const memory = useTaskStore.getState(), generation = getPersistenceStatus().generation;
        const applying = env.methods.commitPreparedCalendarSubscriptionAdd(envelope);
        await entered;
        await useTaskStore.getState().persistSnapshot();
        expect(useTaskStore.getState().settings).toBe(memory.settings);
        expect(useTaskStore.getState()._allTasks).toBe(memory._allTasks);
        expect(getPersistenceStatus().generation).toBeGreaterThan(generation);
        release(env.raw());
        expect(await applying).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        await flushPendingSave();
        expect(await env.data()).toEqual(before); expect(await env.rows()).toEqual([]);
    });

    it('preserves a changed legacy cell during failed warm save, then recovers stale and admits a fresh UUID', async () => {
        const raw = JSON.stringify([feed]), env = await open(legacyData(), raw), { envelope } = await plan(env);
        env.fault('commit'); vi.useFakeTimers();
        expect(await failedFlush(env.methods.commitPreparedCalendarSubscriptionAdd(envelope))).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
        env.fault('none'); env.replaceRaw(raw + ' '); env.sql.length = 0;
        for (let retry = 0; retry < 2; retry += 1) expect(await env.methods.commitPreparedCalendarSubscriptionAdd(envelope)).toEqual({ ok: false,
            error: { code: 'SAVE_FAILED', message: 'Calendar subscription save requires fresh runtime recovery' } });
        expect(writes(env)).toEqual([]); expect(await env.rows()).toEqual([]); expect(env.raw()).toBe(raw + ' ');
        await env.restart(); env.sql.length = 0;
        expect(await env.methods.commitPreparedCalendarSubscriptionAdd(envelope)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        expect(writes(env)).toEqual([]);
        const fresh = await plan(env, {}, OTHER);
        expect(await env.methods.commitPreparedCalendarSubscriptionAdd(fresh.envelope)).toEqual({ ok: true, value: changed });
        expect((await env.data()).settings.externalCalendars!.filter((row) => row.id === OTHER)).toHaveLength(1);
    });

    it('freezes the exact caller request and missing device ID before a fresh-realm commit', async () => {
        const data = initial(); delete data.settings.deviceId;
        data.settings.syncPreferencesUpdatedAt!.externalCalendars = '2099-01-01T00:00:00.000Z';
        const env = await open(data), { request, envelope } = await plan(env, { name: ' ', defaultName: '冻结日历' });
        request.defaultName = 'Caller changed'; request.url = 'https://other.invalid';
        expect(envelope.prepared.request.defaultName).toBe('冻结日历');
        expect(envelope.prepared.deviceIdBefore).toBeNull();
        expect(envelope.prepared.deviceIdToInitialize).toMatch(/^[0-9a-f-]{36}$/);
        expect(Date.parse(envelope.prepared.stamp)).toBeGreaterThan(Date.parse('2099-01-01T00:00:00.000Z'));
        await env.restart();
        const frozen = { request: envelope.prepared.request, prepared: envelope.prepared };
        expect(await env.methods.commitPreparedCalendarSubscriptionAdd(frozen)).toEqual({ ok: true, value: changed });
        expect((await env.data()).settings.deviceId).toBe(envelope.prepared.deviceIdToInitialize);
        expect((await env.data()).settings.externalCalendars!.at(-1)!.name).toBe('冻结日历');
    });

    it('refuses malformed receipts without private error text or a second write', async () => {
        const env = await open(), { request, envelope } = await plan(env);
        expect(await env.methods.commitPreparedCalendarSubscriptionAdd(envelope)).toEqual({ ok: true, value: changed });
        const before = await env.data();
        for (const reply of [{ ...changed, changed: false }, { ...changed, clearDraft: false }, { ...changed, extra: PRIVATE }]) {
            await env.client.run('UPDATE native_request_receipts SET reply = ? WHERE request_id = ?', [JSON.stringify(reply), ID]);
            env.sql.length = 0;
            const result = await env.methods.probeCalendarSubscriptionAddOutcome(request);
            expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
            expect(JSON.stringify(result)).not.toContain(PRIVATE);
            expect(await env.methods.commitPreparedCalendarSubscriptionAdd(envelope)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
            expect(writes(env)).toEqual([]); expect(await env.data()).toEqual(before);
        }
    });

    it('refuses hot cached success when the exact durable receipt disappears without rewriting saved data', async () => {
        const env = await open(), { request, envelope } = await plan(env);
        expect(await env.methods.commitPreparedCalendarSubscriptionAdd(envelope)).toEqual({ ok: true, value: changed });
        const before = await env.data();
        await env.client.run('DELETE FROM native_request_receipts WHERE request_id = ?', [ID]);
        env.sql.length = 0;
        expect(await env.methods.commitPreparedCalendarSubscriptionAdd(envelope)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        expect(await env.methods.prepareCalendarSubscriptionAdd(request)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        expect(await env.create().commitPreparedCalendarSubscriptionAdd(envelope)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        expect(await env.data()).toEqual(before); expect(await env.rows()).toEqual([]); expect(writes(env)).toEqual([]);
    });
});



describe('native picked-calendar request naming', () => {
    const methods = createCalendarSubscriptionAddMethods({
        readiness: () => { throw new Error('Pure file naming must not access storage'); },
        save: async () => { throw new Error('Pure file naming must not write'); },
        storage: () => { throw new Error('Pure file naming must not read device storage'); },
    });
    const expected = calendarSubscriptionSettingSource(initial().settings, null)!.witness;
    const uri = 'file:///private/calendar-files/native.ics';
    it.each([
        { name: '  Typed  ', fileName: 'picked.ics', defaultName: 'Calendar' },
        { name: ' \uFEFF', fileName: '  Work.ICS  ', defaultName: 'Calendar' },
        { name: '', fileName: '.ics', defaultName: '日历' },
        { name: '', fileName: 'PRIVATE café.ics', defaultName: 'Calendar' },
        { name: '', fileName: '', defaultName: 'Calendar' },
    ])('freezes the existing RN file naming: %j', (input) => {
        const request = { requestId: ID, name: input.name, defaultName: input.defaultName, expected };
        const result = value(methods.createCalendarSubscriptionFileAddRequest({ request, uri, fileName: input.fileName }));
        const row = addCalendarFile([], { id: ID, ...input, uri })[0];
        expect(result).toEqual({ ...request, name: row.name, url: uri });
    });
    it('refuses unsupported fields, paths and oversized names before touching storage', () => {
        const request = { requestId: ID, name: '', defaultName: 'Calendar', expected };
        const good = { request, uri, fileName: 'picked.ics' };
        for (const input of [null, { ...good, extra: true }, { ...good, request: { ...request, url: uri } },
            { ...good, uri: 'https://example.invalid/feed' }, { ...good, uri: 'content://provider/file' },
            { ...good, fileName: 'x'.repeat(501) }, { ...good, fileName: null },
            { ...good, request: { ...request, name: 'x'.repeat(501) } }]) {
            expect(methods.createCalendarSubscriptionFileAddRequest(input)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        }
    });
});
