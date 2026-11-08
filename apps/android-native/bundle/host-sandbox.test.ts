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
                titles: () => useTaskStore.getState()._allTasks.filter((task) => !task.deletedAt).map((task) => task.title),
                sandbox: () => isSandboxMode(),
            };
        `, resolveDir: import.meta.dir, loader: 'ts' },
        bundle: true, write: false, format: 'iife', target: 'es2022', logLevel: 'silent',
    });
    source = built.outputFiles[0].text;
});
afterEach(() => { for (const database of databases.splice(0)) database.close(); });

const fixture = () => {
    const database = new Database(':memory:'); databases.push(database);
    const sql = { statements: 0 };
    const state: Record<string, any> = {
        AbortController, URL, TextEncoder, TextDecoder, setTimeout, clearTimeout,
        __mindwtrHostPlatform: 'android', console: { info() {}, warn() {}, error() {}, log() {} },
        __mindwtrNative: {
            sqlExec: (text: string) => { sql.statements += 1; database.exec(text); return null; },
            sqlRun: (text: string, params: string) => { sql.statements += 1; database.query(text).run(...JSON.parse(params)); return null; },
            sqlAll: (text: string, params: string) => { sql.statements += 1; return JSON.stringify(database.query(text).all(...JSON.parse(params))); },
            nowMs: () => Date.now(), randomBytes: (count: number) => JSON.stringify(Array(count).fill(7)),
            log: () => null, logFile: (operation: string) => (['path', 'ensure'].includes(operation) ? 'files/logs/mindwtr.log' : ''),
            rnStateCommit: () => null, kvGet: () => JSON.stringify([null]), kvSet: () => null, kvRemove: () => null,
            kvMultiGet: (keys: string) => JSON.stringify((JSON.parse(keys) as string[]).map((key) => [key, null])), kvMultiSet: () => null, kvMultiRemove: () => null,
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
    return { state, poll, sql };
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

    it('boots personal from an expired, malformed or missing request', async () => {
        for (const raw of [JSON.stringify({ version: 1, requestedAt: Date.now() - 61_000, settings: {} }), '{', '']) {
            const f = fixture();
            expect(await f.poll(f.state.MindwtrHost.bootSandbox(raw))).toEqual({ ok: true, value: { workspace: 'personal' } });
            expect(f.state.fixture.sandbox()).toBe(false);
            expect((await f.poll(f.state.MindwtrHost.boot('', '', 'journaled'))).ok).toBe(true);
        }
    });

    it('refuses a second request while the first switch holds the workspace', async () => {
        const f = await personal();
        expect((await f.poll(f.state.MindwtrHost.sandboxRequest('{}'))).ok).toBe(true);
        expect(await f.poll(f.state.MindwtrHost.sandboxRequest('{}'))).toMatchObject({ ok: false });
        await f.poll(f.state.MindwtrHost.sandboxRelease());
        expect((await f.poll(f.state.MindwtrHost.sandboxRequest('{}'))).ok).toBe(true);
    });
});
