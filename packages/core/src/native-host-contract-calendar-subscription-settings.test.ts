import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCalendarSubscriptionSettingsMethods, type CalendarSubscriptionSettingRequest,
    type CalendarSubscriptionSettingEdit, type CalendarSubscriptionSettingEnvelope } from './native-host-contract-calendar-subscription-settings';
import { buildCalendarSubscriptionSettingsModel } from './native-host-contract-settings-calendar';
import { loadNativeRequestReceipts, NativeReceiptSqliteAdapter, resetNativeRequestReceipts } from './native-request-receipts';
import { openScratchSqlite } from './screen-parity.replay';
import { SqliteAdapter, type SqliteClient } from './sqlite-adapter';
import { flushPendingSave, getPersistenceStatus, resetForTests, setStorageAdapter, useTaskStore } from './store';
import type { AppData } from './types';
import type { NativeHostResult } from './native-host-contract';

const ID = '00000000-0000-4000-8000-000000000470';
const OTHER = '00000000-0000-4000-8000-000000000471';
const AT = '2026-10-09T00:00:00.000Z';
const PRIVATE = 'https://person:secret@example.invalid/calendar?token=private';
const feed = { id: 'feed-a', name: 'Private calendar', url: PRIVATE, enabled: true,
    color: '#2563EB', areaIds: ['dangling', 'area-a'], retained: { exact: ['keep'] } };
