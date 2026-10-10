import { afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { build } from 'esbuild';
import vm from 'node:vm';

const now = Date.parse('2026-10-08T12:00:00.000Z');
const day = 24 * 60 * 60_000;
const requestId = 'abcdefab-cdef-4abc-8abc-abcdefabcdef';
const request = { requestId, requestedAt: now, details: {
    title: 'PRIVATE_TITLE', message: 'PRIVATE_MESSAGE', tag: 'PRIVATE_TAG', play_sound: true,
    data: { taskId: 'PRIVATE_TASK', alarmKey: 'task:PRIVATE_TASK' }, snooze_interval: 10,
    schedule_type: 'repeat', channel: 'mindwtr-reminders', extra: { preserved: ['漢', 1, false, null] },
} };
const raw = JSON.stringify(request);
let source = '';
const databases: Database[] = [];
beforeAll(async () => {
    const built = await build({ stdin: { contents: `
        import './host-entry';
        import { useTaskStore, getStorageAdapter, flushPendingSave } from '../../../packages/core/src/store';
        globalThis.fixture = {
            seed: async () => {
                await getStorageAdapter().saveData({tasks:[{id:'PRIVATE_TASK',title:'PRIVATE_TITLE',status:'next',
                    tags:[],contexts:[],createdAt:new Date(${now}).toISOString(),updatedAt:new Date(${now}).toISOString()}],
                    projects:[],sections:[],areas:[],people:[],settings:{}});
                await useTaskStore.getState().fetchData({throwOnError:true}); await flushPendingSave();
            },
            complete: async () => { await useTaskStore.getState().updateTask('PRIVATE_TASK',{status:'done'}); await flushPendingSave(); },
            reopen: async () => { await useTaskStore.getState().updateTask('PRIVATE_TASK',{status:'next',description:'PRIVATE_LATER_EDIT'}); await flushPendingSave(); },
        };`, resolveDir: import.meta.dir, loader: 'ts' }, bundle: true, write: false,
        format: 'iife', target: 'es2022', logLevel: 'silent' });
    source = built.outputFiles[0].text;
});
afterEach(() => { databases.splice(0).forEach((database) => database.close()); });
type Alarm = { key: string; id: number; fireAtMs: number; repeat: string; replacing: null; details: Record<string, unknown> };
type Reply = { ok: boolean; value?: unknown; error?: string };
type Host = {
    boot(state: string, backup: string): string;
    poll(id: string): string | null;
    reminderSnoozePrepare(raw: string, alarms: string | null, state: string | null, granted: boolean): string;
    reminderSnoozeValidate(raw: string, alarms: string | null, state: string | null, after: string): string;
    reminderSnoozeCommit(raw: string): string;
    reminderSnoozeProbe(raw: string): string;
    reminderSnoozeRetry(raw: string): string;
    reminderSnoozeAcknowledged(): string;
    iosReminderObserve(): string;
    iosReminderObservation(): string;
};
const fixture = () => {
    const database = new Database(':memory:'); databases.push(database);
    const writes: string[] = [], kvWrites: unknown[] = [], effects: unknown[] = [];
    let log = '', failLog = false, clock = now;
    const launch = () => {
        const state = { AbortController, URL, TextEncoder, TextDecoder, setTimeout, clearTimeout,
            Date: new Proxy(Date, { construct: (target, args) => Reflect.construct(target, args.length ? args : [clock]),
                get: (target, property) => property === 'now' ? () => clock : Reflect.get(target, property) }),
            __mindwtrHostPlatform: 'ios', console: { log() {}, info() {}, warn() {}, error() {} },
            MindwtrHost: undefined as unknown as Host,
            fixture: undefined as unknown as { seed(): Promise<void>; complete(): Promise<void>; reopen(): Promise<void> },
            __mindwtrNative: {
                sqlExec: (sql: string) => { writes.push(sql); database.exec(sql); return null; },
                sqlRun: (sql: string, params: string) => { writes.push(sql); database.query(sql).run(...JSON.parse(params)); return null; },
                sqlAll: (sql: string, params: string) => JSON.stringify(database.query(sql).all(...JSON.parse(params))),
                nowMs: () => clock, randomBytes: (n: number) => JSON.stringify(Array(n).fill(7)), log: () => {}, rnStateCommit: () => null,
                kvGet: () => '[null]', kvMultiGet: () => '[]',
                kvSet: (...args: unknown[]) => { kvWrites.push(args); return null; }, kvRemove: (...args: unknown[]) => { kvWrites.push(args); return null; },
                fileList: () => 'null', fileRead: () => '', fileDelete: () => null,
                alarmSet: (...args: unknown[]) => { effects.push(args); return null; },
                logFile: (operation: string, text: string) => {
                    if (failLog) throw new Error('PRIVATE_LOG_ERROR');
                    if (['path', 'ensure'].includes(operation)) return 'files/logs/mindwtr.log';
                    if (operation === 'size') return String(log.length); if (operation === 'read') return log;
                    if (operation === 'exists') return log ? '1' : ''; if (operation === 'isAbsent') return log ? '' : '1';
                    if (operation === 'append') { log += text; return ''; } if (operation === 'write') { log = text; return ''; }
                    if (operation === 'delete') { log = ''; return '1'; } throw new Error('Unexpected diagnostic operation');
                },
            } };
        vm.runInNewContext(source, state);
        const poll = async (id: string): Promise<Reply> => {
            for (let step = 0; step < 100; step++) {
                const value = state.MindwtrHost.poll(id);
                if (value !== null) return JSON.parse(value);
                await new Promise((done) => setTimeout(done, 0));
            }
            throw new Error('Reminder Snooze bridge did not settle');
        };
        const boot = async () => {
            expect(await poll(state.MindwtrHost.boot('', ''))).toMatchObject({ ok: true });
            writes.length = 0; kvWrites.length = 0; log = '';
        };
        const prepare = async (json = raw, alarms: string | null = null, before: string | null = null, granted = true) => {
            const result = await poll(state.MindwtrHost.reminderSnoozePrepare(json, alarms, before, granted));
            expect(result.ok).toBe(true); return (result.value as { stateAhead: string }).stateAhead;
        };
        const validate = (after: string, json = raw, alarms: string | null = null, before: string | null = null) =>
            poll(state.MindwtrHost.reminderSnoozeValidate(json, alarms, before, after));
        return { state, poll, boot, prepare, validate };
    };
    return { database, writes, kvWrites, effects, launch, log: () => log, failLog: () => { failLog = true; },
        advance: (milliseconds: number) => { clock += milliseconds; } };
};
const snoozeEntry = (alarm: Alarm, armed = false) => ({ kind: 'snooze', id: alarm.id, fireAtMs: alarm.fireAtMs, details: alarm.details, armed });

describe('actual iOS Snooze pure publication bridge and SQLite receipts', () => {
    it('prepares only unarmed state, preserves disjoint entries, and performs no write, effect or diagnostic', async () => {
        const f = fixture(), active = f.launch(); await active.boot(); await active.state.fixture.seed(); f.writes.length = 0;
        const other = { requestId: '01234567-89ab-4cde-8fab-0123456789ab', requestedAt: now, details: request.details };
        const held = await active.prepare(JSON.stringify(other));
        const after = await active.prepare(raw, '{}', held);
        const validated = await active.validate(after, raw, '{}', held);
        expect(validated.ok).toBe(true); const alarm = validated.value as Alarm;
        expect(alarm).toMatchObject({ key: `snooze:${requestId}`, fireAtMs: now + 600_000, repeat: 'once', replacing: null });
        expect(alarm.details).toEqual({ ...request.details, schedule_type: 'once' });
        expect(JSON.parse(after)).toEqual({ ...JSON.parse(held), [alarm.key]: snoozeEntry(alarm) });
        expect(f.writes).toEqual([]); expect(f.kvWrites).toEqual([]); expect(f.effects).toEqual([]);
        expect(f.log()).not.toContain('ios-reminder-snooze');
        expect(f.database.query('SELECT request_id FROM native_request_receipts').all()).toEqual([]);
    });

    it('persists the actual iOS Snooze receipt across cold boot and preserves later owner edits', async () => {
        const f = fixture(), first = f.launch(); await first.boot(); await first.state.fixture.seed();
        const after = await first.prepare(), original = await first.poll(first.state.MindwtrHost.reminderSnoozeCommit(raw));
        expect(original).toEqual(await first.validate(after));
        expect(f.database.query('SELECT request_id FROM native_request_receipts').all()).toEqual([{ request_id: requestId }]);
        await first.state.fixture.complete(); await first.state.fixture.reopen();
        const before = f.database.query('SELECT * FROM tasks ORDER BY id').all();
        const cold = f.launch(); await cold.boot();
        for (const method of ['reminderSnoozeProbe', 'reminderSnoozeRetry', 'reminderSnoozeCommit'] as const) {
            expect(await cold.poll(cold.state.MindwtrHost[method](raw))).toEqual(original);
        }
        expect(f.writes).toEqual([]); expect(f.kvWrites).toEqual([]); expect(f.effects).toEqual([]);
        expect(f.database.query('SELECT * FROM tasks ORDER BY id').all()).toEqual(before);
        expect(f.log()).not.toContain('ios-reminder-snooze');
    });

    it('validates frozen plans after owner/permission/time changes and exact existing armed or unarmed state without rewriting', async () => {
        const f = fixture(), active = f.launch(); await active.boot(); await active.state.fixture.seed();
        const after = await active.prepare(), alarm = (await active.validate(after)).value as Alarm;
        await active.state.fixture.complete(); f.advance(3 * day); f.writes.length = 0;
        expect(await active.validate(after)).toEqual({ ok: true, value: alarm });
        for (const armed of [false, true]) {
            const existing = JSON.stringify({ [alarm.key]: snoozeEntry(alarm, armed) });
            expect(await active.validate(existing, raw, null, existing)).toEqual({ ok: true, value: alarm });
            expect(await active.poll(active.state.MindwtrHost.reminderSnoozePrepare(raw, null, existing, true))).toMatchObject({ ok: false });
        }
        expect(f.writes).toEqual([]); expect(f.kvWrites).toEqual([]); expect(f.effects).toEqual([]);
        expect(await active.poll(active.state.MindwtrHost.reminderSnoozePrepare(raw, null, null, true))).toMatchObject({ ok: false });
    });

    it('fresh planning refuses denial, missing/done owner and more-than24h late, while accepting exact24h', async () => {
        const f = fixture(), active = f.launch(); await active.boot();
        expect(await active.poll(active.state.MindwtrHost.reminderSnoozePrepare(raw, null, null, true))).toMatchObject({ ok: false });
        await active.state.fixture.seed(); f.writes.length = 0;
        expect(await active.poll(active.state.MindwtrHost.reminderSnoozePrepare(raw, null, null, false))).toMatchObject({ ok: false });
        const boundary = JSON.stringify({ ...request, requestedAt: now - day - 600_000 });
        expect(await active.poll(active.state.MindwtrHost.reminderSnoozePrepare(boundary, null, null, true))).toMatchObject({ ok: true });
        const expired = JSON.stringify({ ...request, requestedAt: now - day - 600_000 - 1000 });
        expect(await active.poll(active.state.MindwtrHost.reminderSnoozePrepare(expired, null, null, true))).toMatchObject({ ok: false });
        await active.state.fixture.complete(); f.writes.length = 0;
        expect(await active.poll(active.state.MindwtrHost.reminderSnoozePrepare(raw, null, null, true))).toMatchObject({ ok: false });
        expect(f.writes).toEqual([]); expect(f.kvWrites).toEqual([]); expect(f.effects).toEqual([]);
        expect(f.database.query('SELECT request_id FROM native_request_receipts').all()).toEqual([]);
    });

    it('rejects malformed maps, ID collisions, orphan targets, and disjoint edits or armed publication deltas', async () => {
        const f = fixture(), active = f.launch(); await active.boot(); await active.state.fixture.seed();
        const after = await active.prepare(), alarm = (await active.validate(after)).value as Alarm;
        const entry = snoozeEntry(alarm), otherKey = 'snooze:01234567-89ab-4cde-8fab-0123456789ab';
        for (const bad of ['PRIVATE_BAD_JSON', '[]', '{"bad":{}}', JSON.stringify({ [otherKey]: { ...entry, armed: 'true' } }),
            JSON.stringify({ [otherKey]: entry })]) {
            expect(await active.poll(active.state.MindwtrHost.reminderSnoozePrepare(raw, null, bad, true))).toMatchObject({ ok: false });
        }
        expect(await active.poll(active.state.MindwtrHost.reminderSnoozePrepare(raw, after, null, true))).toMatchObject({ ok: false });
        expect(await active.poll(active.state.MindwtrHost.reminderSnoozePrepare(raw, null, after, true))).toMatchObject({ ok: false });
        for (const changed of [{ [alarm.key]: { ...entry, armed: true } }, { [alarm.key]: { ...entry, id: alarm.id + 1 } },
            { [alarm.key]: { ...entry, fireAtMs: alarm.fireAtMs + 1 } }, { [alarm.key]: { ...entry, details: { ...entry.details, title: 'Changed' } } },
            { [alarm.key]: entry, [otherKey]: { ...entry, id: alarm.id + 1 } }]) {
            expect(await active.validate(JSON.stringify(changed))).toMatchObject({ ok: false });
        }
        const held = JSON.stringify({ [otherKey]: { ...entry, id: alarm.id + 1 } });
        expect(await active.validate(after, raw, null, held)).toMatchObject({ ok: false });
        const armed = JSON.stringify({ [alarm.key]: { ...entry, armed: true } });
        expect(await active.validate(after, raw, null, armed)).toMatchObject({ ok: false });
        expect(await active.validate('{}')).toMatchObject({ ok: false });
    });

    it('bounds raw requests and each map by UTF8 bytes, including exact limits', async () => {
        const f = fixture(), active = f.launch(); await active.boot(); await active.state.fixture.seed(); f.writes.length = 0;
        const json = JSON.stringify({ ...request, details: { ...request.details, title: '😀'.repeat(5000) } });
        const bounded = json + ' '.repeat(65_536 - new TextEncoder().encode(json).byteLength);
        expect(await active.poll(active.state.MindwtrHost.reminderSnoozeProbe(bounded)))
            .toMatchObject({ ok: false, error: expect.stringContaining('STALE_REVISION:') });
        for (const method of ['reminderSnoozeCommit', 'reminderSnoozeProbe', 'reminderSnoozeRetry'] as const) {
            expect(await active.poll(active.state.MindwtrHost[method](bounded + ' ')))
                .toMatchObject({ ok: false, error: expect.stringContaining('INVALID_INPUT:') });
        }
        expect(await active.poll(active.state.MindwtrHost.reminderSnoozePrepare(bounded + ' ', null, null, true))).toMatchObject({ ok: false });
        const emptyAtLimit = '{}' + ' '.repeat(1_048_574);
        expect(await active.poll(active.state.MindwtrHost.reminderSnoozePrepare(raw, emptyAtLimit, emptyAtLimit, true))).toMatchObject({ ok: true });
        for (const [alarms, state] of [[emptyAtLimit + ' ', null], [null, emptyAtLimit + ' '],
            [null, JSON.stringify({ invalid: '漢'.repeat(350_000) })]]) {
            expect(await active.poll(active.state.MindwtrHost.reminderSnoozePrepare(raw, alarms, state, true))).toMatchObject({ ok: false });
        }
        expect(f.writes).toEqual([]); expect(f.kvWrites).toEqual([]);
    });

    it('unknown probe/retry and malformed requests neither mutate nor save', async () => {
        const f = fixture(), active = f.launch(); await active.boot(); await active.state.fixture.seed(); f.writes.length = 0;
        for (const method of ['reminderSnoozeProbe', 'reminderSnoozeRetry'] as const) {
            expect(await active.poll(active.state.MindwtrHost[method](raw)))
                .toMatchObject({ ok: false, error: expect.stringContaining('STALE_REVISION:') });
        }
        for (const bad of ['PRIVATE_BAD_JSON', '[]', 'null', '{}', JSON.stringify({ ...request, extra: true }),
            JSON.stringify({ ...request, requestId: requestId.toUpperCase() }),
            JSON.stringify({ ...request, requestedAt: now + 0.5 }),
            JSON.stringify({ ...request, details: { ...request.details, play_sound: 1 } })]) {
            for (const method of ['reminderSnoozeCommit', 'reminderSnoozeProbe', 'reminderSnoozeRetry'] as const) {
                expect(await active.poll(active.state.MindwtrHost[method](bad)))
                    .toMatchObject({ ok: false, error: expect.stringContaining('INVALID_INPUT:') });
            }
        }
        expect(f.writes).toEqual([]); expect(f.database.query('SELECT request_id FROM native_request_receipts').all()).toEqual([]);
        expect(f.kvWrites).toEqual([]); expect(f.effects).toEqual([]); expect(f.log()).not.toContain('ios-reminder-snooze');
    });

    it('ACK alone synchronously wakes observation once before best-effort fixed content-free logging', async () => {
        const f = fixture(), active = f.launch(); await active.boot(); await active.state.fixture.seed();
        const observe = () => JSON.parse(active.state.MindwtrHost.iosReminderObservation()) as { revision: number };
        const initial = JSON.parse(active.state.MindwtrHost.iosReminderObserve()).revision;
        const after = await active.prepare(); expect(observe().revision).toBe(initial);
        expect(await active.validate(after)).toMatchObject({ ok: true }); expect(observe().revision).toBe(initial);
        expect(await active.poll(active.state.MindwtrHost.reminderSnoozeCommit(raw))).toMatchObject({ ok: true });
        expect(await active.poll(active.state.MindwtrHost.reminderSnoozeProbe(raw))).toMatchObject({ ok: true });
        expect(await active.poll(active.state.MindwtrHost.reminderSnoozeRetry(raw))).toMatchObject({ ok: true });
        expect(observe().revision).toBe(initial); expect(f.log()).not.toContain('ios-reminder-snooze');
        const acknowledgment = active.state.MindwtrHost.reminderSnoozeAcknowledged();
        expect(observe().revision).toBe(initial + 1);
        expect(await active.poll(acknowledgment)).toEqual({ ok: true, value: null });
        const entries = f.log().trim().split('\n').map((line) => JSON.parse(line));
        const markers = entries.filter((entry) => entry.context?.releaseCheck === 'v1.3.5/ios-reminder-snooze');
        expect(markers).toHaveLength(1); expect(markers[0].message).toBe('Native iOS reminder Snooze acknowledged');
        expect(markers[0].context).toEqual({ releaseCheck: 'v1.3.5/ios-reminder-snooze', outcome: 'confirmed' });
        expect(markers[0].scope).toBe('native-ios'); expect(JSON.stringify(markers)).not.toContain('PRIVATE');
        expect(JSON.stringify(markers)).not.toContain(requestId);
        f.failLog();
        const failingLogAck = active.state.MindwtrHost.reminderSnoozeAcknowledged(); expect(observe().revision).toBe(initial + 2);
        expect(await active.poll(failingLogAck)).toEqual({ ok: true, value: null });
        expect(f.log().trim().split('\n')).toHaveLength(entries.length);
    });
});
