import { afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import vm from 'node:vm';
import { build } from 'esbuild';

let source: string;
const fixtures: ReturnType<typeof fixture>[] = [];
beforeAll(async () => {
    const built = await build({ stdin: { contents: `
        import './host-entry';
        import { useTaskStore, flushPendingSave, resetForTests } from '../../../packages/core/src/store';
        import { revisionOf } from '../../../packages/core/src/native-request-receipts';
        globalThis.fixture = {
            seed: async () => {
                const store = useTaskStore.getState();
                await store.addTask('PRIVATE_TRIP', { checklist: [
                    { id: 'one', title: 'PRIVATE_ONE', isCompleted: true },
                    { id: 'two', title: 'PRIVATE_TWO', isCompleted: false }] });
                const source = await store.addProject('PRIVATE_SOURCE', '#112233');
                const destination = await store.addProject('PRIVATE_DESTINATION', '#445566');
                await useTaskStore.getState().addTask('PRIVATE_MOVED', { projectId: source.id, status: 'next' });
                await flushPendingSave();
                const task = useTaskStore.getState()._allTasks.find((row) => row.title === 'PRIVATE_TRIP');
                return { taskId: task.id, sourceId: source.id, destinationId: destination.id };
            },
            revision: (id) => revisionOf(useTaskStore.getState()._projectsById.get(id)),
            flush: flushPendingSave, reset: resetForTests,
        };
    `, resolveDir: import.meta.dir, loader: 'ts' }, bundle: true, write: false, format: 'iife', target: 'es2022', logLevel: 'silent' });
    source = built.outputFiles[0].text;
});
afterEach(async () => {
    for (const f of fixtures.splice(0)) { await f.state.fixture.flush(); f.state.fixture.reset(); f.database.close(); }
});
const fixture = (platform = 'ios') => {
    const database = new Database(':memory:'); let logText = ''; const writes: string[] = [];
    const state: Record<string, any> = {
        AbortController, URL, TextEncoder, TextDecoder, setTimeout, clearTimeout,
        __mindwtrHostPlatform: platform, console: { info() {}, warn() {}, error() {}, log() {} },
        __mindwtrNative: {
            sqlExec: (sql: string) => { writes.push(sql); database.exec(sql); return null; },
            sqlRun: (sql: string, params: string) => { writes.push(sql); database.query(sql).run(...JSON.parse(params)); return null; },
            sqlAll: (sql: string, params: string) => JSON.stringify(database.query(sql).all(...JSON.parse(params))),
            nowMs: () => Date.now(), randomBytes: (n: number) => JSON.stringify(Array.from({ length: n }, (_, i) => (i * 37 + writes.length) % 256)), log() {},
            rnStateCommit: () => null, kvGet: () => '[null]', kvSet: () => null, kvRemove: () => null,
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
                throw new Error('Unexpected log operation');
            },
        },
    };
    vm.runInNewContext(source, state);
    const poll = async (ticket: string) => {
        for (let i = 0; i < 400; i++) {
            const value = state.MindwtrHost.poll(ticket);
            if (value !== null) return JSON.parse(value);
            await new Promise(done => setTimeout(done, 0));
        }
        throw new Error('Conversion bridge did not settle');
    };
    const f = { state, database, writes, log: () => logText,
        call: (name: string, input?: unknown) => poll(input === undefined ? state.MindwtrHost[name]() : state.MindwtrHost[name](JSON.stringify(input))),
        boot: async () => {
            expect(await poll(state.MindwtrHost.boot('', ''))).toMatchObject({ ok: true });
            const ids = await state.fixture.seed(); writes.length = 0; logText = ''; return ids as { taskId: string; sourceId: string; destinationId: string };
        },
        rows: (table: string) => database.query(`SELECT * FROM ${table}`).all() as Record<string, unknown>[],
    };
    fixtures.push(f); return f;
};
const confirmations = (log: string, message: string) => log.trim().split('\n').filter(Boolean)
    .map(line => JSON.parse(line)).filter(entry => entry.message === message);

