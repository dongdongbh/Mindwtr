import { afterEach, beforeAll, describe, expect, it, spyOn } from 'bun:test';
import { Database } from 'bun:sqlite';
import { build } from 'esbuild';
import vm from 'node:vm';
import { createIosReminderMethods, readOwnedIosReminderMaps } from './host-ios-reminders';

const now = 1_800_000_000_000, token = '12345678-1234-1234-1234-123456789abc';
const names = ['mindwtr:local:alarms:v1', 'mindwtr:native:reminders:v1'];
const signed = JSON.stringify({ title: 'Private', message: 'Private', fireAt: new Date(now + 3600000).toISOString(),
    repeatInterval: 'once', hasSnoozeAction: false, data: {} });
const map = JSON.stringify({ 'task:one': { id: 123, signature: `native:${signed}` } });
const snoozeName = `snooze:${token}`;
const snooze = { kind: 'snooze', id: 2 ** 30, fireAtMs: now + 3600000, armed: true,
    details: { title: 'Private', message: 'Private', tag: 'task:one', play_sound: true, data: { alarmKey: 'task:one' } } };
const unavailable = 'NOT_READY: Reminder reconciliation is unavailable';

describe('strict native iOS reminder ownership admission', () => {
    it('accepts empty and exact native alarm/delivered/Snooze schemas without normalizing raw strings', () => {
        expect(readOwnedIosReminderMaps(null, null)).toEqual({ map: {}, state: {} });
        const state = JSON.stringify({ 'task:delivered': { kind: 'delivered', id: 456, firedAtMs: now, signature: signed }, [snoozeName]: snooze });
        expect(Object.keys(readOwnedIosReminderMaps(map, state).state)).toEqual(['task:delivered', snoozeName]);
    });
    it.each(['PRIVATE', '[]', 'null', '{"task:one":{"id":123}}',
        JSON.stringify({ 'task:one': { id: 123, signature: signed } }),
        JSON.stringify({ 'task:one': { id: 2 ** 30, signature: `native:${signed}` } }),
        JSON.stringify({ 'task:one': { id: true, signature: `native:${signed}` } }),
        JSON.stringify({ 'task:one': { id: 123, signature: `native:${signed}`, pending: false } }),
        JSON.stringify({ 'task:one': { id: 123, signature: `native:${signed}`, extra: 1 } })])('refuses malformed/legacy alarm map %#', (raw) => {
        expect(() => readOwnedIosReminderMaps(raw, '{}')).toThrow(unavailable);
    });
    it.each(['[]', '{"task:one":{"kind":"unknown","id":123}}',
        JSON.stringify({ [snoozeName]: { ...snooze, id: 123 } }),
        JSON.stringify({ [snoozeName]: { ...snooze, armed: 1 } }),
        JSON.stringify({ 'task:other': { kind: 'delivered', id: 123, firedAtMs: now } }),
        JSON.stringify({ 'task:other': { kind: 'delivered', id: 456, firedAtMs: now, extra: true } })])('refuses unsupported state or duplicate ordinary ownership %#', (raw) => {
        expect(() => readOwnedIosReminderMaps(map, raw)).toThrow(unavailable);
    });
    it('selectively remakes missing ordinary IDs, preserves pending requests and never invents fired evidence', async () => {
        const inputs: unknown[] = [];
        const methods = createIosReminderMethods({ capture: () => () => {}, read: async () => [[names[0], map], [names[1], '{}']],
            plan: async (input) => { inputs.push(input); return { ok: true, value: { mode: 'active', cancel: [], schedule: [],
                writeAhead: null, alarms: map, state: '{}', topUpDelayMs: null, clearDelivered: false } }; }, acknowledged: async () => {} });
        methods.begin(token);
        await methods.prepare(token, true, '[]', '[]');
        await methods.prepare(token, true, '[123]', '[]');
        await methods.prepare(token, true, '[]', '[123]');
        expect(inputs).toEqual([
            { storedAlarms: map, storedState: '{}', permissionGranted: true, remake: ['task:one'], fired: [], shown: [] },
            { storedAlarms: map, storedState: '{}', permissionGranted: true, remake: [], fired: [], shown: [] },
            { storedAlarms: map, storedState: '{}', permissionGranted: true, remake: ['task:one'], fired: [123], shown: [123] },
        ]);
    });
    it('admits only actual shared once/daily/weekly signature time encodings and integral bounded state instants', () => {
        for (const [repeatInterval, fireAt] of [['once', new Date(now).toISOString()], ['daily', 'daily:23:59'], ['weekly', 'weekly:0:00:00'], ['weekly', 'weekly:6:23:59']]) {
            const signature = `native:${JSON.stringify({ ...JSON.parse(signed), repeatInterval, fireAt })}`;
            expect(() => readOwnedIosReminderMaps(JSON.stringify({ 'task:one': { id: 123, signature } }), '{}')).not.toThrow();
        }
        for (const [repeatInterval, fireAt] of [['once', 'bad'], ['once', '2027-01-15'], ['daily', 'daily:24:00'],
            ['weekly', 'weekly:7:09:00'], ['weekly', 'weekly:0:9:00'], ['weekly', 'daily:09:00']]) {
            const signature = `native:${JSON.stringify({ ...JSON.parse(signed), repeatInterval, fireAt })}`;
            expect(() => readOwnedIosReminderMaps(JSON.stringify({ 'task:one': { id: 123, signature } }), '{}')).toThrow(unavailable);
        }
        for (const fireAtMs of [1.5, 8_640_000_000_000_001]) {
            expect(() => readOwnedIosReminderMaps('{}', JSON.stringify({ [snoozeName]: { ...snooze, fireAtMs } }))).toThrow(unavailable);
            expect(() => readOwnedIosReminderMaps('{}', JSON.stringify({ 'task:one': { kind: 'delivered', id: 123, firedAtMs: fireAtMs } }))).toThrow(unavailable);
        }
    });
    it('selects only granted future armed Snoozes missing from both native inventories', async () => {
        const clock = spyOn(Date, 'now').mockReturnValue(now);
        try {
            const state = JSON.stringify({ [snoozeName]: snooze,
                'snooze:22222222-2222-4222-8222-222222222222': { ...snooze, id: 1073741825 },
                'snooze:33333333-3333-4333-8333-333333333333': { ...snooze, id: 1073741826 },
                'snooze:44444444-4444-4444-8444-444444444444': { ...snooze, id: 1073741827, fireAtMs: now - 1 },
                'snooze:55555555-5555-4555-8555-555555555555': { ...snooze, id: 1073741828, fireAtMs: now },
                'snooze:66666666-6666-4666-8666-666666666666': { ...snooze, id: 1073741829, armed: false },
            });
            const inputs: unknown[] = [];
            const methods = createIosReminderMethods({ capture: () => () => {},
                read: async () => [[names[0], '{}'], [names[1], state]],
                plan: async (input) => { inputs.push(input); return { ok: true, value: { mode: 'active', cancel: [], schedule: [],
                    writeAhead: null, alarms: '{}', state, topUpDelayMs: null, clearDelivered: false } }; }, acknowledged: async () => {} });
            methods.begin(token);
            await methods.prepare(token, true, '[1073741825]', '[1073741826]');
            await methods.prepare(token, false, '[1073741825]', '[1073741826]');
            expect(inputs).toEqual([
                { storedAlarms: '{}', storedState: state, permissionGranted: true, remake: [snoozeName], fired: [1073741826], shown: [1073741826] },
                { storedAlarms: '{}', storedState: state, permissionGranted: false, remake: [], fired: [1073741826], shown: [1073741826] },
            ]);
        } finally { clock.mockRestore(); }
    });
    it.each(['read', 'plan'])('refuses a lost current owner after the %s await without acknowledgment', async (stage) => {
        let valid = true, acknowledged = 0;
        const methods = createIosReminderMethods({ capture: () => () => { if (!valid) throw new Error(unavailable); },
            read: async () => { if (stage === 'read') valid = false; return [[names[0], '{}'], [names[1], JSON.stringify({ [snoozeName]: snooze })]]; },
            plan: async () => { valid = false; return { ok: true, value: { mode: 'active', cancel: [], schedule: [],
                writeAhead: null, alarms: '{}', state: '{}', topUpDelayMs: null, clearDelivered: false } }; },
            acknowledged: async () => { acknowledged += 1; } });
        methods.begin(token);
        await expect(methods.prepare(token, true, '[]', '[]')).rejects.toThrow(unavailable);
        expect(acknowledged).toBe(0);
    });
    it('admits bounded rearm acknowledgment only for the current owner and preserves default counts', async () => {
        const counts: unknown[] = [];
        const methods = createIosReminderMethods({ capture: () => () => {}, read: async () => [], plan: async () => ({ ok: false }),
            acknowledged: async (...values) => { counts.push(values); } });
        methods.begin(token);
        for (const count of [NaN, Infinity, -1, 0.5, 65]) {
            await expect(methods.acknowledge(token, 'active', 64, 0, 0, count)).rejects.toThrow(unavailable);
        }
        await expect(methods.acknowledge(token, 'active', 1, 0, 0, 2)).rejects.toThrow(unavailable);
        expect(counts).toEqual([]);
        await methods.acknowledge(token, 'active', 0, 0);
        await methods.acknowledge(token, 'active', 64, 0, 0, 64);
        expect(counts).toEqual([['active', 0, 0, 0, 0], ['active', 64, 0, 0, 64]]);
        methods.end(token);
        await expect(methods.acknowledge(token, 'active', 1, 0, 0, 1)).rejects.toThrow(unavailable);
        expect(counts).toHaveLength(2);
    });
    it.each(['read', 'plan'])('normalizes private %s failures to the fixed content-free refusal', async (failure) => {
        const methods = createIosReminderMethods({ capture: () => () => {}, read: async () => {
            if (failure === 'read') throw new Error('PRIVATE_STORED_CONTENT');
            return [[names[0], '{}'], [names[1], '{}']];
        }, plan: async () => { throw new Error('PRIVATE_TASK_CONTENT'); }, acknowledged: async () => {} });
        methods.begin(token); await expect(methods.prepare(token, true, '[]', '[]')).rejects.toThrow(unavailable);
    });
    it('subscribes synchronously once, tracks resolved-language changes and disposes exactly its listener', () => {
        let subscriptions = 0, disposed = 0, ready = false, changed = () => {};
        const methods = createIosReminderMethods({ capture: () => () => {}, read: async () => [], plan: async () => ({ ok: false }),
            acknowledged: async () => {}, observation: { subscribe: (listener) => {
                subscriptions += 1; changed = listener; return () => { disposed += 1; };
            }, ready: () => ready, rescheduleDelayMs: 2500 } });
        methods.languageResolved('en');
        expect(methods.observe()).toEqual({ revision: 1, ready: false, rescheduleDelayMs: 2500 });
        expect(methods.observe().revision).toBe(1); expect(subscriptions).toBe(1);
        changed(); ready = true;
        expect(methods.observation()).toEqual({ revision: 2, ready: true, rescheduleDelayMs: 2500 });
        methods.languageResolved('en'); expect(methods.observation().revision).toBe(2);
        methods.languageResolved('de'); expect(methods.observation().revision).toBe(3);
        methods.disposeObservation(); methods.disposeObservation(); expect(disposed).toBe(1);
        expect(() => methods.observation()).toThrow(unavailable);
        expect(methods.observe().revision).toBe(4); expect(subscriptions).toBe(2);
    });
});

