import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { decodeSystemCalendarSettings, normalizeSystemCalendarSettings } from './external-calendar-feeds';
import { createDeviceCalendarSettingsMethods, type DeviceCalendarSettingRequest,
    type DeviceCalendarSettingStorage } from './native-host-contract-device-calendar-settings';
import type { NativeHostResult } from './native-host-contract';
import { planDeviceCalendarSetting, type NativeCalendarCommandResult } from './native-host-contract-settings-calendar';
import { loadNativeRequestReceipts, NativeReceiptSqliteAdapter, resetNativeRequestReceipts } from './native-request-receipts';
import { openScratchSqlite } from './screen-parity.replay';
import { SqliteAdapter, type SqliteClient } from './sqlite-adapter';
import { flushPendingSave, getPersistenceStatus, resetForTests, setStorageAdapter, useTaskStore } from './store';
import type { AppData } from './types';

const ID = '00000000-0000-4000-8000-000000000463';
const OTHER = '00000000-0000-4000-8000-000000000464';
const AT = '2026-10-09T00:00:00.000Z';
const MAX = 1_048_576;
const canonical = (value: unknown): string => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)) : item);
const ok = <T,>(value: T): NativeHostResult<T> => ({ ok: true, value });
const value = <T,>(result: NativeHostResult<T>): T => {
    if (!result.ok) throw new Error(JSON.stringify(result));
    return result.value;
};
const initial = (): AppData => ({ tasks: [{ id: 'retained', title: 'Unrelated task', status: 'inbox', tags: [], contexts: [], createdAt: AT, updatedAt: AT }],
    projects: [], sections: [], areas: [], people: [], settings: { retained: { malformedSibling: [null, 'keep'] } } as AppData['settings'] });
const request = (raw: string | null = null, requestId = ID): DeviceCalendarSettingRequest => ({ requestId,
    edit: { type: 'deviceCalendars', before: decodeSystemCalendarSettings(raw), value: {
        enabled: true, selectAll: false, selectedCalendarIds: ['é', 'e\u0301', ' opaque /漢+😀 '],
        areaIdsByCalendar: { z: ['area-b', 'area-a'], a: ['area-a'] },
    } } });
const expected: NativeCalendarCommandResult = { changed: true, toasts: [], open: 'device', clearDraft: false };
const fillRequest = (input: DeviceCalendarSettingRequest, bytes: number) => {
    input.edit.value.selectedCalendarIds = [];
    let size = Buffer.byteLength(JSON.stringify(input));
    while (bytes - size >= 503) {
        size += input.edit.value.selectedCalendarIds.length ? 503 : 502;
        input.edit.value.selectedCalendarIds.push('x'.repeat(500));
    }
    if (bytes - size > 0 && bytes - size < 3) {
        input.edit.value.selectedCalendarIds[0] = input.edit.value.selectedCalendarIds[0].slice(3);
        size -= 3;
    }
    if (bytes > size) input.edit.value.selectedCalendarIds.push('x'.repeat(bytes - size - 3));
    return input;
};
type Env = Awaited<ReturnType<typeof open>>;
const environments: Env[] = [];

