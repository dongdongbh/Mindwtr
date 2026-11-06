


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
                addArea: (name) => useTaskStore.getState().addArea(name),
                areas: () => useTaskStore.getState()._allAreas.filter((area) => !area.deletedAt).map((area) => ({ id: area.id, name: area.name })),
            };
        `, resolveDir: import.meta.dir, loader: 'ts' },
        bundle: true, write: false, format: 'iife', target: 'es2022', logLevel: 'silent',
    });
    source = built.outputFiles[0].text;
});
afterEach(() => { for (const database of databases.splice(0)) database.close(); });

const fixture = () => {
    const database = new Database(':memory:'); databases.push(database);
    const state: Record<string, any> = {
        AbortController, URL, TextEncoder, TextDecoder, setTimeout, clearTimeout,
        __mindwtrHostPlatform: 'android', console: { info() {}, warn() {}, error() {}, log() {} },
        __mindwtrNative: {
            sqlExec: (sql: string) => { database.exec(sql); return null; },
            sqlRun: (sql: string, params: string) => { database.query(sql).run(...JSON.parse(params)); return null; },
            sqlAll: (sql: string, params: string) => JSON.stringify(database.query(sql).all(...JSON.parse(params))),
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
    return { state, poll };
};

describe('the Projects list Area rename host binding (RN 8b31620e4)', () => {
    it('checks the typed name and refuses a taken one, then stores a free name once', async () => {
        const f = fixture();
        expect((await f.poll(f.state.MindwtrHost.boot('', '', 'journaled'))).ok).toBe(true);
        await f.state.fixture.addArea('Work');
        await f.state.fixture.addArea('Home');
        const work = f.state.fixture.areas().find((area: { name: string }) => area.name === 'Work').id;
        const read = async (name: string) => f.poll(f.state.MindwtrHost.menuRead('areaRenameCheck', JSON.stringify({ areaId: work, name })));
        expect(await read('home')).toMatchObject({ ok: true, value: { nameTaken: true, saveDisabled: true } });
        expect(await read('Office')).toMatchObject({ ok: true, value: { nameTaken: false, saveDisabled: false } });
        const rename = async (name: string, requestId: string) =>
            f.poll(f.state.MindwtrHost.menuCommand('areaRename', JSON.stringify({ requestId, areaId: work, name })));
        expect(await rename(' HOME ', '00000000-0000-4000-8000-000000001481')).toMatchObject({ ok: true, value: { outcome: 'taken' } });
        expect(await rename('Office', '00000000-0000-4000-8000-000000001482')).toMatchObject({ ok: true, value: { outcome: 'saved', name: 'Office' } });
        expect(f.state.fixture.areas().map((area: { name: string }) => area.name).sort()).toEqual(['Home', 'Office']);
    });
});