let source: string;
const databases: Database[] = [];
beforeAll(async () => {
    const built = await build({ stdin: { contents: `import './host-entry';
        import { useTaskStore, flushPendingSave } from '../../../packages/core/src/store';
        globalThis.fixture = { seed: () => useTaskStore.setState({ _allTasks: [{ id:'one', title:'PRIVATE_REMINDER', status:'next',
            tags:[], contexts:[], createdAt:new Date(${now}).toISOString(), updatedAt:new Date(${now}).toISOString(),
            dueDate:new Date(${now}+3600000).toISOString() }], settings:{ notificationsEnabled:true, dueDateNotificationsEnabled:true } }),
            save:()=>useTaskStore.getState().addTask('PRIVATE_QUEUED'), flush:flushPendingSave,
            bookkeeping:()=>useTaskStore.setState({settings:{...useTaskStore.getState().settings,lastSyncAt:'synthetic'}}) };`,
        resolveDir: import.meta.dir, loader: 'ts' }, bundle: true, write: false, format: 'iife', target: 'es2022', logLevel: 'silent' });
    source = built.outputFiles[0].text;
});
afterEach(() => { databases.splice(0).forEach((database) => database.close()); });
const fixture = () => {
    const database = new Database(':memory:'); databases.push(database);
    const saved = new Map<string, string | null>(names.map((name) => [name, null])), writes: string[] = [], reads: string[][] = [];
    let log = '', failLog = false, onRead = () => {};
    const state = { AbortController, URL, TextEncoder, TextDecoder, setTimeout, clearTimeout,
        Date: new Proxy(Date, { construct: (target, args) => Reflect.construct(target, args.length ? args : [now]),
            get: (target, property) => property === 'now' ? () => now : Reflect.get(target, property) }),
        __mindwtrHostPlatform: 'ios', console: { log() {}, info() {}, warn() {}, error() {} },
        MindwtrHost: undefined as unknown as { boot(a: string, b: string): string; poll(id: string): string | null;
            iosReminderBegin(id: string): string; iosReminderCurrent(id: string): string; iosReminderEnd(id: string): string;
            iosReminderPrepare(id: string, grant: boolean, pending: string, delivered: string): string;
            iosReminderAcknowledged(id: string, mode: string, scheduled: number, cancelled: number, collapsed?: number, rearmed?: number): string;
            iosReminderObserve(): string; iosReminderObservation(): string; iosReminderDisposeObservation(): string;
            language(stored: string, system: string): string },
        fixture: undefined as unknown as { seed(): void; save(): void; flush(): Promise<void>; bookkeeping(): void },
        __mindwtrNative: {
            sqlExec: (sql: string) => { writes.push('SQL'); database.exec(sql); return null; },
            sqlRun: (sql: string, params: string) => { writes.push('SQL'); database.query(sql).run(...JSON.parse(params)); return null; },
            sqlAll: (sql: string, params: string) => JSON.stringify(database.query(sql).all(...JSON.parse(params))),
            nowMs: () => now, randomBytes: (n: number) => JSON.stringify(Array(n).fill(7)), log: () => {}, rnStateCommit: () => null,
            kvGet: () => '[null]', kvMultiGet: (raw: string) => { const keys = JSON.parse(raw) as string[]; reads.push(keys); onRead(); return JSON.stringify(keys.map((name) => [name, saved.get(name) ?? null])); },
            kvSet: () => { writes.push('KV'); return null; }, kvRemove: () => { writes.push('KV'); return null; },
            fileList: () => 'null', fileRead: () => '', fileDelete: () => { writes.push('file'); return null; },
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
    const poll = async (id: string) => {
        for (let step = 0; step < 100; step++) { const value = state.MindwtrHost.poll(id);
            if (value !== null) return JSON.parse(value); await new Promise((done) => setTimeout(done, 0)); }
        throw new Error('Reminder effect bridge did not settle');
    };
    const boot = async () => { expect(await poll(state.MindwtrHost.boot('', ''))).toMatchObject({ ok: true });
        state.fixture.seed(); writes.length = 0; reads.length = 0; log = ''; };
    return { state, saved, writes, reads, poll, boot, log: () => log, failLog: () => { failLog = true; }, onRead: (value: () => void) => { onRead = value; },
        begin: () => poll(state.MindwtrHost.iosReminderBegin(token)), prepare: (pending = '[]', delivered = '[]') => poll(state.MindwtrHost.iosReminderPrepare(token, true, pending, delivered)) };
};

describe('actual iOS effects planning bridge with native-owned storage/effects', () => {
    it('uses real shared plan and keeps preparation read-only; fixed acknowledgment is private and content-free', async () => {
        const f = fixture(); await f.boot(); expect(await f.begin()).toEqual({ ok: true, value: null });
        const result = await f.prepare(); expect(result.ok).toBe(true); expect(result.value.plan.schedule).toHaveLength(1);
        expect(result.value.plan.schedule[0].key).toBe('task:one'); expect(result.value.plan.writeAhead).toContain('"pending":true');
        expect(f.reads).toEqual([names]); expect(f.writes).toEqual([]); expect(f.log()).toBe('');
        expect(await f.poll(f.state.MindwtrHost.iosReminderAcknowledged(token, 'active', 1, 0))).toEqual({ ok: true, value: null });
        const entry = JSON.parse(f.log().trim());
        expect(entry.context).toEqual({ releaseCheck: 'v1.3.5/ios-reminder-apply', outcome: 'confirmed', mode: 'active', scheduled: '1', cancelled: '0' });
        expect(f.log()).not.toContain('PRIVATE'); expect(f.log()).not.toContain('task:one');
    });
    it('never writes malformed/legacy ownership and accepts neither another owner nor stale saves', async () => {
        const f = fixture(); await f.boot(); await f.begin();
        expect(await f.begin()).toEqual({ ok: false, error: unavailable });
        f.saved.set(names[0], JSON.stringify({ 'task:one': { id: 123, signature: signed } }));
        expect(await f.prepare()).toEqual({ ok: false, error: unavailable }); expect(f.writes).toEqual([]); expect(f.log()).toBe('');
        f.saved.set(names[0], null); f.onRead(() => f.state.fixture.save());
        try { expect(await f.prepare()).toEqual({ ok: false, error: unavailable }); expect(f.writes).toEqual([]); }
        finally { await f.state.fixture.flush(); }
    });
    it('a confirmed native acknowledgment survives logger failure and ended owners cannot publish', async () => {
        const f = fixture(); await f.boot(); await f.begin(); f.failLog();
        expect(await f.poll(f.state.MindwtrHost.iosReminderAcknowledged(token, 'inactive', 0, 0))).toEqual({ ok: true, value: null });
        await f.poll(f.state.MindwtrHost.iosReminderEnd(token));
        expect(await f.poll(f.state.MindwtrHost.iosReminderCurrent(token))).toEqual({ ok: false, error: unavailable });
        expect(f.writes).toEqual([]); expect(f.log()).toBe('');
    });
    it('logs only a bounded confirmed collapse count and preserves acknowledgment if its sink fails', async () => {
        const f = fixture(); await f.boot(); await f.begin();
        for (const count of [-1, 1.5, 4097]) {
            expect(await f.poll(f.state.MindwtrHost.iosReminderAcknowledged(token, 'active', 0, 0, count)))
                .toEqual({ ok: false, error: unavailable });
        }
        expect(f.log()).toBe('');
        expect(await f.poll(f.state.MindwtrHost.iosReminderAcknowledged(token, 'active', 0, 0, 2))).toEqual({ ok: true, value: null });
        const entries = f.log().trim().split('\n').map((line) => JSON.parse(line));
        expect(entries).toHaveLength(2);
        expect(entries[1].message).toBe('Native iOS reminder threads collapsed');
        expect(entries[1].context).toEqual({ releaseCheck: 'v1.3.5/ios-reminder-thread-collapse', count: '2' });
        expect(f.log()).not.toContain('PRIVATE'); expect(f.log()).not.toContain('task:one');
        f.failLog();
        expect(await f.poll(f.state.MindwtrHost.iosReminderAcknowledged(token, 'active', 0, 0, 1))).toEqual({ ok: true, value: null });
        expect(f.writes).toEqual([]);
    });
    it('recovers an exact missing future armed Snooze read-only and logs only a valid confirmed rearm count', async () => {
        const f = fixture(); await f.boot(); await f.begin();
        const storedState = JSON.stringify({ [snoozeName]: snooze });
        f.saved.set(names[1], storedState);
        const result = await f.prepare();
        expect(result.ok).toBe(true);
        expect(result.value.storedState).toBe(storedState);
        expect(result.value.plan.schedule.filter((alarm: { key: string }) => alarm.key === snoozeName))
            .toEqual([{ key: snoozeName, id: 1073741824, fireAtMs: now + 3600000, details: snooze.details, repeat: 'once', replacing: null }]);
        expect(f.writes).toEqual([]); expect(f.log()).toBe('');
        for (const rearmed of [-1, 0.5, 2, 65]) {
            expect(await f.poll(f.state.MindwtrHost.iosReminderAcknowledged(token, 'active', 1, 0, 0, rearmed)))
                .toEqual({ ok: false, error: unavailable });
        }
        expect(f.log()).toBe('');
        expect(await f.poll(f.state.MindwtrHost.iosReminderAcknowledged(token, 'active', 1, 0, 0, 0)))
            .toEqual({ ok: true, value: null });
        expect(f.log()).not.toContain('ios-reminder-snooze-recovery');
        expect(await f.poll(f.state.MindwtrHost.iosReminderAcknowledged(token, 'active', 1, 0, 0, 1)))
            .toEqual({ ok: true, value: null });
        const entries = f.log().trim().split('\n').map((line) => JSON.parse(line));
        const recovered = entries.filter((entry) => entry.context.releaseCheck === 'v1.3.5/ios-reminder-snooze-recovery');
        expect(recovered).toHaveLength(1);
        expect(recovered[0].message).toBe('Native iOS missing Snoozes recovered');
        expect(recovered[0].context).toEqual({ releaseCheck: 'v1.3.5/ios-reminder-snooze-recovery', count: '1' });
        expect(f.log()).not.toContain('PRIVATE'); expect(f.log()).not.toContain('task:one'); expect(f.log()).not.toContain(snoozeName);
        f.failLog();
        expect(await f.poll(f.state.MindwtrHost.iosReminderAcknowledged(token, 'active', 1, 0, 0, 1)))
            .toEqual({ ok: true, value: null });
        expect(f.writes).toEqual([]);
    });
    it('observes actual shared source and settlement without bookkeeping or unchanged-language loops', async () => {
        const f = fixture(); await f.boot();
        const initial = JSON.parse(f.state.MindwtrHost.iosReminderObserve());
        expect(initial).toEqual({ revision: 1, ready: true, rescheduleDelayMs: 2500 });
        expect(JSON.parse(f.state.MindwtrHost.iosReminderObserve())).toEqual(initial);
        f.state.fixture.bookkeeping(); expect(JSON.parse(f.state.MindwtrHost.iosReminderObservation())).toEqual(initial);
        f.state.fixture.save();
        const pending = JSON.parse(f.state.MindwtrHost.iosReminderObservation());
        expect(pending.revision).toBeGreaterThan(initial.revision); expect(pending.ready).toBe(false);
        await f.state.fixture.flush();
        const settled = JSON.parse(f.state.MindwtrHost.iosReminderObservation());
        expect(settled).toEqual({ ...pending, ready: true });
        await f.poll(f.state.MindwtrHost.language('de', 'en'));
        const translated = JSON.parse(f.state.MindwtrHost.iosReminderObservation());
        expect(translated.revision).toBe(settled.revision + 1);
        await f.poll(f.state.MindwtrHost.language('de', 'en'));
        expect(JSON.parse(f.state.MindwtrHost.iosReminderObservation())).toEqual(translated);
        expect(Object.keys(translated).sort()).toEqual(['ready', 'rescheduleDelayMs', 'revision']);
        expect(f.log()).toBe('');
        expect(JSON.parse(f.state.MindwtrHost.iosReminderDisposeObservation())).toBeNull();
    });
});
