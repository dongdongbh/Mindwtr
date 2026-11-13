import { afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import vm from 'node:vm';
import { build } from 'esbuild';
import { dirname, resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { androidHostEntry } from '../scripts/android-host-table.mjs';

let source: string;
const fixtures: ReturnType<typeof fixture>[] = [];
beforeAll(async () => {
    const built = await build({ stdin: { contents: `
        import './host-entry';
        import { useTaskStore, flushPendingSave, resetForTests } from '../../../packages/core/src/store';
        import { createProjectCalendarReferenceMethods } from '../../../packages/core/src/native-host-contract-project-calendar-reference';
        globalThis.fixture = {
            issue: async () => {
                const calendars = [{ id: 'feed', name: 'Calendar', url: 'https://synthetic.invalid/feed.ics', enabled: true }];
                await useTaskStore.getState().updateSettings({ externalCalendars: calendars });
                const project = await useTaskStore.getState().addProject('PRIVATE_PROJECT', '#94a3b8');
                if (!project) throw new Error('Missing project');
                await flushPendingSave();
                const event = { id: 'event', sourceId: 'feed', calendarSourceId: 'feed', uid: 'PRIVATE_UID', title: 'PRIVATE_EVENT',
                    start: new Date(Date.now() + 60000).toISOString(), end: new Date(Date.now() + 120000).toISOString(), allDay: false };
                const methods = createProjectCalendarReferenceMethods({ readiness: () => ({ ok: true, value: null }),
                    revision: () => 'revision', formatDate: (reference) => 'label:' + reference.start, save: async () => { await flushPendingSave(); return { ok: true, value: null }; },
                    load: async () => ({ ok: true, value: { status: 'ready', calendars, events: [event] } }) });
                const options = await methods.getProjectCalendarReferenceOptions({ projectId: project.id });
                if (!options.ok) throw new Error('Missing picker');
                const { id, ...expected } = options.value.project;
                const request = { requestId: '00000000-0000-4000-8000-000000001550', projectId: id,
                    pickerId: options.value.pickerId, value: options.value.candidates[0], expected };
                const prepared = methods.prepareProjectCalendarReference(request);
                if (!prepared.ok || prepared.value.kind !== 'prepared') throw new Error('Missing prepared command');
                return JSON.parse(JSON.stringify({ request, prepared: prepared.value.prepared }));
            }, flush: flushPendingSave, reset: resetForTests,
        };
    `, resolveDir: import.meta.dir, loader: 'ts' }, alias: { '@mindwtr/core': resolve(import.meta.dir, '../../../packages/core/src/index.ts') },
        bundle: true, write: false, format: 'iife', target: 'es2022', logLevel: 'silent',
        plugins: [{ name: 'production-android-host-table', setup(builder) {
            builder.onLoad({ filter: /bundle[\\/]host-entry\.ts$/ }, (args) => ({
                contents: androidHostEntry(readFileSync(args.path, 'utf8')), loader: 'ts', resolveDir: dirname(args.path),
            }));
        } }] });
    source = built.outputFiles[0].text;
});
afterEach(async () => {
    const closed = new Set<Database>();
    for (const f of fixtures.splice(0)) {
        await f.state.fixture.flush(); f.state.fixture.reset();
        if (!closed.has(f.database)) { f.database.close(); closed.add(f.database); }
    }
});
const fixture = (database = new Database(':memory:')) => {
    let counter = 0, rejected = false, logText = '';
    const writes: string[] = [];
    const run = (sql: string, work: () => unknown) => {
        writes.push(sql);
        if (rejected && sql.trim().toUpperCase() === 'COMMIT') throw new Error('Injected COMMIT failure');
        return work();
    };
    const state: Record<string, any> = {
        AbortController, URL, TextEncoder, TextDecoder, setTimeout, clearTimeout,
        __mindwtrHostPlatform: 'android', console: { info() {}, warn() {}, error() {}, log() {} },
        __mindwtrNative: {
            sqlExec: (sql: string) => run(sql, () => { database.exec(sql); return null; }),
            sqlRun: (sql: string, params: string) => run(sql, () => { database.query(sql).run(...JSON.parse(params)); return null; }),
            sqlAll: (sql: string, params: string) => JSON.stringify(database.query(sql).all(...JSON.parse(params))),
            nowMs: () => Date.now(), randomBytes: (n: number) => JSON.stringify(Array.from({ length: n }, () => ++counter % 256)), log() {},
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
        for (let i = 0; i < 2000; i++) {
            const answer = state.MindwtrHost.poll(ticket);
            if (answer !== null) return JSON.parse(answer);
            await new Promise(done => setTimeout(done, 0));
        }
        throw new Error('Calendar reference bridge did not settle');
    };
    const f = { state, database, writes, reject: (value: boolean) => { rejected = value; },
        call: (name: string, input: unknown) => poll(state.MindwtrHost[name](JSON.stringify(input))),
        boot: async (cold = false) => { expect(await poll(state.MindwtrHost[cold ? 'bootRecovery' : 'boot']('', '', 'journaled'))).toMatchObject({ ok: true }); writes.length = 0; },
    };
    fixtures.push(f); return f;
};

describe('exported Android frozen Project calendar reference bridge', () => {
    it('retains the prepared calendar write endpoints in the production Android table', async () => {
        const built = fixture(); await built.boot();
        for (const method of ['projectCalendarReferencePrepare', 'projectCalendarReferenceValidate', 'projectCalendarReferenceCommit']) {
            expect(typeof built.state.MindwtrHost[method]).toBe('function');
        }
        expect(built.state.MindwtrHost.projectDateCommit).toBeUndefined();
    });

    it('commits a previously issued frozen link after cold boot without its picker cache and replays once', async () => {
        const original = fixture(); await original.boot();
        const envelope = await original.state.fixture.issue();
        const id = envelope.request.projectId;
        const cold = fixture(original.database); await cold.boot(true);
        expect(await cold.call('projectCalendarReferencePrepare', envelope.request)).toMatchObject({ ok: false, error: expect.stringContaining('STALE_REVISION') });
        expect(await cold.call('projectCalendarReferenceValidate', envelope)).toMatchObject({ ok: true });
        expect(await cold.call('projectCalendarReferenceCommit', envelope)).toEqual({ ok: true, value: { id, value: envelope.request.value } });
        const after = cold.database.query('SELECT * FROM projects WHERE id=?').get(id);
        const again = fixture(original.database); await again.boot(true);
        expect(await again.call('projectCalendarReferenceCommit', envelope)).toMatchObject({ ok: true });
        expect(again.database.query('SELECT * FROM projects WHERE id=?').get(id)).toEqual(after);
        expect(again.writes).toEqual([]);
        expect(again.database.query('SELECT count(*) AS total FROM tasks').get()).toEqual({ total: 0 });
    });

    it('retains the same frozen link after an outer SQLite COMMIT rollback and cold retry', async () => {
        const original = fixture(); await original.boot();
        const envelope = await original.state.fixture.issue();
        const before = original.database.query('SELECT * FROM projects ORDER BY id').all();
        original.reject(true);
        expect(await original.call('projectCalendarReferenceCommit', envelope)).toMatchObject({ ok: false, error: expect.stringContaining('SAVE_FAILED') });
        expect(original.database.query('SELECT * FROM projects ORDER BY id').all()).toEqual(before);
        original.reject(false);
        const cold = fixture(original.database); await cold.boot(true);
        expect(await cold.call('projectCalendarReferenceCommit', envelope)).toMatchObject({ ok: true });
        const stored = cold.database.query<{ calendarReference: string; rev: number }, [string]>('SELECT calendarReference, rev FROM projects WHERE id=?').get(envelope.request.projectId)!;
        expect(JSON.parse(stored.calendarReference)).toEqual(envelope.request.value);
        expect(stored.rev).toBe(envelope.prepared.scope.project.rev + 1);
    });
});
