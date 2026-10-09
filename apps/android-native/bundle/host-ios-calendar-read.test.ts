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

const fixture = (options: { channel?: boolean; permission?: string; failCalendars?: boolean } = {}) => {
    const database = new Database(':memory:');
    const writes: string[] = [], calls: Record<string, any>[] = [], reads: { sql: string; params: unknown[] }[] = [], lines: string[] = [];
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
    const f = { state, database, writes, calls, reads, kv, lines, poll, logText: () => logText,
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
