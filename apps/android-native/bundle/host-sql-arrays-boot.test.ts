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
                seed: async () => {
                    const store = useTaskStore.getState();
                    const area = await store.addArea('Área ✓');
                    const project = await store.addProject('Projet "été"', '#123456', { areaId: area.id });
                    await store.addSection(project.id, 'Section\\u2028one');
                    await store.addTask('Plain', { status: 'next', tags: ['#a', '#b'], contexts: ['@home'], projectId: project.id });
                    await store.addTask('Notes', { description: 'line\\nbreak </b> \\\\ "q"', dueDate: '2026-11-28T09:00', timeEstimate: '30min' });
                    await store.addTask('中文 😀', { recurrence: { rule: 'weekly', strategy: 'fluid' }, checklist: [{ id: 'c1', title: 'x', isCompleted: true }] });
                },
                snapshot: () => {
                    const state = useTaskStore.getState();
                    return JSON.stringify({ tasks: state._allTasks, projects: state._allProjects, sections: state._allSections, areas: state._allAreas, settings: state.settings });
                },
            };
        `, resolveDir: import.meta.dir, loader: 'ts' },
        bundle: true, write: false, format: 'iife', target: 'es2022', logLevel: 'silent',
    });
    source = built.outputFiles[0].text;
});
afterEach(() => { for (const database of databases.splice(0)) database.close(); });

const host = (database: Database, arrays: boolean) => {
    const calls = { objects: 0, arrays: 0 };
    const native: Record<string, unknown> = {
        sqlExec: (sql: string) => { database.exec(sql); return null; },
        sqlRun: (sql: string, params: string) => { database.query(sql).run(...JSON.parse(params)); return null; },
        sqlAll: (sql: string, params: string) => { calls.objects += 1; return JSON.stringify(database.query(sql).all(...JSON.parse(params))); },
        nowMs: () => Date.now(), randomBytes: (count: number) => JSON.stringify(Array(count).fill(7)),
        log: () => null, logFile: (operation: string) => (['path', 'ensure'].includes(operation) ? 'files/logs/mindwtr.log' : ''),
        rnStateCommit: () => null, kvGet: () => JSON.stringify([null]), kvSet: () => null, kvRemove: () => null,
        kvMultiGet: (keys: string) => JSON.stringify((JSON.parse(keys) as string[]).map((key) => [key, null])), kvMultiSet: () => null, kvMultiRemove: () => null,
        fileList: () => 'null', fileRead: () => '', fileDelete: () => null, hostEvent: () => null, debugProp: () => '',
    };
    if (arrays) {
        native.sqlAllArrays = (sql: string, params: string) => {
            calls.arrays += 1;
            const query = database.query(sql);
            const rows = query.values(...JSON.parse(params));
            return JSON.stringify([query.columnNames, ...rows]);
        };
    }
    const state: Record<string, any> = {
        AbortController, URL, TextEncoder, TextDecoder, setTimeout, clearTimeout,
        __mindwtrHostPlatform: 'android', console: { info() {}, warn() {}, error() {}, log() {} },
        __mindwtrNative: native,
    };
    vm.runInNewContext(source, state);
    const poll = async (ticket: string) => {
        for (let step = 0; step < 20000; step++) {
            const answer = state.MindwtrHost.poll(ticket);
            if (answer !== null) return JSON.parse(answer);
            await new Promise((done) => setTimeout(done, 0));
        }
        throw new Error('Host operation did not settle');
    };
    return { state, poll, calls };
};

describe('native Android SQL reads through the array reply', () => {
    it('boots the same store from array replies as from object replies, and reads only through the array reply when the host has it', async () => {
        const database = new Database(':memory:'); databases.push(database);
        const writer = host(database, false);
        expect((await writer.poll(writer.state.MindwtrHost.boot('', '', 'journaled'))).ok).toBe(true);
        await writer.state.fixture.seed();
        database.exec("UPDATE tasks SET title = '', tags = '{bad json', contexts = '', orderNum = -0.0, pushCount = 9007199254740993 WHERE title = 'Notes'");

        const objects = host(database, false);
        expect((await objects.poll(objects.state.MindwtrHost.boot('', '', 'journaled'))).ok).toBe(true);
        const arrays = host(database, true);
        expect((await arrays.poll(arrays.state.MindwtrHost.boot('', '', 'journaled'))).ok).toBe(true);

        expect(JSON.parse(objects.state.fixture.snapshot()).tasks).toHaveLength(3);
        expect(arrays.state.fixture.snapshot()).toBe(objects.state.fixture.snapshot());
        expect(arrays.calls.objects).toBe(0);
        expect(arrays.calls.arrays).toBeGreaterThan(5);
    });
});
