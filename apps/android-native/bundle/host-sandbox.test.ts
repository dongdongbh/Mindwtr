import { afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import vm from 'node:vm';
import { build } from 'esbuild';

const databases: Database[] = [];
let source: string;
beforeAll(async () => {
    const built = await build({
        stdin: { contents: `
            import './host-entry';
            import { useTaskStore } from '../../../packages/core/src/store';
            import { isSandboxMode } from '../../../packages/core/src/sandbox';
            globalThis.fixture = {
                addTask: (title) => useTaskStore.getState().addTask(title),
                addDatedTask: (title) => useTaskStore.getState().addTask(title, { dueDate: '2026-12-01' }),
                titles: () => useTaskStore.getState()._allTasks.filter((task) => !task.deletedAt).map((task) => task.title),
                sandbox: () => isSandboxMode(),
            };
        `, resolveDir: import.meta.dir, loader: 'ts' },
        bundle: true, write: false, format: 'iife', target: 'es2022', logLevel: 'silent',
    });
    source = built.outputFiles[0].text;
});
afterEach(() => { for (const database of databases.splice(0)) database.close(); });

type FixtureOptions = { kv?: Record<string, string>; calendarCall?: (request: { op: string }) => unknown; firesAtOnceMs?: number };

const fixture = (options: FixtureOptions = {}) => {
    const kv = options.kv ? new Map(Object.entries(options.kv)) : null;
    const firesAtOnce = (run: () => void, ms?: number) => setTimeout(run, ms === options.firesAtOnceMs ? 0 : ms);
    const database = new Database(':memory:'); databases.push(database);
    const sql = { statements: 0 };
    const logText = { value: '' };
    const calendarCalls: string[] = [];
    const state: Record<string, any> = {
        AbortController, URL, TextEncoder, TextDecoder, setTimeout: options.firesAtOnceMs ? firesAtOnce : setTimeout, clearTimeout,
        __mindwtrHostPlatform: 'android', console: { info() {}, warn() {}, error() {}, log() {} },
        __mindwtrCalendarCall: options.calendarCall ?? ((op: string) => { calendarCalls.push(op); return JSON.stringify({ ok: true, value: null }); }),
        __mindwtrNative: {
            sqlExec: (text: string) => { sql.statements += 1; database.exec(text); return null; },
            sqlRun: (text: string, params: string) => { sql.statements += 1; database.query(text).run(...JSON.parse(params)); return null; },
            sqlAll: (text: string, params: string) => { sql.statements += 1; return JSON.stringify(database.query(text).all(...JSON.parse(params))); },
            nowMs: () => Date.now(), randomBytes: (count: number) => JSON.stringify(Array(count).fill(7)),
            log: () => null, logFile: (operation: string, text: string) => {
                if (operation === 'write') logText.value = text;
                if (operation === 'append') logText.value += text;
                if (operation === 'read') return logText.value;
                if (operation === 'exists') return logText.value ? '1' : '';
                return ['path', 'ensure'].includes(operation) ? 'files/logs/mindwtr.log' : '';
            },
            rnStateCommit: () => null, kvGet: (key: string) => JSON.stringify([kv?.get(key) ?? null]),
            kvSet: (key: string, value: string) => { kv?.set(key, value); return null; }, kvRemove: (key: string) => { kv?.delete(key); return null; },
            kvMultiGet: (keys: string) => JSON.stringify((JSON.parse(keys) as string[]).map((key) => [key, kv?.get(key) ?? null])),
            kvMultiSet: (pairs: string) => { for (const [key, value] of JSON.parse(pairs) as [string, string][]) kv?.set(key, value); return null; },
            kvMultiRemove: (keys: string) => { for (const key of JSON.parse(keys) as string[]) kv?.delete(key); return null; },
            fileList: () => 'null', fileRead: () => '', fileDelete: () => null, hostEvent: () => null, debugProp: () => '',
        },
    };
    vm.runInNewContext(source, state);
    const poll = async (ticket: string) => {
        for (let step = 0; step < 500; step++) {
            const answer = state.MindwtrHost.poll(ticket);
            if (answer !== null) return JSON.parse(answer);
            await new Promise((done) => setTimeout(done, 0));
        }
        throw new Error('Host operation did not settle');
    };
    return { state, poll, sql, logText, calendarCalls };
};

describe('the Android Sandbox boot (RN #1196, #1273, #1340)', () => {
    const personal = async () => {
        const f = fixture();
        expect((await f.poll(f.state.MindwtrHost.boot('', '', 'journaled'))).ok).toBe(true);
        await f.state.fixture.addTask('Real task');
        return f;
    };

    it('asks core for a boot request that carries only the display settings', async () => {
        const f = await personal();
        const answer = await f.poll(f.state.MindwtrHost.sandboxRequest(JSON.stringify({ language: 'de', theme: 'dark' })));
        expect(answer.ok).toBe(true);
        const request = JSON.parse(answer.value.request);
        expect(request).toMatchObject({ version: 1, settings: { language: 'de', theme: 'dark' } });
        expect(Object.keys(request.settings).sort()).toEqual(['language', 'theme']);
        expect(Date.now() - request.requestedAt).toBeLessThan(5_000);
    });

    it('boots a fresh process on in-memory sample data in the requested language, without one SQLite statement', async () => {
        const source = await personal();
        const request = JSON.parse((await source.poll(source.state.MindwtrHost.sandboxRequest(JSON.stringify({ language: 'de' })))).value.request as string);
        const f = fixture();
        const booted = await f.poll(f.state.MindwtrHost.bootSandbox(JSON.stringify(request)));
        expect(booted).toMatchObject({ ok: true, value: { workspace: 'sandbox' } });
        expect(f.state.fixture.sandbox()).toBe(true);
        const titles = f.state.fixture.titles() as string[];
        expect(titles.length).toBeGreaterThan(5);
        expect(titles).not.toContain('Real task');
        await f.state.fixture.addTask('Sample edit');
        expect(f.state.fixture.titles()).toContain('Sample edit');
        expect(f.sql.statements).toBe(0);
        expect((await f.poll(f.state.MindwtrHost.backupLibraryBytes())).ok).toBe(false);
    });

    it('a background calendar push is unavailable in the sandbox and makes no calendar call (C4d)', async () => {
        const source = await personal();
        const request = JSON.parse((await source.poll(source.state.MindwtrHost.sandboxRequest('{}'))).value.request as string);
        const f = fixture();
        await f.poll(f.state.MindwtrHost.bootSandbox(JSON.stringify(request)));
        expect(await f.poll(f.state.MindwtrHost.calendarPushSnapshot())).toEqual({ ok: true, value: { token: null } });
        expect(await f.poll(f.state.MindwtrHost.calendarPushBackground('calendar-1'))).toEqual({ ok: true, value: { outcome: 'unavailable' } });
        const personalSnapshot = await source.poll(source.state.MindwtrHost.calendarPushSnapshot());
        expect(await source.poll(source.state.MindwtrHost.calendarPushBackground(personalSnapshot.value.token))).toEqual({ ok: true, value: { outcome: 'off' } });
        expect([...f.calendarCalls, ...source.calendarCalls]).toEqual([]);
    });

    it('a background calendar push that outlasts its 20 s limit answers timeout and leaves the host call deadline alone (C4d)', async () => {
        const asked: string[] = [];
        const f = fixture({ kv: { 'mindwtr:calendar-push-sync:enabled': '1' }, firesAtOnceMs: 20_000,
            calendarCall: (request) => { asked.push(request.op); return new Promise(() => {}); } });
        expect((await f.poll(f.state.MindwtrHost.boot('', '', 'journaled'))).ok).toBe(true);
        const snapshot = await f.poll(f.state.MindwtrHost.calendarPushSnapshot());
        await f.state.fixture.addDatedTask('Dated task');
        expect(await f.poll(f.state.MindwtrHost.calendarPushBackground(snapshot.value.token))).toEqual({ ok: true, value: { outcome: 'timeout' } });
        expect(asked.length).toBeGreaterThan(0);
    });

    it('boots personal from an expired, malformed or missing request', async () => {
        for (const raw of [JSON.stringify({ version: 1, requestedAt: Date.now() - 61_000, settings: {} }), '{', '']) {
            const f = fixture();
            expect(await f.poll(f.state.MindwtrHost.bootSandbox(raw))).toEqual({ ok: true, value: { workspace: 'personal' } });
            expect(f.state.fixture.sandbox()).toBe(false);
            expect((await f.poll(f.state.MindwtrHost.boot('', '', 'journaled'))).ok).toBe(true);
        }
    });

    it('writes the switch and exit lines to the diagnostics log even with Debug logging off', async () => {
        const f = await personal();
        const context = JSON.stringify({ releaseCheck: 'v1.3.9/native-sandbox', outcome: 'exited' });
        for (const message of ['Native Android sandbox switch requested', 'Native Android sandbox closed', 'Native Android other line']) {
            await f.poll(f.state.MindwtrHost.logLine(message, context));
        }
        for (let step = 0; step < 50 && !f.logText.value.includes('sandbox closed'); step++) await new Promise((done) => setTimeout(done, 10));
        expect(f.logText.value).toContain('Native Android sandbox switch requested');
        expect(f.logText.value).toContain('Native Android sandbox closed');
        expect(f.logText.value).not.toContain('Native Android other line');
    });

    it('refuses a second request while the first switch holds the workspace', async () => {
        const f = await personal();
        expect((await f.poll(f.state.MindwtrHost.sandboxRequest('{}'))).ok).toBe(true);
        expect(await f.poll(f.state.MindwtrHost.sandboxRequest('{}'))).toMatchObject({ ok: false });
        await f.poll(f.state.MindwtrHost.sandboxRelease());
        expect((await f.poll(f.state.MindwtrHost.sandboxRequest('{}'))).ok).toBe(true);
    });
});
