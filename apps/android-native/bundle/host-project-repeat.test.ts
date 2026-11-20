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
                addProject: (title) => useTaskStore.getState().addProject(title, '#123456'),
                projects: () => useTaskStore.getState()._allProjects.filter((row) => !row.deletedAt)
                    .map((row) => ({ id: row.id, status: row.status, startDate: row.startDate, repeatAfterCount: row.repeatAfterCount, repeatAfterUnit: row.repeatAfterUnit })),
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

describe('native Android Project details repeat (RN ProjectDetailModal)', () => {
    it('reads and saves the repeat interval, then Complete saves one next run', async () => {
        const f = fixture();
        expect((await f.poll(f.state.MindwtrHost.boot('', '', 'journaled'))).ok).toBe(true);
        const id = (await f.state.fixture.addProject('Routine')).id;
        const read = async () => f.poll(f.state.MindwtrHost.menuRead('projectRepeatOptions', JSON.stringify({ projectId: id })));
        expect(await read()).toEqual({ ok: true, value: { count: null, unit: null, units: ['day', 'week', 'month', 'year'], maxCount: 1200, canEdit: true } });
        const edit = async (requestId: string, fields: Record<string, unknown>) =>
            f.poll(f.state.MindwtrHost.menuCommand('projectEdit', JSON.stringify({ requestId, projectId: id, ...fields })));
        expect(await edit('00000000-0000-4000-8000-000000001501', { kind: 'repeat', count: 2, unit: 'week' }))
            .toMatchObject({ ok: true, value: { outcome: 'saved' } });
        expect(await read()).toMatchObject({ ok: true, value: { count: 2, unit: 'week' } });
        const complete = { kind: 'lifecycle', action: 'complete' };
        expect(await edit('00000000-0000-4000-8000-000000001502', complete)).toMatchObject({ ok: true, value: { outcome: 'saved' } });
        expect(await edit('00000000-0000-4000-8000-000000001502', complete)).toMatchObject({ ok: true });
        const projects = f.state.fixture.projects();
        expect(projects.find((row: { id: string }) => row.id === id)).toMatchObject({ status: 'archived' });
        expect(projects.filter((row: { id: string }) => row.id !== id)).toMatchObject([{ status: 'active', repeatAfterCount: 2, repeatAfterUnit: 'week' }]);
    });
});
