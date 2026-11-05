import { afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import vm from 'node:vm';
import { build } from 'esbuild';
import type { AppData, Project, Task } from '../../../packages/core/src/types';
import { countTasksForIconBadge } from '../../../packages/core/src/task-icon-badge';

let source: string;
const fixtures: { database: Database; state: Record<string, any> }[] = [];
const at = '2026-10-09T00:00:00.000Z';
const localDay = (offset: number) => {
    const now = new Date();
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset);
    return `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
};
const task = (id: string, extra: Partial<Task> = {}): Task => ({
    id, title: `PRIVATE ${id}`, status: 'next', contexts: [], tags: [], createdAt: at, updatedAt: at, ...extra,
});
const project = (id: string, extra: Partial<Project> = {}): Project => ({
    id, title: `PRIVATE ${id}`, status: 'active', color: '#123456', order: 0, tagIds: [], createdAt: at, updatedAt: at, ...extra,
});
const data = (tasks: Task[] = [], projects: Project[] = []): AppData => ({ tasks, projects, sections: [], areas: [], settings: {} });

beforeAll(async () => {
    const built = await build({ stdin: { contents: `
        import './host-entry';
        import { useTaskStore, getStorageAdapter, setStorageAdapter, flushPendingSave, resetForTests } from '../../../packages/core/src/store';
        import { acquireWorkspaceTransitionLock, initializeSandboxRuntime } from '../../../packages/core/src/sandbox';
        globalThis.fixture = { state: useTaskStore.getState, set: useTaskStore.setState,
            adapter: getStorageAdapter, replaceAdapter: setStorageAdapter, flush: flushPendingSave, reset: resetForTests,
            sandbox: () => initializeSandboxRuntime(true), transition: acquireWorkspaceTransitionLock,
            install: d => useTaskStore.setState({ _allTasks: d.tasks, _allProjects: d.projects,
                _allSections: d.sections, _allAreas: d.areas, settings: d.settings }),
        };
    `, resolveDir: import.meta.dir, loader: 'ts' }, bundle: true, write: false, format: 'iife', target: 'es2022', logLevel: 'silent' });
    source = built.outputFiles[0].text;
});

afterEach(async () => {
    for (const f of fixtures.splice(0)) { await f.state.fixture.flush(); f.state.fixture.reset(); f.database.close(); }
});

const fixture = () => {
    const database = new Database(':memory:');
    const writes: string[] = [];
    const state: Record<string, any> = {
        AbortController, URL, TextEncoder, TextDecoder, setTimeout, clearTimeout,
        __mindwtrHostPlatform: 'ios', console: { info() {}, warn() {}, error() {}, log() {} },
        __mindwtrNative: {
            sqlExec: (sql: string) => { writes.push('sqlExec'); database.exec(sql); return null; },
            sqlRun: (sql: string, params: string) => { writes.push('sqlRun'); database.query(sql).run(...JSON.parse(params)); return null; },
            sqlAll: (sql: string, params: string) => JSON.stringify(database.query(sql).all(...JSON.parse(params))),
            nowMs: () => Date.now(), randomBytes: (count: number) => JSON.stringify(Array(count).fill(7)),
            log: () => {}, logFile: (operation: string) => (['path', 'ensure'].includes(operation) ? 'files/logs/mindwtr.log' : ''),
            rnStateCommit: () => null, kvGet: () => '[null]',
            kvSet: () => { writes.push('kvSet'); return null; }, kvRemove: () => { writes.push('kvRemove'); return null; },
            fileList: () => 'null', fileRead: () => '', fileDelete: () => { writes.push('fileDelete'); return null; },
        },
    };
    vm.runInNewContext(source, state);
    const poll = async (ticket: string) => {
        for (let step = 0; step < 100; step++) {
            const answer = state.MindwtrHost.poll(ticket);
            if (answer !== null) return JSON.parse(answer);
            await new Promise((done) => setTimeout(done, 0));
        }
        throw new Error('Host operation did not settle');
    };
    const boot = async (seed = data()) => {
        expect(await poll(state.MindwtrHost.boot('', ''))).toMatchObject({ ok: true });
        state.fixture.install(seed); writes.length = 0;
    };
    const f = { state, database, writes, poll, boot,
        count: (...args: unknown[]) => poll(state.MindwtrHost.iosTaskIconBadgeCount(...args)) };
    fixtures.push(f); return f;
};

describe('iOS task icon badge count', () => {
    it('returns the shared due-today-and-overdue count as a bare number without writes', async () => {
        const seed = data([
            task('overdue', { dueDate: localDay(-3) }), task('today', { dueDate: localDay(0), status: 'waiting' }),
            task('tomorrow', { dueDate: localDay(1) }), task('done', { dueDate: localDay(-1), status: 'done' }),
            task('reference', { dueDate: localDay(-1), status: 'reference' }), task('undated'),
            task('archived-parent', { dueDate: localDay(0), projectId: 'archived' }),
            task('someday-parent', { dueDate: localDay(0), projectId: 'someday' }),
        ], [project('archived', { status: 'archived' }), project('someday', { status: 'someday' })]);
        const f = fixture(); await f.boot(seed);
        const answer = await f.count();
        expect(answer).toEqual({ ok: true, value: 3 });
        expect(answer.value).toBe(countTasksForIconBadge(seed.tasks, seed.projects, seed.sections));
        await f.state.fixture.flush();
        expect(f.writes).toEqual([]);
    });

    it('follows date, status and project changes in the canonical store', async () => {
        const f = fixture(); await f.boot(data([task('a', { dueDate: localDay(1) }), task('b', { dueDate: localDay(0), projectId: 'p' })],
            [project('p')]));
        expect((await f.count()).value).toBe(1);
        f.state.fixture.install(data([task('a', { dueDate: localDay(0) }), task('b', { dueDate: localDay(0), projectId: 'p' })], [project('p')]));
        expect((await f.count()).value).toBe(2);
        f.state.fixture.install(data([task('a', { dueDate: localDay(0), status: 'done' }), task('b', { dueDate: localDay(0), projectId: 'p' })],
            [project('p', { status: 'archived' })]));
        expect((await f.count()).value).toBe(0);
    });

    it('rejects arguments', async () => {
        const f = fixture(); await f.boot();
        expect(await f.count('extra')).toMatchObject({ ok: false, error: expect.stringContaining('INVALID_INPUT:') });
    });

    it.each(['boot', 'platform', 'sandbox', 'transition', 'adapter', 'loading'])('refuses %s as not ready', async (guard) => {
        const f = fixture(); if (guard !== 'boot') await f.boot(data([task('due', { dueDate: localDay(0) })]));
        if (guard === 'platform') f.state.__mindwtrHostPlatform = 'android';
        if (guard === 'sandbox') f.state.fixture.sandbox();
        if (guard === 'transition') f.state.fixture.transition();
        if (guard === 'adapter') f.state.fixture.replaceAdapter({});
        if (guard === 'loading') f.state.fixture.set({ isLoading: true });
        const answer = await f.count();
        expect(answer.ok).toBe(false);
        expect(answer.error).toStartWith('NOT_READY:');
        expect(f.writes).toEqual([]);
    });

    it('holds an owed save instead of counting unsaved rows', async () => {
        const f = fixture(); await f.boot();
        await f.state.fixture.state().addTask('private new task', { dueDate: localDay(0) });
        expect((await f.count()).ok).toBe(false);
    });
});