const changed = { changed: true, toasts: [], open: null, clearDraft: false };
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
    const dir = mkdtempSync(join(tmpdir(), 'mindwtr-calendar-subscription-'));
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
    const create = () => createCalendarSubscriptionSettingsMethods({ readiness: () => ({ ok: true, value: null }),
        save: async () => { try { await flushPendingSave(); return { ok: true, value: null }; }
            catch { return { ok: false, error: { code: 'SAVE_FAILED', message: 'The save failed' } }; } },
        storage: () => bound, model: ({ settings, areas, feeds, revision }) => buildCalendarSubscriptionSettingsModel(feeds, revision,
            { areas, theme: settings.theme, t: (key) => key }) });
    const load = async () => {
        resetForTests(); resetNativeRequestReceipts();
        adapter = new NativeReceiptSqliteAdapter(client); setStorageAdapter(adapter);
        const saved = await adapter.getData({ rawTasks: true });
        useTaskStore.setState({ _allTasks: saved.tasks, _allProjects: saved.projects, _allSections: saved.sections ?? [],
            _allAreas: saved.areas, _allPeople: saved.people ?? [], settings: saved.settings,
            error: null, persistenceFailure: null, isLoading: false, lastDataChangeAt: 0 } as never);
        await loadNativeRequestReceipts(client, { durableCommands: ['calendarSubscriptionSetting'] });
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
type EditPatch<T = CalendarSubscriptionSettingEdit> = T extends CalendarSubscriptionSettingEdit ? Omit<T, 'revision'> : never;
async function plan(env: Env, patch: EditPatch = { type: 'feed', feedId: feed.id, field: 'enabled', value: false }, requestId = ID) {
    const options = value(await env.methods.getCalendarSubscriptionOptions({}));
    const request = { requestId, edit: { ...patch, revision: options.expected.revision }, expected: options.expected } as CalendarSubscriptionSettingRequest;
    const preparation = value(await env.methods.prepareCalendarSubscriptionSetting(request));
    if (preparation.kind !== 'prepared') throw new Error('Expected a changed preparation');
    const envelope: CalendarSubscriptionSettingEnvelope = { request, prepared: preparation.prepared };
    return { options, request, envelope };
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

describe('prepared calendar subscription metadata with real SQLite receipts', () => {
    it('publishes matching controls/witness, saves only canonical metadata and replays the original receipt after later edits', async () => {
        const env = await open(), before = await env.data(), raw = env.raw();
        const { options, request, envelope } = await plan(env);
        expect(options.model.items[0].toggle).toEqual(request.edit);
        expect(options.expected.source).toBe('canonical');
        expect(env.port.read).not.toHaveBeenCalled();
        expect(JSON.stringify(envelope)).not.toContain(PRIVATE);
        expect(JSON.stringify(envelope)).not.toContain(feed.name);
        expect(env.methods.validatePreparedCalendarSubscriptionSetting(envelope)).toEqual({ ok: true, value: changed });
        expect(await env.methods.commitPreparedCalendarSubscriptionSetting(envelope)).toEqual({ ok: true, value: changed });
        const saved = await env.data();
        expect(saved).toEqual({ ...before, settings: { ...before.settings, externalCalendars: [{ ...feed, enabled: false }],
            syncPreferencesUpdatedAt: { ...before.settings.syncPreferencesUpdatedAt, externalCalendars: envelope.prepared.stamp } } });
        expect(env.raw()).toBe(raw); expect(env.port.read).not.toHaveBeenCalled();
        expect(await env.rows()).toHaveLength(1);
        expect(JSON.stringify(await env.rows())).not.toContain('secret');
        const later = { ...saved, settings: { ...saved.settings, externalCalendars: [] } };
        await new SqliteAdapter(env.client).saveData(later); await env.restart();
        env.replaceRaw('malformed later device copy'); env.sql.length = 0;
        expect(await env.methods.probeCalendarSubscriptionSettingOutcome(request)).toEqual({ ok: true, value: changed });
        expect(await env.methods.commitPreparedCalendarSubscriptionSetting(envelope)).toEqual({ ok: true, value: changed });
        expect((await env.data()).settings.externalCalendars).toEqual([]);
        expect(env.sql.some((line) => /^(INSERT|UPDATE|DELETE)/.test(line))).toBe(false);
    });

    it.each([
        { field: 'color', value: '#DB2777', after: { ...feed, color: '#DB2777' } },
        { field: 'color', value: null, after: Object.fromEntries(Object.entries(feed).filter(([name]) => name !== 'color')) },
        { field: 'areaIds', value: [], after: { ...feed, areaIds: [] } },
        { field: 'areaIds', value: ['dangling', 'area-a', 'another'], after: { ...feed, areaIds: ['dangling', 'area-a', 'another'] } },
    ] as const)('preserves the complete canonical document for $field=$value', async ({ field, value: next, after }) => {
        const start = initial(); start.settings.externalCalendars!.push({ ...feed, id: 'second', enabled: false });
        const env = await open(start), before = await env.data(), raw = env.raw();
        const { envelope } = await plan(env, { type: 'feed', feedId: feed.id, field, value: next } as EditPatch);
        expect(await env.methods.commitPreparedCalendarSubscriptionSetting(envelope)).toEqual({ ok: true, value: changed });
        const saved = await env.data();
        expect(saved).toEqual({ ...before, settings: { ...before.settings, externalCalendars: [after, before.settings.externalCalendars![1]],
            syncPreferencesUpdatedAt: { ...before.settings.syncPreferencesUpdatedAt, externalCalendars: envelope.prepared.stamp } } });
        expect(env.raw()).toBe(raw); expect(env.port.read).not.toHaveBeenCalled();
        if (field === 'color' && next === null) expect(Object.hasOwn(saved.settings.externalCalendars![0], 'color')).toBe(false);
    });

    it('removes only the exact UTF8 identity and preserves canonical-equivalent IDs and order', async () => {
        const start = initial(); start.settings.externalCalendars = [{ ...feed, id: 'é' }, { ...feed, id: 'e\u0301' }, { ...feed, id: 'last' }];
        const env = await open(start), before = await env.data();
        const { envelope } = await plan(env, { type: 'removeFeed', feedId: 'é' });
        expect(await env.methods.commitPreparedCalendarSubscriptionSetting(envelope)).toEqual({ ok: true, value: changed });
        const saved = await env.data();
        expect(saved.settings.externalCalendars).toEqual(before.settings.externalCalendars!.slice(1));
        expect(saved.tasks).toEqual(before.tasks); expect(await env.rows()).toHaveLength(1);
    });

    it.each([
        { type: 'feed', feedId: feed.id, field: 'enabled', value: true },
        { type: 'feed', feedId: feed.id, field: 'color', value: feed.color },
        { type: 'feed', feedId: feed.id, field: 'areaIds', value: feed.areaIds },
        { type: 'removeFeed', feedId: 'already-absent' },
    ] as const)('returns RN no-op before a stale content witness for $type/$feedId/$field', async (patch) => {
        const env = await open(), before = await env.data();
        const options = value(await env.methods.getCalendarSubscriptionOptions({}));
        const request = { requestId: ID, edit: { ...patch, revision: options.expected.revision },
            expected: { ...options.expected, fingerprint: '0'.repeat(64) } };
        env.sql.length = 0;
        expect(await env.methods.prepareCalendarSubscriptionSetting(request)).toEqual({ ok: true,
            value: { kind: 'noop', result: { ...changed, changed: false } } });
        expect(await env.methods.probeCalendarSubscriptionSettingOutcome(request)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        expect(await env.rows()).toEqual([]); expect(writes(env)).toEqual([]); expect(await env.data()).toEqual(before);
        expect(env.port.read).not.toHaveBeenCalled();
    });

    it('refuses same-stamp canonical content changes, then accepts fresh work without a stranded receipt', async () => {
        const env = await open(); const { envelope } = await plan(env);
        const before = await env.data(), later = { ...before, settings: { ...before.settings,
            externalCalendars: [{ ...feed, url: 'https://changed.invalid' }] } };
        await new SqliteAdapter(env.client).saveData(later); env.sql.length = 0;
        expect(await env.methods.commitPreparedCalendarSubscriptionSetting(envelope)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        expect(await env.data()).toEqual(later); expect(await env.rows()).toEqual([]); expect(writes(env)).toEqual([]);
        const fresh = await plan(env, undefined, OTHER);
        expect(await env.methods.commitPreparedCalendarSubscriptionSetting(fresh.envelope)).toEqual({ ok: true, value: changed });
        expect((await env.data()).settings.externalCalendars![0].url).toBe('https://changed.invalid');
    });

    it('promotes unchanged legacy bytes after a fresh realm, using decoded defaults and leaving the cell untouched', async () => {
        const raw = JSON.stringify([{ id: 'legacy-a', url: ` ${PRIVATE} `, areaIds: ['dangling'] }, { ...feed, id: 'legacy-b' }]);
        const env = await open(legacyData(), raw), before = await env.data();
        const { envelope } = await plan(env, { type: 'feed', feedId: 'legacy-a', field: 'enabled', value: false });
        expect(envelope.request.expected.source).toBe('legacy');
        expect(JSON.stringify(envelope)).not.toContain(PRIVATE); expect(JSON.stringify(envelope)).not.toContain(feed.name);
        await env.restart(); env.sql.length = 0;
        expect(await env.methods.commitPreparedCalendarSubscriptionSetting(envelope)).toEqual({ ok: true, value: changed });
        const saved = await env.data();
        expect(saved.settings.externalCalendars).toEqual([
            { id: 'legacy-a', name: 'Calendar', url: PRIVATE, enabled: false, areaIds: ['dangling'] },
            { id: 'legacy-b', name: feed.name, url: PRIVATE, enabled: true, color: feed.color, areaIds: feed.areaIds },
        ]);
        expect(saved.tasks).toEqual(before.tasks); expect(env.raw()).toBe(raw);
        expect(await env.rows()).toHaveLength(1);
    });

    it('refuses a changed legacy fixed cell before effects and makes canonical empty authoritative', async () => {
        const raw = JSON.stringify([feed]), env = await open(legacyData(), raw);
        const { envelope } = await plan(env); env.replaceRaw(raw + ' '); env.sql.length = 0;
        expect(await env.methods.commitPreparedCalendarSubscriptionSetting(envelope)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        expect(await env.rows()).toEqual([]); expect(writes(env)).toEqual([]);
        const before = await env.data();
        await new SqliteAdapter(env.client).saveData({ ...before, settings: { ...before.settings, externalCalendars: [] } });
        await env.restart(); env.port.read.mockClear(); env.replaceRaw('not JSON');
        const options = value(await env.methods.getCalendarSubscriptionOptions({}));
        expect(options.model.items).toEqual([]); expect(options.expected.source).toBe('canonical'); expect(env.port.read).not.toHaveBeenCalled();
    });

    it.each([true, false])('fences held legacy admission after owner replacement, including rejection=%s', async (reject) => {
        const env = await open(legacyData(), JSON.stringify([feed]));
        let entered!: () => void, release!: (value: string) => void, refuse!: (error: Error) => void;
        const started = new Promise<void>((resolve) => { entered = resolve; });
        const held = new Promise<string>((resolve, reject) => { release = resolve; refuse = reject; });
        env.port.read.mockImplementationOnce(async () => { entered(); return held; });
        const reading = env.methods.getCalendarSubscriptionOptions({}); await started;
        env.bind({ read: vi.fn(async () => JSON.stringify([{ ...feed, id: 'new-owner' }])) });
        if (reject) refuse(new Error('Private credential should never escape')); else release(JSON.stringify([feed]));
        expect(await reading).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        expect(writes(env)).toEqual([]); expect(value(await env.methods.getCalendarSubscriptionOptions({})).model.items[0].id).toBe('new-owner');
    });

    it('retries only the exact owned failed raw snapshot, without reapplying the metadata edit', async () => {
        const env = await open(), before = await env.data(); const { envelope } = await plan(env);
        env.fault('commit'); vi.useFakeTimers();
        expect(await failedFlush(env.methods.commitPreparedCalendarSubscriptionSetting(envelope))).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
        expect(useTaskStore.getState().persistenceFailure).not.toBeNull(); expect(await env.data()).toEqual(before);
        const failedSettings = useTaskStore.getState().settings;
        env.fault('none'); env.sql.length = 0;
        expect(await env.methods.commitPreparedCalendarSubscriptionSetting(envelope)).toEqual({ ok: true, value: changed });
        expect(useTaskStore.getState().settings).toBe(failedSettings);
        expect((await env.data()).settings.externalCalendars).toEqual([{ ...feed, enabled: false }]);
        expect(await env.rows()).toHaveLength(1); expect(env.sql.filter((line) => line === 'COMMIT')).toHaveLength(1);
        expect((await env.data()).tasks).toEqual(before.tasks);
    });

    it.each(['canonical', 'legacy'] as const)('preserves later durable rows after an uncommitted %s save failure', async (source) => {
        const env = await open(source === 'canonical' ? initial() : legacyData(), JSON.stringify([feed]));
        const { envelope } = await plan(env); env.fault('commit'); vi.useFakeTimers();
        expect(await failedFlush(env.methods.commitPreparedCalendarSubscriptionSetting(envelope))).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
        env.fault('none');
        const durable = await env.data();
        const later = { ...durable, settings: { ...durable.settings, externalCalendars: [], retained: { outside: 'later' } } };
        await new SqliteAdapter(env.client).saveData(later); env.sql.length = 0;
        const failure = useTaskStore.getState().persistenceFailure, generation = getPersistenceStatus().generation;
        for (let retry = 0; retry < 2; retry += 1) expect(await env.methods.commitPreparedCalendarSubscriptionSetting(envelope)).toEqual({ ok: false,
            error: { code: 'SAVE_FAILED', message: 'Calendar subscription save requires fresh runtime recovery' } });
        expect(writes(env)).toEqual([]); expect(await env.data()).toEqual(later); expect(await env.rows()).toEqual([]);
        expect(useTaskStore.getState().persistenceFailure).toBe(failure); expect(getPersistenceStatus().generation).toBe(generation);
        await env.restart(); env.sql.length = 0;
        expect(await env.methods.commitPreparedCalendarSubscriptionSetting(envelope)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        expect(writes(env)).toEqual([]); expect(await env.data()).toEqual(later); expect(await env.rows()).toEqual([]);
    });

    it('blocks repeated warm retry after legacy change without flushing, then admits fresh-runtime stale cleanup and fresh work', async () => {
        const raw = JSON.stringify([feed]), env = await open(legacyData(), raw), before = await env.data();
        const { envelope } = await plan(env); env.fault('commit'); vi.useFakeTimers();
        expect(await failedFlush(env.methods.commitPreparedCalendarSubscriptionSetting(envelope))).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
        const failure = useTaskStore.getState().persistenceFailure, generation = getPersistenceStatus().generation;
        env.fault('none'); env.replaceRaw(raw + ' '); env.sql.length = 0;
        for (let retry = 0; retry < 2; retry += 1) expect(await env.methods.commitPreparedCalendarSubscriptionSetting(envelope)).toEqual({ ok: false,
            error: { code: 'SAVE_FAILED', message: 'Calendar subscription save requires fresh runtime recovery' } });
        expect(writes(env)).toEqual([]); expect(await env.data()).toEqual(before); expect(await env.rows()).toEqual([]);
        expect(useTaskStore.getState().persistenceFailure).toBe(failure); expect(getPersistenceStatus().generation).toBe(generation);
        await env.restart(); env.sql.length = 0;
        expect(await env.methods.commitPreparedCalendarSubscriptionSetting(envelope)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        expect(writes(env)).toEqual([]); expect(await env.rows()).toEqual([]);
        const fresh = await plan(env, undefined, OTHER);
        expect(await env.methods.commitPreparedCalendarSubscriptionSetting(fresh.envelope)).toEqual({ ok: true, value: changed });
        expect(await env.rows()).toHaveLength(1);
    });

    it('proves lost COMMIT reply but refuses dirty warm success; fresh realm replays before later source guards without writes', async () => {
        const env = await open(); const { envelope, request } = await plan(env);
        env.fault('lostCommitReply'); vi.useFakeTimers();
        expect(await failedFlush(env.methods.commitPreparedCalendarSubscriptionSetting(envelope))).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
        expect(await env.rows()).toHaveLength(1); expect((await env.data()).settings.externalCalendars![0].enabled).toBe(false);
        env.fault('none'); const durable = await env.data(), later = { ...durable, settings: { ...durable.settings, externalCalendars: [] } };
        await new SqliteAdapter(env.client).saveData(later); env.sql.length = 0;
        const recovery = { ok: false, error: { code: 'SAVE_FAILED', message: 'Calendar subscription save requires fresh runtime recovery' } };
        expect(await env.methods.probeCalendarSubscriptionSettingOutcome(request)).toEqual(recovery);
        expect(await env.methods.commitPreparedCalendarSubscriptionSetting(envelope)).toEqual(recovery);
        expect(writes(env)).toEqual([]); expect(await env.data()).toEqual(later);
        await env.restart(); env.sql.length = 0; env.replaceRaw('malformed');
        expect(await env.methods.probeCalendarSubscriptionSettingOutcome(request)).toEqual({ ok: true, value: changed });
        expect(await env.methods.commitPreparedCalendarSubscriptionSetting(envelope)).toEqual({ ok: true, value: changed });
        expect(writes(env)).toEqual([]); expect(await env.data()).toEqual(later); expect(await env.rows()).toHaveLength(1);
    });

    it('refuses invalid colors with RN stale precedence and refuses pure extra fields/revision mismatches before effects', async () => {
        const env = await open(), before = await env.data(); const { envelope, request } = await plan(env);
        const options = value(await env.methods.getCalendarSubscriptionOptions({})); env.sql.length = 0;
        const invalid = { ...request, edit: { type: 'feed', feedId: feed.id, field: 'color', value: '#not-a-swatch', revision: options.expected.revision } };
        expect(await env.methods.prepareCalendarSubscriptionSetting(invalid)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(await env.methods.prepareCalendarSubscriptionSetting({ ...invalid, expected: { ...options.expected, fingerprint: '0'.repeat(64) } }))
            .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        for (const bad of [
            { ...envelope, extra: PRIVATE },
            { ...envelope, request: { ...request, edit: { ...request.edit, revision: 'different' } } },
            { ...envelope, prepared: { ...envelope.prepared, stamp: AT } },
            { ...envelope, prepared: { ...envelope.prepared, deviceIdToInitialize: OTHER } },
            { ...envelope, prepared: { ...envelope.prepared, after: [feed] } },
            { ...envelope, request: { ...request, requestId: ID.toUpperCase().replace('470', '47A') } },
        ]) {
            expect(env.methods.validatePreparedCalendarSubscriptionSetting(bad)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
            expect(await env.methods.commitPreparedCalendarSubscriptionSetting(bad)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        }
        expect(writes(env)).toEqual([]); expect(await env.rows()).toEqual([]); expect(await env.data()).toEqual(before);
    });

    it('handles maximum escaped Area intent intact and refuses 501 IDs and 201-unit IDs before effects', async () => {
        const env = await open(), before = await env.data(), ids = Array.from({ length: 500 }, (_, index) => String(index).padStart(3, '0') + '\u0001'.repeat(197));
        const { envelope, request } = await plan(env, { type: 'feed', feedId: feed.id, field: 'areaIds', value: ids });
        expect(Buffer.byteLength(JSON.stringify(envelope))).toBeGreaterThan(1_100_000);
        expect(env.methods.validatePreparedCalendarSubscriptionSetting(envelope)).toEqual({ ok: true, value: changed });
        for (const next of [[...ids, '501'], ['x'.repeat(201)]]) {
            const bad = { ...request, edit: { ...request.edit, value: next } };
            expect(await env.methods.prepareCalendarSubscriptionSetting(bad)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
            expect(env.methods.validatePreparedCalendarSubscriptionSetting({ request: bad, prepared: { ...envelope.prepared, request: bad } }))
                .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        }
        expect(await env.rows()).toEqual([]); expect(writes(env)).toEqual([]); expect(await env.data()).toEqual(before);
        expect(await env.methods.commitPreparedCalendarSubscriptionSetting(envelope)).toEqual({ ok: true, value: changed });
        expect((await env.data()).settings.externalCalendars![0].areaIds).toEqual(ids);
        expect(await env.rows()).toHaveLength(1);
    });

    it('freezes caller mutations and initializes the missing device identity once with a frozen later group stamp', async () => {
        const start = initial(); delete start.settings.deviceId;
        start.settings.syncPreferencesUpdatedAt!.externalCalendars = '2099-01-01T00:00:00.000Z';
        const env = await open(start), ids = ['kept']; const { envelope, request } = await plan(env, { type: 'feed', feedId: feed.id, field: 'areaIds', value: ids });
        ids.push('caller-mutation'); (request.edit as Extract<CalendarSubscriptionSettingEdit, { field: 'areaIds' }>).value.push('outer-mutation');
        const frozen = envelope.prepared.request;
        expect((frozen.edit as Extract<CalendarSubscriptionSettingEdit, { field: 'areaIds' }>).value).toEqual(['kept']);
        const bound = { request: frozen, prepared: envelope.prepared };
        expect(envelope.prepared.deviceIdBefore).toBeNull(); expect(envelope.prepared.deviceIdToInitialize).toMatch(/^[0-9a-f-]{36}$/);
        expect(Date.parse(envelope.prepared.stamp)).toBeGreaterThan(Date.parse('2099-01-01T00:00:00.000Z'));
        expect(await env.methods.commitPreparedCalendarSubscriptionSetting(bound)).toEqual({ ok: true, value: changed });
        const saved = await env.data(); expect(saved.settings.deviceId).toBe(envelope.prepared.deviceIdToInitialize);
        expect(saved.settings.externalCalendars![0].areaIds).toEqual(['kept']);
        await env.restart(); env.sql.length = 0;
        expect(await env.methods.commitPreparedCalendarSubscriptionSetting(bound)).toEqual({ ok: true, value: changed }); expect(writes(env)).toEqual([]);
    });

    it('refuses a UUID reused for another edit and refuses a malformed durable reply without writes', async () => {
        const env = await open(); const { envelope, request } = await plan(env);
        expect(await env.methods.commitPreparedCalendarSubscriptionSetting(envelope)).toEqual({ ok: true, value: changed });
        env.sql.length = 0;
        const conflicting = { ...request, edit: { type: 'removeFeed', feedId: feed.id, revision: request.expected.revision } };
        expect(await env.methods.prepareCalendarSubscriptionSetting(conflicting)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(writes(env)).toEqual([]);
        await env.client.run('UPDATE native_request_receipts SET reply = ? WHERE request_id = ?', [JSON.stringify({ ...changed, extra: PRIVATE }), ID]);
        env.sql.length = 0;
        expect(await env.methods.probeCalendarSubscriptionSettingOutcome(request)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(await env.methods.commitPreparedCalendarSubscriptionSetting(envelope)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(writes(env)).toEqual([]);
    });

    it('refuses a foreign same-reference persistence generation queued during held source admission', async () => {
        const env = await open(legacyData(), JSON.stringify([feed]));
        let entered!: () => void, release!: () => void;
        const started = new Promise<void>((resolve) => { entered = resolve; });
        const held = new Promise<void>((resolve) => { release = resolve; });
        env.port.read.mockImplementationOnce(async () => { entered(); await held; return JSON.stringify([feed]); });
        const before = useTaskStore.getState(), generation = getPersistenceStatus().generation;
        const reading = env.methods.getCalendarSubscriptionOptions({}); await started;
        await useTaskStore.getState().persistSnapshot();
        expect(useTaskStore.getState().settings).toBe(before.settings); expect(useTaskStore.getState()._allTasks).toBe(before._allTasks);
        expect(getPersistenceStatus().generation).toBeGreaterThan(generation); release();
        expect(await reading).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        expect(await env.rows()).toEqual([]);
    });

    it('does not turn a failed saved-data read into a landed receipt or claim a foreign failed snapshot', async () => {
        const env = await open(), before = await env.data(); const { envelope, request } = await plan(env);
        await useTaskStore.getState().persistSnapshot(); env.fault('commit'); vi.useFakeTimers();
        await failedFlush(flushPendingSave().catch(() => null));
        const failure = useTaskStore.getState().persistenceFailure; expect(failure).not.toBeNull();
        env.fault('none'); env.sql.length = 0;
        expect(await env.methods.commitPreparedCalendarSubscriptionSetting(envelope)).toMatchObject({ ok: false, error: { code: 'ACTION_FAILED' } });
        expect(await env.methods.probeCalendarSubscriptionSettingOutcome(request)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        expect(writes(env)).toEqual([]); expect(await env.rows()).toEqual([]); expect(await env.data()).toEqual(before);
        expect(useTaskStore.getState().persistenceFailure).toBe(failure);
        await env.restart(); env.sql.length = 0;
        expect(await env.methods.commitPreparedCalendarSubscriptionSetting(envelope)).toEqual({ ok: true, value: changed });
        expect(await env.rows()).toHaveLength(1);
    });
});
