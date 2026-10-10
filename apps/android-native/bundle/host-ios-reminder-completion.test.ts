import { afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { build } from 'esbuild';
import vm from 'node:vm';

const now = Date.parse('2026-10-08T12:00:00.000Z');
const requestId = 'abcdefab-cdef-4abc-8abc-abcdefabcdef';
const request = { requestId, taskId: 'PRIVATE_TASK' };
const confirmed = { ok: true, value: { changed: true, outcome: 'completed' } };
let source = '';
const databases: Database[] = [];
beforeAll(async () => {
    const built = await build({ stdin: { contents: `
        import './host-entry';
        import { useTaskStore, getStorageAdapter, flushPendingSave } from '../../../packages/core/src/store';
        globalThis.fixture = {
            seed: async () => {
                await getStorageAdapter().saveData({tasks:[{id:'PRIVATE_TASK',title:'PRIVATE_TITLE',status:'next',
                    isFocusedToday:true,tags:[],contexts:[],createdAt:new Date(${now}).toISOString(),
                    updatedAt:new Date(${now}).toISOString(),dueDate:'2026-10-09T12:00:00.000Z',
                    recurrence:{rule:'daily',strategy:'strict'}}],projects:[],sections:[],areas:[],people:[],settings:{}});
                await useTaskStore.getState().fetchData({throwOnError:true}); await flushPendingSave();
            },
            reopen: async () => { await useTaskStore.getState().updateTask('PRIVATE_TASK',
                {status:'next',description:'PRIVATE_LATER_EDIT'}); await flushPendingSave(); },
            remove: async () => { await useTaskStore.getState().deleteTask('PRIVATE_TASK'); await flushPendingSave(); },
            restore: async () => { await useTaskStore.getState().restoreTask('PRIVATE_TASK'); await flushPendingSave(); },
            complete: async () => { await useTaskStore.getState().updateTask('PRIVATE_TASK', {status:'done'}); await flushPendingSave(); },
            flush: flushPendingSave,
        };`, resolveDir: import.meta.dir, loader: 'ts' }, bundle: true, write: false,
        format: 'iife', target: 'es2022', logLevel: 'silent' });
    source = built.outputFiles[0].text;
});
afterEach(() => { databases.splice(0).forEach((database) => database.close()); });

type Reply = { ok: boolean; value?: unknown; error?: string };
type Host = {
    boot(state: string, backup: string): string;
    poll(id: string): string | null;
    reminderCompletionCommit(json: string): string;
    reminderCompletionProbe(json: string): string;
    reminderCompletionRetry(json: string): string;
    reminderCompletionAcknowledged(): string;
};
const fixture = () => {
    const database = new Database(':memory:'); databases.push(database);
    const writes: string[] = [];
    let log = '', failLog = false;
    const launch = () => {
        const state = { AbortController, URL, TextEncoder, TextDecoder, setTimeout, clearTimeout,
            Date: new Proxy(Date, { construct: (target, args) => Reflect.construct(target, args.length ? args : [now]),
                get: (target, property) => property === 'now' ? () => now : Reflect.get(target, property) }),
            __mindwtrHostPlatform: 'ios', console: { log() {}, info() {}, warn() {}, error() {} },
            MindwtrHost: undefined as unknown as Host,
            fixture: undefined as unknown as { seed(): Promise<void>; reopen(): Promise<void>; flush(): Promise<void>;
                remove(): Promise<void>; restore(): Promise<void>; complete(): Promise<void> },
            __mindwtrNative: {
                sqlExec: (sql: string) => { writes.push(sql); database.exec(sql); return null; },
                sqlRun: (sql: string, params: string) => { writes.push(sql); database.query(sql).run(...JSON.parse(params)); return null; },
                sqlAll: (sql: string, params: string) => JSON.stringify(database.query(sql).all(...JSON.parse(params))),
                nowMs: () => now, randomBytes: (n: number) => JSON.stringify(Array(n).fill(7)), log: () => {}, rnStateCommit: () => null,
                kvGet: () => '[null]', kvMultiGet: () => '[]', kvSet: () => null, kvRemove: () => null,
                fileList: () => 'null', fileRead: () => '', fileDelete: () => null,
                logFile: (operation: string, text: string) => {
                    if (failLog) throw new Error('PRIVATE_LOG_ERROR');
                    if (['path', 'ensure'].includes(operation)) return 'files/logs/mindwtr.log';
                    if (operation === 'size') return String(log.length); if (operation === 'read') return log;
                    if (operation === 'exists') return log ? '1' : ''; if (operation === 'isAbsent') return log ? '' : '1';
                    if (operation === 'append') { log += text; return ''; } if (operation === 'write') { log = text; return ''; }
                    if (operation === 'delete') { log = ''; return '1'; } throw new Error('Unexpected diagnostic operation');
                },
            } };
        vm.runInNewContext(source, state);
        const poll = async (id: string): Promise<Reply> => {
            for (let step = 0; step < 100; step++) {
                const value = state.MindwtrHost.poll(id);
                if (value !== null) return JSON.parse(value);
                await new Promise((done) => setTimeout(done, 0));
            }
            throw new Error('Reminder completion bridge did not settle');
        };
        const boot = async () => {
            expect(await poll(state.MindwtrHost.boot('', ''))).toMatchObject({ ok: true });
            writes.length = 0; log = '';
        };
        return { state, poll, boot };
    };
    return { database, writes, launch, log: () => log, failLog: () => { failLog = true; } };
};

describe('actual iOS reminder Complete bridge and SQLite receipt boot', () => {
    it('commits once, loads its actual durable iOS receipt on cold boot, and preserves a later reopen', async () => {
        const f = fixture(), first = f.launch(); await first.boot(); await first.state.fixture.seed();
        expect(await first.poll(first.state.MindwtrHost.reminderCompletionCommit(JSON.stringify(request)))).toEqual(confirmed);
        expect(f.database.query('SELECT request_id FROM native_request_receipts').all()).toEqual([{ request_id: requestId }]);
        expect(f.log()).not.toContain('ios-reminder-complete');
        await first.state.fixture.reopen();
        const before = f.database.query('SELECT * FROM tasks ORDER BY id').all();
        const cold = f.launch(); await cold.boot();
        expect(await cold.poll(cold.state.MindwtrHost.reminderCompletionProbe(JSON.stringify(request)))).toEqual(confirmed);
        expect(await cold.poll(cold.state.MindwtrHost.reminderCompletionRetry(JSON.stringify(request)))).toEqual(confirmed);
        expect(await cold.poll(cold.state.MindwtrHost.reminderCompletionCommit(JSON.stringify(request)))).toEqual(confirmed);
        expect(f.writes).toEqual([]); expect(f.database.query('SELECT * FROM tasks ORDER BY id').all()).toEqual(before);
        expect(f.log()).not.toContain('ios-reminder-complete');
    });

    it.each(['task-not-found', 'task-deleted', 'not-actionable'])('cold iOS boot preserves the original %s receipt after later task changes', async (outcome) => {
        const f = fixture(), first = f.launch(); await first.boot();
        if (outcome !== 'task-not-found') await first.state.fixture.seed();
        if (outcome === 'task-deleted') await first.state.fixture.remove();
        if (outcome === 'not-actionable') await first.state.fixture.complete();
        const original = { ok: true, value: { changed: false, outcome } };
        expect(await first.poll(first.state.MindwtrHost.reminderCompletionCommit(JSON.stringify(request)))).toEqual(original);
        expect(f.database.query('SELECT request_id FROM native_request_receipts').all()).toEqual([{ request_id: requestId }]);
        if (outcome === 'task-not-found') await first.state.fixture.seed();
        else if (outcome === 'task-deleted') await first.state.fixture.restore();
        else await first.state.fixture.reopen();
        const before = f.database.query('SELECT * FROM tasks ORDER BY id').all();
        expect(f.database.query('SELECT status FROM tasks WHERE id = ?').get(request.taskId)).toEqual({ status: 'next' });
        const cold = f.launch(); await cold.boot();
        for (const method of ['reminderCompletionProbe', 'reminderCompletionRetry', 'reminderCompletionCommit'] as const) {
            expect(await cold.poll(cold.state.MindwtrHost[method](JSON.stringify(request)))).toEqual(original);
        }
        expect(f.writes).toEqual([]); expect(f.database.query('SELECT * FROM tasks ORDER BY id').all()).toEqual(before);
        expect(f.log()).not.toContain('ios-reminder-complete');
    });

    it('unknown probe/retry and malformed closed requests never mutate or save', async () => {
        const f = fixture(), active = f.launch(); await active.boot(); await active.state.fixture.seed();
        f.writes.length = 0;
        const before = f.database.query('SELECT * FROM tasks ORDER BY id').all();
        for (const method of ['reminderCompletionProbe', 'reminderCompletionRetry'] as const) {
            expect(await active.poll(active.state.MindwtrHost[method](JSON.stringify(request))))
                .toMatchObject({ ok: false, error: expect.stringContaining('STALE_REVISION:') });
        }
        for (const bad of ['PRIVATE_BAD_JSON', '[]', 'null', '{}', JSON.stringify({ ...request, extra: true }),
            JSON.stringify({ ...request, requestId: requestId.toUpperCase() }), JSON.stringify({ ...request, taskId: '' }),
            JSON.stringify({ ...request, taskId: 'x'.repeat(501) }), JSON.stringify({ ...request, taskId: '😀'.repeat(251) })]) {
            for (const method of ['reminderCompletionCommit', 'reminderCompletionProbe', 'reminderCompletionRetry'] as const) {
                expect(await active.poll(active.state.MindwtrHost[method](bad)))
                    .toMatchObject({ ok: false, error: expect.stringContaining('INVALID_INPUT:') });
            }
        }
        expect(f.writes).toEqual([]); expect(f.database.query('SELECT * FROM tasks ORDER BY id').all()).toEqual(before);
        expect(f.database.query('SELECT request_id FROM native_request_receipts').all()).toEqual([]);
        expect(f.log()).not.toContain('ios-reminder-complete');
    });

    it('bounds raw JSON by UTF8 bytes while accepting exactly 4096 bytes and 500 UTF16 task units', async () => {
        const f = fixture(), active = f.launch(); await active.boot();
        for (const taskId of ['漢'.repeat(500), '😀'.repeat(250)]) {
            const json = JSON.stringify({ ...request, taskId });
            const exact = json + ' '.repeat(4096 - new TextEncoder().encode(json).byteLength);
            expect(new TextEncoder().encode(exact).byteLength).toBe(4096);
            expect(await active.poll(active.state.MindwtrHost.reminderCompletionProbe(exact)))
                .toMatchObject({ ok: false, error: expect.stringContaining('STALE_REVISION:') });
            for (const method of ['reminderCompletionCommit', 'reminderCompletionProbe', 'reminderCompletionRetry'] as const) {
                expect(await active.poll(active.state.MindwtrHost[method](exact + ' ')))
                    .toMatchObject({ ok: false, error: expect.stringContaining('INVALID_INPUT:') });
            }
        }
        expect(f.writes).toEqual([]); expect(f.log()).not.toContain('ios-reminder-complete');
    });

    it('emits only the fixed acknowledgment marker on the explicit terminal port, surviving logger failure', async () => {
        const f = fixture(), active = f.launch(); await active.boot(); await active.state.fixture.seed();
        expect(await active.poll(active.state.MindwtrHost.reminderCompletionCommit(JSON.stringify(request)))).toEqual(confirmed);
        expect(await active.poll(active.state.MindwtrHost.reminderCompletionProbe(JSON.stringify(request)))).toEqual(confirmed);
        expect(await active.poll(active.state.MindwtrHost.reminderCompletionRetry(JSON.stringify(request)))).toEqual(confirmed);
        expect(f.log()).not.toContain('ios-reminder-complete');
        expect(await active.poll(active.state.MindwtrHost.reminderCompletionAcknowledged())).toEqual({ ok: true, value: null });
        const entries = f.log().trim().split('\n').map((line) => JSON.parse(line));
        const marker = entries.filter((entry) => entry.context?.releaseCheck === 'v1.3.5/ios-reminder-complete');
        expect(marker).toHaveLength(1);
        expect(marker[0].message).toBe('Native iOS reminder completion acknowledged');
        expect(marker[0].context).toEqual({ releaseCheck: 'v1.3.5/ios-reminder-complete', outcome: 'confirmed' });
        expect(marker[0].scope).toBe('native-ios');
        expect(JSON.stringify(marker)).not.toContain('PRIVATE'); expect(JSON.stringify(marker)).not.toContain(requestId);
        f.failLog();
        expect(await active.poll(active.state.MindwtrHost.reminderCompletionAcknowledged())).toEqual({ ok: true, value: null });
        expect(f.log().trim().split('\n')).toHaveLength(entries.length);
    });
});