async function open(raw: string | null = null, marker: string | null = null) {
    await flushPendingSave(); resetForTests(); resetNativeRequestReceipts();
    const dir = mkdtempSync(join(tmpdir(), 'mindwtr-calendar-setting-'));
    const scratch = openScratchSqlite(join(dir, 'calendar.sqlite'));
    const sql: string[] = [];
    let sqlFault: 'insert' | 'commit' | 'after-commit' | null = null;
    const client: SqliteClient = { ...scratch.client, run: async (statement, params) => {
        sql.push(statement);
        if (sqlFault === 'insert' && statement.startsWith('INSERT INTO native_request_receipts')) {
            sqlFault = null; throw new Error('receipt insert unavailable');
        }
        if (sqlFault === 'commit' && statement === 'COMMIT') { sqlFault = null; throw new Error('receipt commit unavailable'); }
        await scratch.client.run(statement, params);
        if (sqlFault === 'after-commit' && statement === 'COMMIT') { sqlFault = null; throw new Error('receipt response lost'); }
    } };
    await new SqliteAdapter(client).saveData(initial());
    const saved = await new SqliteAdapter(client).getData();
    class Adapter extends NativeReceiptSqliteAdapter {
        override saveData = vi.fn(async (_data: AppData): Promise<void> => { throw new Error('Prepared calendar write must never save a snapshot'); });
    }
    let adapter = new Adapter(client);
    setStorageAdapter(adapter);
    useTaskStore.setState({ _allTasks: saved.tasks, _allProjects: saved.projects, _allSections: saved.sections,
        _allAreas: saved.areas, _allPeople: saved.people ?? [], settings: saved.settings,
        error: null, persistenceFailure: null, isLoading: false, lastDataChangeAt: 0 } as never);
    await loadNativeRequestReceipts(client, { durableCommands: ['deviceCalendarSetting'] });
    sql.length = 0;
    let cells: [string | null, string | null] = [raw, marker];
    let fault: 'before-kv' | 'after-kv' | null = null;
    let ready: NativeHostResult<null> = ok(null);
    const state = { applied: 0, afterCAS: null as (() => void) | null };
    const port: DeviceCalendarSettingStorage = {
        read: vi.fn(async () => [...cells] as [string | null, string | null]),
        compareAndSet: vi.fn(async (before, after) => {
            if (fault === 'before-kv') { fault = null; throw new Error('KV before commit'); }
            if (before[0] !== cells[0] || before[1] !== cells[1]) throw new Error('KV stale');
            cells = [...after]; state.applied += 1; state.afterCAS?.();
            if (fault === 'after-kv') { fault = null; throw new Error('KV response lost'); }
        }),
    };
    let bound: DeviceCalendarSettingStorage | null = port;
    const create = () => createDeviceCalendarSettingsMethods({ readiness: () => ready, storage: () => bound });
    let methods = create();
    const env = { client, sql, port, state, saved, create,
        get methods() { return methods; }, get adapter() { return adapter; },
        cells: () => [...cells] as [string | null, string | null], replace: (next: [string | null, string | null]) => { cells = [...next]; },
        fault: (next: typeof fault) => { fault = next; }, sqlFault: (next: typeof sqlFault) => { sqlFault = next; },
        readiness: (next: NativeHostResult<null>) => { ready = next; }, bind: (next: DeviceCalendarSettingStorage | null) => { bound = next; },
        rows: () => client.all<{ request_id: string; reply: string }>('SELECT request_id, reply FROM native_request_receipts'),
        restart: async (commands = ['deviceCalendarSetting']) => {
            resetNativeRequestReceipts(); resetForTests();
            adapter = new Adapter(client); setStorageAdapter(adapter);
            await loadNativeRequestReceipts(client, { durableCommands: commands });
            methods = create(); sql.length = 0;
            return methods;
        },
        close: () => { scratch.close(); rmSync(dir, { recursive: true, force: true }); },
    };
    environments.push(env);
    return env;
}
async function plan(env: Env, input = request(env.cells()[0])) {
    const prepared = value(await env.methods.prepareDeviceCalendarSetting(input));
    if (prepared.kind !== 'prepared') throw new Error('Expected prepared calendar choice');
    return { request: input, prepared: prepared.prepared };
}
afterEach(async () => {
    await flushPendingSave(); resetForTests(); resetNativeRequestReceipts(); vi.restoreAllMocks();
    for (const env of environments.splice(0)) env.close();
});