describe('actual exported iOS conversion bridge', () => {
    it('expands a checklist durably, replays without SQL and undoes through the frozen promotion', async () => {
        const f = fixture(); const { taskId } = await f.boot();
        const view = await f.call('taskView', { id: taskId });
        expect(await f.call('taskPromoteOptions', { taskId, taskRevision: view.value.taskRevision })).toEqual({ ok: true, value: { blockedMessage: null } });
        const request = { requestId: '00000000-0000-4000-8000-000000001355', taskId, taskRevision: view.value.taskRevision,
            title: 'PRIVATE_PROJECT', expandChecklist: true };
        const planned = await f.call('prepareTaskPromotion', request);
        expect(planned).toMatchObject({ ok: true, value: { kind: 'prepared', prepared: { version: 2 } } });
        expect(f.writes).toEqual([]);
        const envelope = { request, prepared: planned.value.prepared };
        expect(await f.call('validatePreparedTaskPromotion', envelope)).toEqual({ ok: true, value: { id: request.requestId, reused: false } });
        expect(await f.call('taskPromoteCommit', envelope)).toEqual({ ok: true, value: { id: request.requestId, reused: false } });
        const generated = f.rows('tasks').filter(row => row.projectId === request.requestId);
        expect(generated.map(row => [row.title, row.status])).toEqual([['PRIVATE_ONE', 'done'], ['PRIVATE_TWO', 'next']]);
        const writes = [...f.writes];
        expect(await f.call('taskPromoteCommit', envelope)).toEqual({ ok: true, value: { id: request.requestId, reused: false } });
        expect(f.writes).toEqual(writes);

        const undoRequest = { requestId: '00000000-0000-4000-8000-000000001356', promoteRequestId: request.requestId };
        const undoPlan = await f.call('taskPromoteUndoPrepare', { request: undoRequest, promote: envelope });
        expect(undoPlan).toMatchObject({ ok: true, value: { kind: 'prepared' } });
        const undo = { request: undoRequest, prepared: undoPlan.value.prepared };
        expect(await f.call('taskPromoteUndoValidate', undo)).toEqual({ ok: true, value: { id: taskId } });
        expect(await f.call('taskPromoteUndoCommit', undo)).toEqual({ ok: true, value: { id: taskId } });
        expect(f.rows('tasks').find(row => row.id === taskId)?.deletedAt).toBeNull();
        await f.call('logShare');
        const entries = confirmations(f.log(), 'Native checklist project conversion confirmed');
        expect(entries.map(entry => entry.context.operation)).toEqual(['convert', 'convert', 'undo']);
        for (const entry of entries) expect(entry.context).toMatchObject({ releaseCheck: 'v1.3.9/ios-checklist-project', count: '2', outcome: 'confirmed' });
        expect(JSON.stringify(entries)).not.toContain('PRIVATE');
    });

    it('previews without SQL, converts a project to a section and undoes it', async () => {
        const f = fixture(); const { sourceId, destinationId } = await f.boot();
        const projectRevision = f.state.fixture.revision(sourceId);
        const options = await f.call('projectToSectionOptions', { projectId: sourceId, projectRevision });
        expect(options).toMatchObject({ ok: true, value: { blockedMessage: null } });
        expect(f.writes).toEqual([]);
        const destination = options.value.destinations.find((row: { id: string }) => row.id === destinationId);
        const request = { requestId: '00000000-0000-4000-8000-000000001324', projectId: sourceId, projectRevision,
            destinationProjectId: destinationId, destinationRevision: destination.revision, title: 'PRIVATE_SECTION' };
        const planned = await f.call('projectToSectionPrepare', request);
        expect(planned).toMatchObject({ ok: true, value: { kind: 'prepared' } });
        expect(f.writes).toEqual([]);
        const envelope = { request, prepared: planned.value.prepared };
        expect(await f.call('projectToSectionValidate', envelope)).toMatchObject({ ok: true, value: { sectionId: request.requestId } });
        expect(await f.call('projectToSectionCommit', envelope)).toMatchObject({ ok: true, value: { sectionId: request.requestId, destinationProjectId: destinationId } });
        expect(f.rows('sections').map(row => [row.id, row.projectId])).toEqual([[request.requestId, destinationId]]);
        const writes = [...f.writes];
        expect(await f.call('projectToSectionCommit', envelope)).toMatchObject({ ok: true });
        expect(f.writes).toEqual(writes);
        const undoRequest = { requestId: '00000000-0000-4000-8000-000000001325', convertRequestId: request.requestId };
        const undoPlan = await f.call('projectToSectionUndoPrepare', { request: undoRequest, convert: envelope });
        const undo = { request: undoRequest, prepared: undoPlan.value.prepared };
        expect(await f.call('projectToSectionUndoValidate', undo)).toEqual({ ok: true, value: { id: sourceId } });
        expect(await f.call('projectToSectionUndoCommit', undo)).toEqual({ ok: true, value: { id: sourceId } });
        expect(f.rows('projects').find(row => row.id === sourceId)?.deletedAt).toBeNull();
        await f.call('logShare');
        const entries = confirmations(f.log(), 'Native project to section conversion confirmed');
        expect(entries.map(entry => entry.context.operation)).toEqual(['convert', 'convert', 'undo']);
        expect(JSON.stringify(entries)).not.toContain('PRIVATE');
    });

    it('refuses conversion methods on Android before SQL', async () => {
        const f = fixture('android'); const { sourceId } = await f.boot();
        expect(await f.call('projectToSectionOptions', { projectId: sourceId, projectRevision: 'x' }))
            .toEqual({ ok: false, error: expect.stringContaining('requires iOS') });
        expect(f.writes).toEqual([]);
    });
});
