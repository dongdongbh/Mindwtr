import { afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import vm from 'node:vm';
import { build } from 'esbuild';
import type { AppData } from '../../../packages/core/src/types';

let source: string;
const fixtures: ReturnType<typeof fixture>[] = [];
const start = '2026-10-09T00:00:00.000Z', end = '2026-10-10T00:00:00.000Z';
const selected = ['é', 'e\u0301', ' opaque /漢+😀 '];
const request = (extra: Record<string, unknown> = {}) => ({ op: 'feed', slot: 'calendar', start, end, ...extra });
const event = (id: string, calendarId = selected[0]) => ({ id, calendarId, title: 'PRIVATE EVENT',
    startDate: '2026-10-09T08:00:00.000Z', endDate: '2026-10-09T09:00:00.000Z',
    allDay: false, notes: 'PRIVATE NOTES https://private.example', location: 'PRIVATE LOCATION' });
const data: AppData = { tasks: [{ id: 'PRIVATE TASK ID', title: 'PRIVATE TASK', status: 'inbox',
    contexts: [], tags: [], createdAt: start, updatedAt: start }], projects: [], sections: [], areas: [], settings: {} };

beforeAll(async () => {
    const built = await build({ stdin: { contents: `
        import './host-entry';
        import { useTaskStore, getStorageAdapter, setStorageAdapter, flushPendingSave, resetForTests } from '../../../packages/core/src/store';
        import { acquireWorkspaceTransitionLock, initializeSandboxRuntime } from '../../../packages/core/src/sandbox';
        globalThis.fixture = { state: useTaskStore.getState, adapter: getStorageAdapter, replaceAdapter: setStorageAdapter,
            flush: flushPendingSave, reset: resetForTests,
            sandbox: () => initializeSandboxRuntime(true), transition: acquireWorkspaceTransitionLock,
            canonical: () => { const s = useTaskStore.getState(); return { tasks: s._allTasks, projects: s._allProjects,
                sections: s._allSections, areas: s._allAreas, settings: s.settings }; },
            install: d => useTaskStore.setState({ _allTasks: d.tasks, _allProjects: d.projects,
                _allSections: d.sections, _allAreas: d.areas, settings: d.settings }),
        };
    `, resolveDir: import.meta.dir, loader: 'ts' }, bundle: true, write: false, format: 'iife', target: 'es2022', logLevel: 'silent' });
    source = built.outputFiles[0].text;
});

afterEach(async () => {
    for (const f of fixtures.splice(0)) { await f.state.fixture.flush(); f.state.fixture.reset(); f.database.close(); }
});

const fixture = (options: { channel?: boolean; permission?: string; failCalendars?: boolean; deviceSettings?: boolean } = {}) => {
    const database = new Database(':memory:');
    const writes: string[] = [], calls: Record<string, any>[] = [], reads: { sql: string; params: unknown[] }[] = [], lines: string[] = [];
    const cellReads: unknown[] = [], cellWrites: unknown[] = [];
    const kv = new Map([['mindwtr-system-calendar-settings', JSON.stringify({ enabled: true, selectAll: false,
        selectedCalendarIds: selected, areaIdsByCalendar: {} })]]);
    let logText = '', events = [event('external')];
    let nextHold: { op: string; entered: () => void; promise: Promise<void> } | null = null;
    const call = async (input: Record<string, any>) => {
        calls.push(structuredClone(input));
        if (nextHold?.op === input.op) {
            const held = nextHold; nextHold = null; held.entered(); await held.promise;
        }
        if (input.op === 'permissions') return { status: options.permission ?? 'granted' };
        if (input.op === 'calendars') {
            if (options.failCalendars) throw new Error('PRIVATE provider error with calendar contents');
            return selected.map((id) => ({ id, title: 'PRIVATE CALENDAR', color: '#123456', allowsModifications: true }));
        }
        if (input.op === 'events') return structuredClone(events);
        throw new Error('Unexpected permission mutation or calendar operation');
    };
    const state: Record<string, any> = {
        AbortController, URL, TextEncoder, TextDecoder, setTimeout, clearTimeout,
        __mindwtrHostPlatform: 'ios', console: { info() {}, warn() {}, error() {}, log() {} },
        __cancelHostCalls() {}, __resumeHostCalls() {},
        ...(options.channel === false ? {} : { __mindwtrCalendarCall: call }),
        __mindwtrNative: {
            sqlExec: (sql: string) => { writes.push('sqlExec'); database.exec(sql); return null; },
            sqlRun: (sql: string, params: string) => { writes.push('sqlRun'); database.query(sql).run(...JSON.parse(params)); return null; },
            sqlAll: (sql: string, params: string) => {
                reads.push({ sql, params: JSON.parse(params) }); return JSON.stringify(database.query(sql).all(...JSON.parse(params)));
            },
            nowMs: () => Date.now(), randomBytes: (count: number) => JSON.stringify(Array(count).fill(7)), log: (line: string) => { lines.push(line); },
            logFile: (op: string, text: string) => {
                if (op === 'path' || op === 'ensure') return 'files/logs/mindwtr.log';
                if (op === 'size') return String(logText.length);
                if (op === 'read') return logText;
                if (op === 'exists') return logText ? '1' : '';
                if (op === 'isAbsent') return logText ? '' : '1';
                if (op === 'append') { logText += text; return ''; }
                if (op === 'write') { logText = text; return ''; }
                if (op === 'delete') { logText = ''; return '1'; }
                throw new Error('Unexpected diagnostic operation');
            },
            ...(options.deviceSettings ? {
                calendarSettingRead: () => { cellReads.push(true); return JSON.stringify([
                    kv.get('mindwtr-system-calendar-settings') ?? null, kv.get('mindwtr:native:calendar-setting:v1') ?? null]); },
                calendarSettingCAS: (beforeJSON: string, afterJSON: string) => {
                    const names = ['mindwtr-system-calendar-settings', 'mindwtr:native:calendar-setting:v1'];
                    if (JSON.stringify(names.map((name) => kv.get(name) ?? null)) !== beforeJSON)
                        return '!MindwtrNativeError:STALE_REVISION: Calendar setting changed';
                    const after = JSON.parse(afterJSON) as string[];
                    names.forEach((name, i) => kv.set(name, after[i])); cellWrites.push(after); return null;
                },
            } : {}),
            rnStateCommit: () => null, kvGet: (key: string) => JSON.stringify([kv.get(key) ?? null]),
            kvSet: (key: string, value: string) => { writes.push('kvSet'); kv.set(key, value); return null; },
            kvRemove: (key: string) => { writes.push('kvRemove'); kv.delete(key); return null; },
            fileList: () => 'null', fileRead: () => '', fileDelete: () => { writes.push('fileDelete'); return null; },
        },
    };
    vm.runInNewContext(source, state);
    const poll = async (ticket: string) => {
        for (let step = 0; step < 100; step++) {
            const answer = state.MindwtrHost.poll(ticket);
            if (answer !== null) return JSON.parse(answer);
            await new Promise((done) => setTimeout(done, 0));
        }
        throw new Error('Host operation did not settle');
    };
    const f = { state, database, writes, calls, reads, kv, lines, poll, cellReads, cellWrites, logText: () => logText,
        setEvents: (value: typeof events) => { events = value; },
        read: (value: unknown = request()) => poll(state.MindwtrHost.iosCalendarRead(JSON.stringify(value))),
        boot: async () => {
            expect(await poll(state.MindwtrHost.boot('', ''))).toMatchObject({ ok: true });
            state.fixture.install(structuredClone(data)); writes.length = 0; reads.length = 0; lines.length = 0; logText = '';
        },
        hold: (op = 'events') => {
            let entered!: () => void, release!: () => void;
            const accepted = new Promise<void>((resolve) => { entered = resolve; });
            nextHold = { op, entered, promise: new Promise<void>((resolve) => { release = resolve; }) };
            return { accepted, release };
        },
    };
    fixtures.push(f); return f;
};

const assertReadonly = async (f: ReturnType<typeof fixture>, before: any, kv: Map<string, string>) => {
    await f.state.fixture.flush();
    for (const field of ['tasks', 'projects', 'sections', 'areas', 'settings']) expect(f.state.fixture.canonical()[field]).toBe(before[field]);
    expect(f.writes).toEqual([]); expect(f.kv).toEqual(kv);
};

describe('actual exported iOS calendar read transport', () => {
    it('boots without provider reads and refuses before boot or with no native channel', async () => {
        const f = fixture();
        expect(await f.read()).toMatchObject({ ok: false, error: expect.stringContaining('NOT_READY:') });
        await f.boot(); expect(f.calls).toEqual([]);
        const absent = fixture({ channel: false }); await absent.boot();
        expect(await absent.read()).toMatchObject({ ok: false, error: expect.stringContaining('NOT_READY:') });
        expect(absent.calls).toEqual([]); expect(absent.logText()).toBe('');
    });

    it('opens, reads and closes Settings with passive permission only and preserves data', async () => {
        const f = fixture(); await f.boot();
        const before = f.state.fixture.canonical(), kv = new Map(f.kv);
        const opened = await f.read({ op: 'openSettings' });
        expect(opened).toMatchObject({ ok: true, value: { device: { enabled: true, access: null } } });
        expect(opened.value.device.calendars.map((calendar: any) => calendar.id)).toEqual(selected);
        expect(f.calls.every((call) => call.op === 'permissions' || call.op === 'calendars')).toBe(true);
        const calls = structuredClone(f.calls);
        expect(await f.read({ op: 'getSettings' })).toMatchObject({ ok: true });
        expect(await f.read({ op: 'closeSettings' })).toEqual({ ok: true, value: null });
        expect(f.calls).toEqual(calls);
        await assertReadonly(f, before, kv);
    });

    it.each(['denied', 'undetermined'])('keeps %s permission passive and never queries events', async (permission) => {
        const f = fixture({ permission }); await f.boot();
        const before = f.state.fixture.canonical(), kv = new Map(f.kv);
        expect(await f.read({ op: 'openSettings' })).toMatchObject({ ok: true, value: { device: { access: expect.any(Object), calendars: [] } } });
        expect(await f.read()).toMatchObject({ ok: true, value: { status: 'ready', events: [], calendars: [] } });
        expect(f.calls.every((call) => call.op === 'permissions')).toBe(true);
        await assertReadonly(f, before, kv);
    });

    it('preserves saved selection when enumeration fails instead of treating failure as absence', async () => {
        const f = fixture({ failCalendars: true }); await f.boot();
        const before = f.state.fixture.canonical(), kv = new Map(f.kv);
        const opened = await f.read({ op: 'openSettings' });
        expect(opened).toMatchObject({ ok: true });
        expect(opened.value.toasts.length).toBeGreaterThan(0);
        await assertReadonly(f, before, kv);
        expect(f.logText()).not.toContain('PRIVATE');
    });

    it('uses SQLite calendar_sync mappings, exact selected IDs and complete shared event output', async () => {
        const f = fixture(); await f.boot();
        f.database.query('INSERT INTO calendar_sync (task_id, calendar_event_id, calendar_id, platform, last_synced_at) VALUES (?, ?, ?, ?, ?)')
            .run('mapped-task', 'mirrored', selected[0], 'ios', start);
        f.database.query('INSERT INTO calendar_sync (task_id, calendar_event_id, calendar_id, platform, last_synced_at) VALUES (?, ?, ?, ?, ?)')
            .run('android-task', 'android-only', selected[0], 'android', start);
        const mapping = f.database.query('SELECT * FROM calendar_sync ORDER BY task_id').all();
        f.setEvents([event('mirrored'), event('mirrored', selected[1]), event('android-only'), event('external')]);
        const before = f.state.fixture.canonical(), kv = new Map(f.kv);
        const result = await f.read();
        expect(result).toMatchObject({ ok: true, value: { status: 'ready' } });
        expect(result.value.events.map((row: any) => [row.nativeEventId, row.sourceId])).toEqual([
            ['mirrored', `system:${selected[1]}`], ['android-only', `system:${selected[0]}`], ['external', `system:${selected[0]}`],
        ]);
        expect(f.calls.find((call) => call.op === 'events')).toEqual({ op: 'events', calendarIds: selected, startMs: Date.parse(start), endMs: Date.parse(end) });
        expect(f.reads.some((read) => /SELECT \* FROM calendar_sync WHERE platform = \?/.test(read.sql) && read.params[0] === 'ios')).toBe(true);
        expect(f.database.query('SELECT * FROM calendar_sync ORDER BY task_id').all()).toEqual(mapping);
        expect(result.value.events.find((row: any) => row.nativeEventId === 'external')).toMatchObject({
            title: 'PRIVATE EVENT', description: 'PRIVATE NOTES https://private.example', location: 'PRIVATE LOCATION', start: '2026-10-09T08:00:00.000Z', end: '2026-10-09T09:00:00.000Z',
        });
        await assertReadonly(f, before, kv);
        const diagnostic = f.logText();
        expect(diagnostic).toContain('v1.3.5/ios-calendar-read');
        for (const secret of ['PRIVATE', 'private.example', '"mirrored"', '"android-only"', '"external"', ...selected]) expect(diagnostic).not.toContain(secret);
    });

    it.each([
        null, [], {}, { op: ['openSettings'] }, { op: ['closeSettings'] }, { op: 'permissions' }, { op: 'requestPermissions' }, { op: 'openSettings', extra: true },
        request({ slot: ['calendar'] }),
        request({ slot: 'unknown' }), request({ slot: {} }), request({ start: 1 }), request({ start: 'invalid' }),
        request({ end: start }), request({ end: '2026-10-08T00:00:00.000Z' }), request({ end: '2027-10-11T00:00:00.000Z' }),
        request({ refresh: 'true' }), request({ timeoutMs: 1 }), request({ extra: true }),
    ].map((value) => ({ value })))('refuses malformed op/range before provider access %#', async ({ value }) => {
        const f = fixture(); await f.boot();
        const result = await f.read(value);
        expect(result).toMatchObject({ ok: false, error: expect.stringContaining('INVALID_INPUT:') });
        expect(f.calls).toEqual([]); expect(f.writes).toEqual([]); expect(f.logText()).toBe('');
    });

    it('cancels an accepted held read, rejects its late result and allows retry without a late success diagnostic', async () => {
        const f = fixture(); await f.boot();
        const before = f.state.fixture.canonical(), kv = new Map(f.kv), gate = f.hold();
        const ticket = f.state.MindwtrHost.iosCalendarRead(JSON.stringify(request()));
        await gate.accepted;
        f.state.MindwtrHost.cancel(ticket);
        expect(f.state.MindwtrHost.poll(ticket)).toBeNull();
        gate.release();
        expect(await f.poll(ticket)).toMatchObject({ ok: false, error: expect.stringContaining('CANCELLED:') });
        expect(f.logText()).not.toContain('v1.3.5/ios-calendar-read');
        expect(await f.read()).toMatchObject({ ok: true, value: { status: 'ready', events: [expect.objectContaining({ nativeEventId: 'external' })] } });
        expect(f.calls.filter((call) => call.op === 'events')).toHaveLength(2);
        await assertReadonly(f, before, kv);
    });

    it.each(['adapter', 'sandbox', 'transition'])('refuses %s before provider access and after a held callback', async (guard) => {
        const change = (f: ReturnType<typeof fixture>) => {
            if (guard === 'adapter') f.state.fixture.replaceAdapter({});
            if (guard === 'sandbox') f.state.fixture.sandbox();
            if (guard === 'transition') f.state.fixture.transition();
        };
        const early = fixture(); await early.boot(); change(early);
        expect(await early.read()).toMatchObject({ ok: false, error: expect.stringContaining('NOT_READY:') });
        expect(early.calls).toEqual([]); expect(early.logText()).toBe('');
        const late = fixture(); await late.boot(); const gate = late.hold();
        const ticket = late.state.MindwtrHost.iosCalendarRead(JSON.stringify(request()));
        await gate.accepted; change(late); gate.release();
        expect(await late.poll(ticket)).toMatchObject({ ok: false, error: expect.stringContaining('NOT_READY:') });
        expect(late.logText()).not.toContain('v1.3.5/ios-calendar-read'); expect(late.writes).toEqual([]);
    });
});

const calendarEdit = (f: ReturnType<typeof fixture>) => {
    const before = JSON.parse(f.kv.get('mindwtr-system-calendar-settings')!);
    return { requestId: '33333333-3333-4333-8333-333333333333',
        edit: { type: 'deviceCalendars', before, value: { ...before, enabled: false } } };
};
const settingCall = (f: ReturnType<typeof fixture>, method: string, value: unknown) =>
    f.poll(f.state.MindwtrHost[method](JSON.stringify(value)));

describe('actual exported iOS device-calendar prepared setting', () => {
    it('requires boot and its fixed native capability before any storage access', async () => {
        const f = fixture({ deviceSettings: true });
        expect(await settingCall(f, 'deviceCalendarSettingPrepare', calendarEdit(f))).toMatchObject({ ok: false });
        expect(f.cellReads).toEqual([]); expect(f.cellWrites).toEqual([]);
        const absent = fixture(); await absent.boot();
        expect(await settingCall(absent, 'deviceCalendarSettingPrepare', calendarEdit(absent))).toMatchObject({ ok: false });
        expect(absent.cellReads).toEqual([]); expect(absent.cellWrites).toEqual([]);
    });

    it('loads the production durable receipt command and saves only the proven receipt', async () => {
        const f = fixture({ deviceSettings: true }); await f.boot();
        const request = calendarEdit(f), before = f.state.fixture.canonical();
        const planned = await settingCall(f, 'deviceCalendarSettingPrepare', request);
        expect(planned).toMatchObject({ ok: true, value: { kind: 'prepared' } });
        const envelope = { request, prepared: planned.value.prepared };
        expect(await settingCall(f, 'deviceCalendarSettingValidate', envelope)).toMatchObject({ ok: true });
        const committed = await settingCall(f, 'deviceCalendarSettingCommit', envelope);
        expect(committed).toEqual({ ok: true, value: { changed: true, toasts: [], open: null, clearDraft: false } });
        expect(f.cellWrites).toHaveLength(1); expect(f.calls).toEqual([]);
        expect(f.database.query('SELECT COUNT(*) AS n FROM native_request_receipts').get()).toEqual({ n: 1 });
        expect(f.database.query('SELECT COUNT(*) AS n FROM tasks').get()).toEqual({ n: 0 });
        for (const field of ['tasks', 'projects', 'sections', 'areas', 'settings'])
            expect(f.state.fixture.canonical()[field]).toBe(before[field]);
        const reads = f.cellReads.length;
        f.kv.set('mindwtr-system-calendar-settings', 'later unrelated choice');
        expect(await settingCall(f, 'deviceCalendarSettingRetryOutcome', request)).toEqual(committed);
        expect(await settingCall(f, 'deviceCalendarSettingCommit', envelope)).toEqual(committed);
        expect(f.cellReads).toHaveLength(reads); expect(f.cellWrites).toHaveLength(1);
        expect(f.kv.get('mindwtr-system-calendar-settings')).toBe('later unrelated choice');
        expect(f.logText()).not.toContain('ios-calendar-setting');
        expect(await f.poll(f.state.MindwtrHost.deviceCalendarSettingAcknowledged())).toEqual({ ok: true, value: null });
        expect(f.logText()).toContain('v1.3.5/ios-calendar-setting');
        expect(f.logText()).not.toContain(selected[2]); expect(f.logText()).not.toContain(request.requestId);
    });

    it('refuses stale cells without a receipt or provider operation', async () => {
        const f = fixture({ deviceSettings: true }); await f.boot();
        const request = calendarEdit(f), planned = await settingCall(f, 'deviceCalendarSettingPrepare', request);
        expect(planned.ok).toBe(true);
        f.kv.set('mindwtr:native:calendar-setting:v1', 'later marker');
        expect(await settingCall(f, 'deviceCalendarSettingCommit', { request, prepared: planned.value.prepared }))
            .toMatchObject({ ok: false, error: expect.stringContaining('STALE_REVISION') });
        expect(f.cellWrites).toEqual([]); expect(f.calls).toEqual([]);
        expect(f.database.query('SELECT COUNT(*) AS n FROM native_request_receipts').get()).toEqual({ n: 0 });
    });
});
