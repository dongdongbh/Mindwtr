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
            globalThis.fixture = {
                addProject: (title, tagIds) => useTaskStore.getState().addProject(title, '#123456', { tagIds }),
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
    const logText = { value: '' };
    const state: Record<string, any> = {
        AbortController, URL, TextEncoder, TextDecoder, setTimeout, clearTimeout,
        __mindwtrHostPlatform: 'android', console: { info() {}, warn() {}, error() {}, log() {} },
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
    return { state, poll, sql, logText };
};

const ids = (groups: { projects: { title: string }[] }[]) => groups.flatMap(({ projects }) => projects.map(({ title }) => title));

describe('the Android Projects tag filter (RN projects-screen Tag filter row)', () => {
    it('reads core filtered projects with the tag inventory and the moves', async () => {
        const f = fixture();
        expect((await f.poll(f.state.MindwtrHost.boot('', '', 'journaled'))).ok).toBe(true);
        await f.state.fixture.addProject('Work one', ['#work']);
        await f.state.fixture.addProject('Home one', ['#home']);
        await f.state.fixture.addProject('Bare one', []);
        const all = await f.poll(f.state.MindwtrHost.projectList('__all__'));
        expect(all.ok).toBe(true);
        expect(all.value.tagInventory).toEqual({ values: ['#home', '#work'], hasUntagged: true });
        expect(ids(all.value.active).sort()).toEqual(['Bare one', 'Home one', 'Work one']);
        expect(Object.keys(all.value.moves).length).toBe(3);
        const work = await f.poll(f.state.MindwtrHost.projectList('#work'));
        expect(ids(work.value.active)).toEqual(['Work one']);
        expect(work.value.tagFilter).toBe('#work');
        expect(work.value.tagInventory).toEqual(all.value.tagInventory);
        expect(ids((await f.poll(f.state.MindwtrHost.projectList('__none__'))).value.active)).toEqual(['Bare one']);
    });
});