describe('prepared device-calendar settings over atomic cells and real SQLite receipts', () => {
    it('uses the shared RN plan and raw decoder, preserving opaque strings, array order and original requests', async () => {
        const raw = ' {"enabled":false,"selectAll":false,"selectedCalendarIds":[" legacy "," legacy "],"areaIdsByCalendar":{"z":["b","a","b"],"a":["a"]}}\n';
        const env = await open(raw), input = request(raw);
        input.edit.value.selectedCalendarIds.push('', '  ', 'é');
        input.edit.value.areaIdsByCalendar!.z.push('area-b', '');
        const envelope = await plan(env, input);
        expect(envelope.prepared.request).toEqual(input);
        expect(envelope.prepared.request).not.toBe(input);
        expect(envelope.prepared.storedBefore).toBe(raw);
        expect(envelope.prepared.storedAfter).toBe(canonical(normalizeSystemCalendarSettings(input.edit.value)));
        expect(envelope.prepared.result).toEqual(value(planDeviceCalendarSetting(decodeSystemCalendarSettings(raw), input.edit)).result);
        const result = ok(expected);
        expect(env.methods.validatePreparedDeviceCalendarSetting(envelope)).toEqual(result);
        expect(await env.methods.commitPreparedDeviceCalendarSetting(envelope)).toEqual(result);
        expect(env.state.applied).toBe(1);
        expect(env.cells()).toEqual([envelope.prepared.storedAfter, envelope.prepared.markerAfter]);
        expect(await env.adapter.getData()).toEqual(env.saved);
        expect(env.adapter.saveData).not.toHaveBeenCalled();
        expect(env.sql.filter((line) => /^(INSERT|UPDATE|DELETE)/.test(line))).toEqual([expect.stringMatching(/^INSERT INTO native_request_receipts/)]);
        expect(env.methods.probeDeviceCalendarSettingOutcome(input)).toEqual(result);
        input.edit.value.selectedCalendarIds.push('later caller mutation');
        expect(envelope.prepared.request.edit.value.selectedCalendarIds).not.toContain('later caller mutation');
    });

    it.each([null, '', '\ufeff{"enabled":true}', '{broken', '{"enabled":false}', '42'])('retains RN defaults for raw legacy cell %s', async (raw) => {
        const env = await open(raw), envelope = await plan(env);
        expect(decodeSystemCalendarSettings(raw)).toEqual({ enabled: false, selectAll: true, selectedCalendarIds: [], areaIdsByCalendar: {} });
        expect(envelope.prepared.storedBefore).toBe(raw);
        expect(await env.methods.commitPreparedDeviceCalendarSetting(envelope)).toEqual(ok(expected));
        expect(env.adapter.saveData).not.toHaveBeenCalled();
    });

    it('shares semantic before/value comparison when Area-map object properties are reordered', async () => {
        const before = { enabled: true, selectAll: false, selectedCalendarIds: ['é'], areaIdsByCalendar: { z: ['b', 'a'], a: ['a'] } };
        const raw = JSON.stringify(before), env = await open(raw), input = request(raw);
        input.edit.before.areaIdsByCalendar = { a: ['a'], z: ['b', 'a'] };
        input.edit.value = { ...before, areaIdsByCalendar: { a: ['a'], z: ['b', 'a'] } };
        expect(value(planDeviceCalendarSetting(decodeSystemCalendarSettings(raw), input.edit)).result.changed).toBe(false);
        expect(await env.methods.prepareDeviceCalendarSetting(input)).toEqual(ok({ kind: 'noop', result: { ...expected, changed: false, open: null } }));
        input.edit.value.selectedCalendarIds = ['é', 'new'];
        const envelope = await plan(env, input);
        expect(await env.methods.commitPreparedDeviceCalendarSetting(envelope)).toEqual(ok({ ...expected, open: null }));
    });

    it('answers a normalized target-state noop without making a journal, marker or SQL receipt', async () => {
        const raw = JSON.stringify(request().edit.value), env = await open(raw), input = request(raw);
        input.edit.before = decodeSystemCalendarSettings(null);
        expect(await env.methods.prepareDeviceCalendarSetting(input)).toEqual(ok({ kind: 'noop', result: { ...expected, changed: false, open: null } }));
        expect(env.methods.probeDeviceCalendarSettingOutcome(input)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        expect(env.cells()).toEqual([raw, null]); expect(env.state.applied).toBe(0); expect(await env.rows()).toEqual([]);
    });

    it.each(['before-kv', 'after-kv', 'insert', 'commit', 'after-commit'] as const)('cold retry keeps the original changed/open result across %s', async (cut) => {
        const env = await open(), envelope = await plan(env);
        if (cut === 'before-kv' || cut === 'after-kv') env.fault(cut); else env.sqlFault(cut);
        expect(await env.methods.commitPreparedDeviceCalendarSetting(envelope)).toMatchObject({ ok: false });
        const beforeReplay = env.state.applied;
        const cold = await env.restart();
        const sorted = JSON.parse(canonical(envelope));
        expect(cold.validatePreparedDeviceCalendarSetting(sorted)).toEqual(ok(expected));
        expect(await cold.commitPreparedDeviceCalendarSetting(sorted)).toEqual(ok(expected));
        expect(env.state.applied).toBe(cut === 'before-kv' ? beforeReplay + 1 : beforeReplay);
        expect(env.state.applied).toBe(1);
        expect((await env.rows()).map((row) => [row.request_id, JSON.parse(row.reply)])).toEqual([[ID, expected]]);
        expect(env.adapter.saveData).not.toHaveBeenCalled();
    });

    it('finishes a same-process receipt-save failure without reading or applying KV again', async () => {
        const env = await open(), envelope = await plan(env);
        env.sqlFault('commit');
        expect(await env.methods.commitPreparedDeviceCalendarSetting(envelope)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
        const reads = vi.mocked(env.port.read).mock.calls.length;
        expect(await env.methods.commitPreparedDeviceCalendarSetting(envelope)).toEqual(ok(expected));
        expect(env.port.read).toHaveBeenCalledTimes(reads);
        expect(env.port.compareAndSet).toHaveBeenCalledTimes(1);
        expect(env.adapter.saveData).not.toHaveBeenCalled();
    });

    it('requires the original journal envelope when only the exact marker proves application, even after an ordinary prune', async () => {
        const env = await open(), envelope = await plan(env);
        env.fault('after-kv');
        expect(await env.methods.commitPreparedDeviceCalendarSetting(envelope)).toMatchObject({ ok: false });
        const cold = await env.restart();
        expect(cold.probeDeviceCalendarSettingOutcome(envelope.request)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        expect(await cold.prepareDeviceCalendarSetting(envelope.request)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        const pruned = canonical({ ...request().edit.value, selectedCalendarIds: [] });
        env.replace([pruned, envelope.prepared.markerAfter]);
        expect(await cold.commitPreparedDeviceCalendarSetting(envelope)).toEqual(ok(expected));
        expect(env.cells()).toEqual([pruned, envelope.prepared.markerAfter]);
        expect(env.state.applied).toBe(1);
    });

    it('returns a saved SQL receipt after later settings and marker changes without KV I/O', async () => {
        const env = await open(), envelope = await plan(env);
        expect(await env.methods.commitPreparedDeviceCalendarSetting(envelope)).toEqual(ok(expected));
        const cold = await env.restart();
        env.replace(['later choice', 'later marker']); vi.mocked(env.port.read).mockClear();
        expect(cold.probeDeviceCalendarSettingOutcome(envelope.request)).toEqual(ok(expected));
        expect(await cold.prepareDeviceCalendarSetting(envelope.request)).toEqual(ok({ kind: 'noop', result: expected }));
        expect(await cold.commitPreparedDeviceCalendarSetting(envelope)).toEqual(ok(expected));
        expect(env.port.read).not.toHaveBeenCalled(); expect(env.state.applied).toBe(1);
        const mismatch = { ...envelope.request, edit: { ...envelope.request.edit, value: { ...envelope.request.edit.value, enabled: false } } };
        expect(cold.probeDeviceCalendarSettingOutcome(mismatch)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    });

    it.each(['setting', 'marker', 'aba', 'target-without-marker', 'malformed-marker'])('refuses later %s state without applying an old envelope', async (change) => {
        const env = await open(), envelope = await plan(env);
        const later: [string | null, string | null] = change === 'setting' ? ['new choice', null]
            : change === 'marker' || change === 'aba' ? [envelope.prepared.storedBefore, 'new mutation marker']
                : change === 'target-without-marker' ? [envelope.prepared.storedAfter, null]
                    : [envelope.prepared.storedAfter, '{broken'];
        env.replace(later);
        expect(await env.methods.commitPreparedDeviceCalendarSetting(envelope)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        expect(env.cells()).toEqual(later); expect(env.state.applied).toBe(0); expect(await env.rows()).toEqual([]);
    });

    it('preserves a later completed opposite choice when the exact setting bytes return to the old baseline', async () => {
        const before = canonical(decodeSystemCalendarSettings(null)), env = await open(before), old = await plan(env);
        const later = await plan(env, { ...old.request, requestId: OTHER });
        expect(await env.methods.commitPreparedDeviceCalendarSetting(later)).toEqual(ok(expected));
        const opposite = request(env.cells()[0], '00000000-0000-4000-8000-000000000465');
        opposite.edit.value = decodeSystemCalendarSettings(before);
        const back = await plan(env, opposite);
        expect(await env.methods.commitPreparedDeviceCalendarSetting(back)).toEqual(ok({ ...expected, open: null }));
        expect(env.cells()[0]).toBe(old.prepared.storedBefore);
        const changed = env.cells(), applied = env.state.applied;
        const cold = await env.restart();
        expect(await cold.commitPreparedDeviceCalendarSetting(old)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        expect(env.cells()).toEqual(changed); expect(env.state.applied).toBe(applied);
    });

    it('refuses a same-UUID marker with another original request, while a fresh request may use a different marker baseline', async () => {
        const env = await open(), envelope = await plan(env);
        const different = { ...envelope.request, edit: { ...envelope.request.edit, value: { ...envelope.request.edit.value, selectedCalendarIds: ['different'] } } };
        env.replace([null, canonical({ version: 1, request: different, result: expected })]);
        expect(await env.methods.prepareDeviceCalendarSetting(envelope.request)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(await env.methods.commitPreparedDeviceCalendarSetting(envelope)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(env.state.applied).toBe(0);
        const fresh = await plan(env, { ...envelope.request, requestId: OTHER });
        expect(await env.methods.commitPreparedDeviceCalendarSetting(fresh)).toEqual(ok(expected));
    });

    it('coalesces only the same concurrent request and refuses UUID payload reuse', async () => {
        const env = await open(), envelope = await plan(env);
        const [first, replay] = await Promise.all([env.methods.commitPreparedDeviceCalendarSetting(envelope), env.methods.commitPreparedDeviceCalendarSetting(envelope)]);
        expect(first).toEqual(ok(expected)); expect(replay).toEqual(first); expect(env.state.applied).toBe(1);
        expect(await env.methods.prepareDeviceCalendarSetting({ ...envelope.request, edit: { ...envelope.request.edit, value: { ...envelope.request.edit.value, selectAll: true } } }))
            .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    });

    it('refuses unloaded/scoped-out receipt durability before KV I/O and keeps pure validation available', async () => {
        const env = await open(), envelope = await plan(env);
        for (const scoped of [false, true]) {
            if (scoped) await env.restart(['notificationSetting']); else resetNativeRequestReceipts();
            vi.mocked(env.port.read).mockClear();
            expect(await env.methods.prepareDeviceCalendarSetting(envelope.request)).toMatchObject({ ok: false, error: { code: 'NOT_READY' } });
            expect(await env.methods.commitPreparedDeviceCalendarSetting(envelope)).toMatchObject({ ok: false, error: { code: 'NOT_READY' } });
            expect(env.methods.probeDeviceCalendarSettingOutcome(envelope.request)).toMatchObject({ ok: false, error: { code: 'NOT_READY' } });
            expect(env.methods.validatePreparedDeviceCalendarSetting(envelope)).toEqual(ok(expected));
            expect(env.port.read).not.toHaveBeenCalled(); expect(env.state.applied).toBe(0);
        }
    });

    it('never retries unrelated store failure or saves a receipt through a replaced adapter', async () => {
        const env = await open(), envelope = await plan(env);
        const failure = { message: 'unrelated', timestamp: AT };
        useTaskStore.setState({ persistenceFailure: failure } as never);
        expect(await env.methods.commitPreparedDeviceCalendarSetting(envelope)).toMatchObject({ ok: false, error: { code: 'ACTION_FAILED' } });
        expect(useTaskStore.getState().persistenceFailure).toBe(failure); expect(env.state.applied).toBe(0);
        useTaskStore.setState({ persistenceFailure: null });
        env.state.afterCAS = () => setStorageAdapter(new NativeReceiptSqliteAdapter(env.client));
        expect(await env.methods.commitPreparedDeviceCalendarSetting(envelope)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
        expect(await env.rows()).toEqual([]); expect(env.state.applied).toBe(1);
        env.state.afterCAS = null;
        const cold = await env.restart();
        expect(await cold.commitPreparedDeviceCalendarSetting(envelope)).toEqual(ok(expected)); expect(env.state.applied).toBe(1);
        expect(env.adapter.saveData).not.toHaveBeenCalled();
    });

    it('refuses queued/in-flight unrelated persistence before reading or applying the fixed cells', async () => {
        const env = await open(), envelope = await plan(env);
        let release!: () => void, entered!: () => void;
        const held = new Promise<void>((resolve) => { release = resolve; });
        const started = new Promise<void>((resolve) => { entered = resolve; });
        env.adapter.saveData.mockImplementation(async () => { entered(); await held; });
        await useTaskStore.getState().persistSnapshot();
        const flushing = flushPendingSave(); await started;
        expect(getPersistenceStatus().inFlight).toBe(true);
        vi.mocked(env.port.read).mockClear();
        expect(await env.methods.commitPreparedDeviceCalendarSetting(envelope)).toMatchObject({ ok: false, error: { code: 'ACTION_FAILED' } });
        expect(env.port.read).not.toHaveBeenCalled(); expect(env.state.applied).toBe(0);
        release(); await flushing;
    });

    it('rejects malformed envelopes, JSON shapes and unknown variants without storage/readiness work in Validate', async () => {
        const env = await open(), envelope = await plan(env);
        env.readiness({ ok: false, error: { code: 'NOT_READY', message: 'closed' } });
        vi.mocked(env.port.read).mockClear();
        expect(env.methods.validatePreparedDeviceCalendarSetting(envelope)).toEqual(ok(expected));
        const bad = [null, { ...envelope, extra: true }, { ...envelope, request: { ...envelope.request, requestId: OTHER } },
            ...['version', 'storedBefore', 'markerBefore', 'storedAfter', 'markerAfter', 'result'].map((field) => ({ ...envelope,
                prepared: { ...envelope.prepared, [field]: field === 'version' ? true : field === 'result' ? { ...expected, open: 'push' }
                    : field === 'storedBefore' || field === 'markerBefore' ? 42 : 'forged' } })),
            { ...envelope, prepared: { ...envelope.prepared, extra: true } }];
        for (const input of bad) expect(env.methods.validatePreparedDeviceCalendarSetting(input)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        env.readiness(ok(null));
        const invalid = [null, { ...envelope.request, requestId: 'AAAAAAAA-0000-4000-8000-000000000463' }, { ...envelope.request, extra: true },
            { ...envelope.request, edit: { type: 'push', before: false, enabled: true } },
            ...[{ ...envelope.request.edit.value, extra: true }, { ...envelope.request.edit.value, enabled: 1 },
                { ...envelope.request.edit.value, areaIdsByCalendar: undefined }, { ...envelope.request.edit.value, selectedCalendarIds: ['x'.repeat(501)] },
                { ...envelope.request.edit.value, areaIdsByCalendar: { a: ['x'.repeat(201)] } }, { ...envelope.request.edit.value, selectedCalendarIds: new Array(2) }]
                .map((next) => ({ ...envelope.request, edit: { ...envelope.request.edit, value: next } }))];
        for (const input of invalid) {
            expect(await env.methods.prepareDeviceCalendarSetting(input)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
            expect(env.methods.probeDeviceCalendarSettingOutcome(input)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        }
        expect(env.port.read).not.toHaveBeenCalled(); expect(env.state.applied).toBe(0);
    });

    it('enforces UTF-8 request/cell/marker/envelope bounds without truncation or writes', async () => {
        const env = await open(), envelope = await plan(env);
        const large = request();
        large.edit.value.selectedCalendarIds = Array(2100).fill('😀'.repeat(125));
        expect(JSON.stringify(large).length).toBeLessThan(MAX);
        expect(await env.methods.prepareDeviceCalendarSetting(large)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        env.replace([' '.repeat(MAX), null]);
        const maxCell = await plan(env);
        expect(maxCell.prepared.storedBefore?.length).toBe(MAX);
        env.replace([' '.repeat(MAX + 1), null]);
        expect(await env.methods.prepareDeviceCalendarSetting(request())).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        env.replace([null, ' '.repeat(MAX + 1)]);
        expect(await env.methods.prepareDeviceCalendarSetting(request())).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        const markerSized = fillRequest(request(), MAX);
        expect(Buffer.byteLength(JSON.stringify(markerSized))).toBe(MAX);
        env.replace([null, null]);
        // Full request identity is retained in the marker; it must fit independently.
        const markerBytes = Buffer.byteLength(canonical({ version: 1, request: markerSized, result: expected }));
        expect(markerBytes).toBeGreaterThan(MAX);
        const reads = vi.mocked(env.port.read).mock.calls.length;
        expect(await env.methods.prepareDeviceCalendarSetting(markerSized)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(env.port.read).toHaveBeenCalledTimes(reads + 1);
        const requestTooLarge = fillRequest(request(), MAX + 1);
        expect(Buffer.byteLength(JSON.stringify(requestTooLarge))).toBe(MAX + 1);
        expect(await env.methods.prepareDeviceCalendarSetting(requestTooLarge)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(env.port.read).toHaveBeenCalledTimes(reads + 1);
        env.replace(['😀'.repeat(MAX / 4), null]);
        expect((await plan(env)).prepared.storedBefore).toBe(env.cells()[0]);
        env.replace([`${env.cells()[0]}!`, null]);
        expect(await env.methods.prepareDeviceCalendarSetting(request())).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        const tooEscaped = { ...envelope, prepared: { ...envelope.prepared, storedBefore: '\\'.repeat(MAX), markerBefore: '\\'.repeat(MAX) } };
        expect(Buffer.byteLength(JSON.stringify(tooEscaped))).toBeGreaterThan(4 * MAX);
        expect(env.methods.validatePreparedDeviceCalendarSetting(tooEscaped)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(env.state.applied).toBe(0); expect(await env.rows()).toEqual([]);
    });
});
