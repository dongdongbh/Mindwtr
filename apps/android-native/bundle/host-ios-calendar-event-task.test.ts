import { afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import vm from 'node:vm';
import { build } from 'esbuild';

let source: string;
const fixtures: ReturnType<typeof fixture>[] = [];
const request = () => ({ requestId: '6475c779-e751-42d3-a2ea-85abffb3be73',
    event: { title: 'PRIVATE +Project /due:tomorrow', start: '2036-10-03T10:00:00.000Z', end: '2036-10-03T11:15:00.000Z',
        allDay: false, description: 'PRIVATE NOTES', location: 'PRIVATE LOCATION' },
    calendarName: 'PRIVATE CALENDAR', fallbackTitle: 'Calendar event',
    state: { viewMode: 'week', selectedDate: '2036-10-03', visibleMonth: '2036-10-01' } });

beforeAll(async () => {
    const result = await build({ stdin: { contents: `
        import './host-entry';
        import { useTaskStore, flushPendingSave, resetForTests } from '../../../packages/core/src/store';
        globalThis.fixture = { state: useTaskStore.getState, flush: flushPendingSave, reset: resetForTests,
            install: data => useTaskStore.setState({ _allTasks: data.tasks, _allProjects: [], _allSections: [], _allAreas: [], settings: data.settings }),
            fail: () => useTaskStore.setState({ persistenceFailure: { message: 'fixture failure' } }),
            clearFailure: () => useTaskStore.setState({ persistenceFailure: null }),
        };
    `, resolveDir: import.meta.dir, loader: 'ts' }, bundle: true, write: false, format: 'iife', target: 'es2022', logLevel: 'silent' });
    source = result.outputFiles[0].text;
});
afterEach(async () => {
    for (const f of fixtures.splice(0)) {
        f.state.fixture.clearFailure(); await f.state.fixture.flush(); f.state.fixture.reset(); f.database.close();
    }
});

const fixture = (loggingEnabled = false) => {
    const database = new Database(':memory:');
    const writes: string[] = [], providers: unknown[] = [], kv = new Map<string, string>();
    let logText = '';
    const state: Record<string, any> = {
        AbortController, URL, TextEncoder, TextDecoder, setTimeout, clearTimeout,
        __mindwtrHostPlatform: 'ios', console: { info() {}, warn() {}, error() {}, log() {} },
        __cancelHostCalls() {}, __resumeHostCalls() {},
        __mindwtrCalendarCall: (input: unknown) => { providers.push(input); throw new Error('Event copy cannot call provider'); },
        __mindwtrNative: {
            sqlExec: (sql: string) => { writes.push(sql); database.exec(sql); return null; },
            sqlRun: (sql: string, params: string) => { writes.push(sql); database.query(sql).run(...JSON.parse(params)); return null; },
            sqlAll: (sql: string, params: string) => JSON.stringify(database.query(sql).all(...JSON.parse(params))),
            nowMs: () => Date.now(), randomBytes: (count: number) => JSON.stringify(Array(count).fill(7)), log() {},
            rnStateCommit: () => null, kvGet: (key: string) => JSON.stringify([kv.get(key) ?? null]),
            kvMultiGet: (names: string) => JSON.stringify(JSON.parse(names).map((name: string) => [name, kv.get(name) ?? null])),
            kvSet: (key: string, value: string) => { writes.push('kvSet'); kv.set(key, value); return null; },
            kvRemove: (key: string) => { writes.push('kvRemove'); kv.delete(key); return null; },
            fileList: () => 'null', fileRead: () => '', fileDelete: () => null,
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
        },
    };
    vm.runInNewContext(source, state);
    const poll = async (ticket: string) => {
        for (let step = 0; step < 200; step++) {
            const raw = state.MindwtrHost.poll(ticket);
            if (raw !== null) return JSON.parse(raw);
            await new Promise((done) => setTimeout(done, 0));
        }
        throw new Error('Event bridge did not settle');
    };
    const f = { state, database, writes, providers, kv, poll, log: () => logText,
        call: (name: string, input?: unknown) => poll(input === undefined ? state.MindwtrHost[name]() : state.MindwtrHost[name](JSON.stringify(input))),
        boot: async () => {
            expect(await poll(state.MindwtrHost.boot('', ''))).toMatchObject({ ok: true });
            state.fixture.install({ tasks: [], settings: { deviceId: 'fixture-device', diagnostics: { loggingEnabled } } });
            writes.length = 0; logText = '';
        },
    };
    fixtures.push(f); return f;
};

describe('actual exported iOS event-copy prepared bridges', () => {
    it('prepares with zero effects, validates the closed command, commits once and replays without another SQL write', async () => {
        const f = fixture(); await f.boot();
        const answer = await f.call('calendarEventTaskPrepare', request());
        expect(answer).toMatchObject({ ok: true, value: { kind: 'prepared', prepared: { kind: 'event' } } });
        expect(f.writes).toEqual([]);
        const command = { request: answer.value.prepared.request, prepared: answer.value.prepared };
        expect(await f.call('calendarEventTaskValidate', command)).toEqual({ ok: true, value: command.prepared.result });
        expect(f.writes).toEqual([]);
        expect(await f.call('calendarEventTaskCommit', command)).toEqual({ ok: true, value: command.prepared.result });
        const writes = [...f.writes];
        expect(writes.some((sql) => /INSERT.*tasks/i.test(sql))).toBe(true);
        expect(await f.call('calendarEventTaskCommit', command)).toEqual({ ok: true, value: command.prepared.result });
        expect(f.writes).toEqual(writes);
        expect(f.database.query('SELECT title, location, description, timeEstimate FROM tasks WHERE id = ?').get(request().requestId))
            .toEqual({ title: request().event.title, location: 'PRIVATE LOCATION', description: 'PRIVATE NOTES\n\nCalendar: PRIVATE CALENDAR', timeEstimate: 'custom:75' });
        expect(f.providers).toEqual([]); expect(f.kv.size).toBe(0); expect(f.log()).toBe('');
    });

    it('keeps prepare readiness and requireSaved while allowing pure validation of a retained command', async () => {
        const f = fixture();
        expect(await f.call('calendarEventTaskPrepare', request())).toMatchObject({ ok: false, error: expect.stringContaining('NOT_READY') });
        await f.boot();
        const answer = await f.call('calendarEventTaskPrepare', request());
        const command = { request: answer.value.prepared.request, prepared: answer.value.prepared };
        f.state.fixture.fail();
        expect(await f.call('calendarEventTaskPrepare', request())).toMatchObject({ ok: false, error: expect.stringContaining('SAVE_FAILED') });
        expect(await f.call('calendarEventTaskValidate', command)).toMatchObject({ ok: true });
        expect(f.writes).toEqual([]);
    });

    it('preserves public feed CANCELLED precedence and prepares the owned copy without provider work', async () => {
        const f = fixture(); await f.boot();
        const ticket = f.state.MindwtrHost.iosCalendarRead(JSON.stringify({ op: 'feed', slot: 'calendar',
            start: '2036-10-03T00:00:00.000Z', end: '2036-10-04T00:00:00.000Z' }));
        f.state.MindwtrHost.cancel(ticket);
        expect(await f.poll(ticket)).toMatchObject({ ok: false, error: expect.stringContaining('CANCELLED') });
        expect(await f.call('calendarEventTaskPrepare', request())).toMatchObject({ ok: true, value: { kind: 'prepared' } });
        expect(f.writes).toEqual([]); expect(f.providers).toEqual([]);
    });

    it('refuses forged effects and private source fields before writing', async () => {
        const f = fixture(); await f.boot();
        expect(await f.call('calendarEventTaskPrepare', { ...request(), event: { ...request().event, nativeEventId: 'PRIVATE_PROVIDER' } }))
            .toMatchObject({ ok: false, error: expect.stringContaining('INVALID_INPUT') });
        const answer = await f.call('calendarEventTaskPrepare', request());
        const command = { request: answer.value.prepared.request, prepared: answer.value.prepared };
        command.prepared.task.title = 'Forged';
        expect(await f.call('calendarEventTaskValidate', command)).toMatchObject({ ok: false, error: expect.stringContaining('INVALID_INPUT') });
        expect(await f.call('calendarEventTaskCommit', command)).toMatchObject({ ok: false, error: expect.stringContaining('INVALID_INPUT') });
        expect(f.writes).toEqual([]); expect(f.providers).toEqual([]);
    });

    it.each([true, false])('emits only the content-free native durable acknowledgment marker when logging=%s', async (enabled) => {
        const f = fixture(enabled); await f.boot();
        expect(await f.call('calendarEventTaskAcknowledged')).toEqual({ ok: true, value: null });
        const lines = f.log().trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
        expect(lines.filter((line) => line.message === 'Native iOS calendar event task created').map((line) => line.context))
            .toEqual(enabled ? [{ releaseCheck: 'v1.3.5/ios-calendar-event-task', outcome: 'confirmed' }] : []);
        expect(f.log()).not.toContain('PRIVATE'); expect(f.log()).not.toContain(request().requestId);
        expect(f.writes).toEqual([]); expect(f.providers).toEqual([]);
    });
});
