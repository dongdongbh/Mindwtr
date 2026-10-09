import { afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import vm from 'node:vm';
import { build } from 'esbuild';
import type { AppData, Project, Task } from '../../../packages/core/src/types';

let source: string;
const fixtures: ReturnType<typeof fixture>[] = [];
const at = '2026-10-09T00:00:00.000Z';
const task = (id: string, extra: Partial<Task> = {}): Task => ({
    id, title: `PRIVATE ${id}`, status: 'inbox', contexts: [], tags: [], createdAt: at, updatedAt: at, ...extra,
});
const project = (id: string, extra: Partial<Project> = {}): Project => ({
    id, title: `PRIVATE ${id}`, status: 'active', color: '#123456', order: 0, tagIds: [], createdAt: at, updatedAt: at, ...extra,
});
const data = (tasks: Task[] = [], projects: Project[] = [], extra: Partial<AppData> = {}): AppData => ({
    tasks, projects, sections: [], areas: [], settings: {}, ...extra,
});

beforeAll(async () => {
    const built = await build({ stdin: { contents: `
        import './host-entry';
        import { useTaskStore, getStorageAdapter, setStorageAdapter, getPersistenceStatus, flushPendingSave, resetForTests } from '../../../packages/core/src/store';
        import { acquireWorkspaceTransitionLock, initializeSandboxRuntime } from '../../../packages/core/src/sandbox';
        import { buildShortcutsSnapshot } from '../../../packages/core/src/widget-payload';
        const canonical = () => { const s = useTaskStore.getState(); return {
            tasks: s._allTasks, projects: s._allProjects, sections: s._allSections, areas: s._allAreas, settings: s.settings }; };
        globalThis.fixture = { state: useTaskStore.getState, set: useTaskStore.setState,
            canonical, shared: () => buildShortcutsSnapshot(canonical()),
            adapter: getStorageAdapter, replaceAdapter: setStorageAdapter, persistence: getPersistenceStatus,
            flush: flushPendingSave, reset: resetForTests,
            sandbox: () => initializeSandboxRuntime(true), transition: acquireWorkspaceTransitionLock,
            install: d => { useTaskStore.setState({ _allTasks: d.tasks, _allProjects: d.projects,
                _allSections: d.sections, _allAreas: d.areas, settings: d.settings });
                useTaskStore.getState().tasks = d.tasks.slice(0, 1); },
        };
    `, resolveDir: import.meta.dir, loader: 'ts' }, bundle: true, write: false, format: 'iife', target: 'es2022', logLevel: 'silent' });
    source = built.outputFiles[0].text;
});

afterEach(async () => {
    for (const f of fixtures.splice(0)) { await f.state.fixture.flush(); f.state.fixture.reset(); f.database.close(); }
});

const fixture = () => {
    const database = new Database(':memory:');
    const writes: string[] = [], lines: string[] = [];
    let logText = '', failLog = false;
    const state: Record<string, any> = {
        AbortController, URL, TextEncoder, TextDecoder, setTimeout, clearTimeout,
        __mindwtrHostPlatform: 'ios', console: { info() {}, warn() {}, error() {}, log() {} },
        __mindwtrNative: {
            sqlExec: (sql: string) => { writes.push('sqlExec'); database.exec(sql); return null; },
            sqlRun: (sql: string, params: string) => { writes.push('sqlRun'); database.query(sql).run(...JSON.parse(params)); return null; },
            sqlAll: (sql: string, params: string) => JSON.stringify(database.query(sql).all(...JSON.parse(params))),
            nowMs: () => Date.now(), randomBytes: (count: number) => JSON.stringify(Array(count).fill(7)),
            log: (line: string) => { lines.push(line); },
            logFile: (operation: string, text: string) => {
                if (failLog) throw new Error('private diagnostic failure');
                if (['path', 'ensure'].includes(operation)) return 'files/logs/mindwtr.log';
                if (operation === 'size') return String(logText.length);
                if (operation === 'read') return logText;
                if (operation === 'exists') return logText ? '1' : '';
                if (operation === 'isAbsent') return logText ? '' : '1';
                if (operation === 'append') { logText += text; return ''; }
                if (operation === 'write') { logText = text; return ''; }
                if (operation === 'delete') { logText = ''; return '1'; }
                throw new Error('Unexpected diagnostic operation');
            },
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
        state.fixture.install(seed); writes.length = 0; lines.length = 0; logText = '';
    };
    const f = { state, database, writes, lines, poll, boot,
        snapshot: (...args: unknown[]) => poll(state.MindwtrHost.iosSearchSnapshot(...args)),
        failLog: () => { failLog = true; }, logText: () => logText };
    fixtures.push(f); return f;
};

const flattened = (shared: any) => {
    const seen = new Set<string>(), items: Record<string, string>[] = [];
    for (const row of [...['inbox', 'focus', 'next', 'waiting', 'someday'].flatMap((list) => shared.lists[list]),
        ...shared.projects.flatMap((group: any) => group.items)]) {
        if (seen.has(row.id)) continue;
        seen.add(row.id);
        const { id, title, list, projectName, dueDate, startDate } = row;
        items.push({ id, title, list, ...(projectName !== undefined ? { projectName } : {}),
            ...(dueDate !== undefined ? { dueDate } : {}), ...(startDate !== undefined ? { startDate } : {}) });
    }
    return { items };
};
const assertReadonly = async (f: ReturnType<typeof fixture>, before: any) => {
    await f.state.fixture.flush();
    const after = f.state.fixture.canonical();
    for (const field of ['tasks', 'projects', 'sections', 'areas', 'settings']) expect(after[field]).toBe(before[field]);
    expect(f.writes).toEqual([]);
};

describe('actual exported readonly iOS search snapshot', () => {
    it('exports the zero-argument search facade', () => {
        const f = fixture(); expect(f.state.MindwtrHost.iosSearchSnapshot).toBeFunction();
    });

    it('reads the whole canonical store, applies shared eligibility and strips all other metadata', async () => {
        const tasks = [task('live', { notes: 'PRIVATE notes', attachments: [{ id: 'a', kind: 'link', title: 'PRIVATE link', uri: 'https://private.example' }], tags: ['PRIVATE tag'] }),
            task('deleted', { deletedAt: at }), task('done', { status: 'done' }), task('archived', { status: 'archived' }),
            task('reference', { status: 'reference' }), task('future', { status: 'next', startTime: '2099-01-01' }),
            task('active-project', { status: 'next', projectId: 'active' }), task('someday-project', { projectId: 'someday' }),
            task('completed-project', { projectId: 'completed' }), task('deleted-project', { projectId: 'deleted' }),
            task('waiting', { status: 'waiting' }), task('someday', { status: 'someday' })];
        const projects = [project('active'), project('someday', { status: 'someday' }), project('completed', { status: 'archived', archivedAt: at }),
            project('deleted', { deletedAt: at })];
        const f = fixture(); await f.boot(data(tasks, projects));
        expect(f.state.fixture.state().tasks).toHaveLength(1);
        const before = f.state.fixture.canonical(), expected = flattened(f.state.fixture.shared());
        const answer = await f.snapshot(); expect(answer).toEqual({ ok: true, value: expected });
        expect(expected.items.map((row) => row.id).sort()).toEqual(['active-project', 'future', 'live', 'someday', 'waiting']);
        expect(expected.items.find((row) => row.id === 'future')).toEqual({ id: 'future', title: 'PRIVATE future', list: 'next', startDate: '2099-01-01' });
        for (const row of answer.value.items) expect(Object.keys(row).every((field) => ['id', 'title', 'list', 'projectName', 'dueDate', 'startDate'].includes(field))).toBe(true);
        await assertReadonly(f, before);
    });

    it('keeps exact Unicode identity, dates and same-title rows, with the first shared-list appearance winning', async () => {
        const f = fixture(); await f.boot(data([
            task('é', { title: 'same', dueDate: '2000-01-01', startTime: '2000-01-02', isFocusedToday: true }),
            task('e\u0301', { title: 'same' }), task('ID', { title: 'same', status: 'waiting', isFocusedToday: true }),
            task('id', { title: 'same', status: 'waiting' }), task(' opaque /漢+😀 ', { title: '' }),
        ]));
        const answer = await f.snapshot();
        expect(answer).toEqual({ ok: true, value: flattened(f.state.fixture.shared()) });
        expect(answer.value.items.map((row: any) => row.id)).toEqual(expect.arrayContaining(['é', 'e\u0301', 'ID', 'id', ' opaque /漢+😀 ']));
        expect(answer.value.items).toHaveLength(5);
        expect(answer.value.items.find((row: any) => row.id === 'é')).toEqual({ id: 'é', title: 'same', list: 'inbox', dueDate: '2000-01-01', startDate: '2000-01-02' });
        expect(answer.value.items.find((row: any) => row.id === 'ID').list).toBe('focus');
        expect(answer.value.items.find((row: any) => row.id === ' opaque /漢+😀 ').title).toBe('');
    });

    it('passes sections, sequential project rules, Focus settings and time to shared projection on every request', async () => {
        const f = fixture(); await f.boot(data([
            task('final', { status: 'next', projectId: 'seq', sectionId: 'final', order: 0 }),
            task('setup', { status: 'next', projectId: 'seq', sectionId: 'setup', order: 10 }),
            task('start-date', { status: 'next', startTime: '2000-01-01' }),
            task('deferred', { status: 'next', startTime: '2099-01-01' }),
        ], [project('seq', { isSequential: true })], { sections: ['setup', 'final'].map((id, order) => ({ id, projectId: 'seq', title: id, order, createdAt: at, updatedAt: at })),
            settings: { taskSortBy: 'title', gtd: { focusIncludeStartDates: false } } }));
        const shared = f.state.fixture.shared();
        expect(shared.lists.focus.map((row: any) => row.id)).toContain('setup');
        expect(shared.lists.focus.map((row: any) => row.id)).not.toContain('final');
        expect(shared.lists.focus.map((row: any) => row.id)).not.toContain('deferred');
        expect(await f.snapshot()).toEqual({ ok: true, value: flattened(shared) });
        f.state.fixture.set({ settings: { taskSortBy: 'title', gtd: { focusIncludeStartDates: true } } });
        expect(await f.snapshot()).toEqual({ ok: true, value: flattened(f.state.fixture.shared()) });
        const clock = Date.parse('2099-01-02T12:00:00');
        f.state.Date = class extends Date { constructor(value?: any) { super(value === undefined ? clock : value); } static now() { return clock; } };
        expect(f.state.fixture.shared().lists.focus.map((row: any) => row.id)).toContain('deferred');
        expect(await f.snapshot()).toEqual({ ok: true, value: flattened(f.state.fixture.shared()) });
        expect(f.writes).toEqual([]);
    });

    it('preserves all 50/list and 50/project by 50-group caps without an earlier whole-library cap', async () => {
        const projects = Array.from({ length: 51 }, (_, i) => project(`p${i}`, { order: i }));
        const tasks = [
            ...Array.from({ length: 10_000 }, (_, i) => task(`completed-${i}`, { status: 'done' })),
            ...(['inbox', 'next', 'waiting', 'someday'] as const).flatMap((status) => Array.from({ length: 60 }, (_, i) => task(`${status}-${i}`, { status, title: `A ${String(i).padStart(2, '0')}` }))),
            ...projects.slice().reverse().flatMap((p) => Array.from({ length: 60 }, (_, i) => task(`${p.id}-${i}`, { status: 'next', projectId: p.id, title: `Z ${String(i).padStart(2, '0')}` }))),
        ];
        const f = fixture(); await f.boot(data(tasks, projects, { settings: { taskSortBy: 'title' } }));
        const shared = f.state.fixture.shared();
        for (const list of Object.values(shared.lists) as any[]) expect(list).toHaveLength(50);
        expect(shared.projects).toHaveLength(50);
        expect(shared.projects.map((p: any) => p.id)).toEqual(projects.slice(0, 50).map((p) => p.id));
        for (const p of shared.projects) expect(p.items).toHaveLength(50);
        const answer = await f.snapshot(); expect(answer).toEqual({ ok: true, value: flattened(shared) });
        expect(answer.value.items.length).toBeGreaterThanOrEqual(2_700);
        expect(answer.value.items.length).toBeLessThanOrEqual(2_750);
        expect(answer.value.items.some((row: any) => row.id.startsWith('p50-'))).toBe(false);
        expect(answer.value.items.some((row: any) => row.id === 'p49-0')).toBe(true);
        expect(f.writes).toEqual([]);
    });

    it.each(['boot', 'platform', 'sandbox', 'transition', 'adapter', 'loading', 'load-error', 'failed'])('refuses %s before successful output or diagnostics', async (guard) => {
        const f = fixture(); if (guard !== 'boot') await f.boot(data([task('private')]));
        if (guard === 'platform') f.state.__mindwtrHostPlatform = 'android';
        if (guard === 'sandbox') f.state.fixture.sandbox();
        if (guard === 'transition') f.state.fixture.transition();
        if (guard === 'adapter') f.state.fixture.replaceAdapter({});
        if (guard === 'loading') f.state.fixture.set({ isLoading: true });
        if (guard === 'load-error') f.state.fixture.set({ error: 'Failed to fetch data: private storage failure' });
        if (guard === 'failed') f.state.fixture.set({ persistenceFailure: { message: 'private failure' } });
        const answer = await f.snapshot();
        expect(answer.ok).toBe(false); expect(answer.error).toStartWith(guard === 'failed' ? 'SAVE_FAILED:' : 'NOT_READY:');
        expect(f.writes).toEqual([]); expect(f.logText()).toBe('');
    });

    it('refuses a queued save without flushing or acknowledging it, then succeeds after its explicit flush', async () => {
        const f = fixture(); await f.boot();
        await f.state.fixture.state().addTask('private new task');
        expect(f.state.fixture.persistence().queued).toBeGreaterThan(0);
        expect(await f.snapshot()).toEqual({ ok: false, error: 'NOT_READY: Native iOS search snapshot is unavailable' });
        expect(f.state.fixture.persistence().queued).toBeGreaterThan(0);
        expect(f.writes).toEqual([]); expect(f.logText()).toBe('');
        await f.state.fixture.flush(); f.writes.length = 0;
        expect(await f.snapshot()).toMatchObject({ ok: true }); expect(f.writes).toEqual([]);
    });

    it('refuses an in-flight save even with no persistence failure or queued rows', async () => {
        const f = fixture(); await f.boot();
        const adapter = f.state.fixture.adapter(), saved = adapter.saveData.bind(adapter);
        let release!: () => void;
        const held = new Promise<void>((resolve) => { release = resolve; });
        adapter.saveData = async (d: AppData) => { await held; return saved(d); };
        await f.state.fixture.state().addTask('private new task');
        const saving = f.state.fixture.flush();
        try {
            expect(f.state.fixture.persistence()).toMatchObject({ inFlight: true, queued: 0, failed: false });
            expect(await f.snapshot()).toMatchObject({ ok: false, error: expect.stringContaining('NOT_READY:') });
            expect(f.writes).toEqual([]); expect(f.logText()).toBe('');
        } finally { release(); await saving; }
    });

    it('refuses an immediate task save while generation is advanced but durability is unconfirmed', async () => {
        const f = fixture(); await f.boot(data([task('immediate')], [], { settings: { deviceId: 'snapshot-device' } }));
        const before = f.state.fixture.persistence().generation;
        const updating = f.state.fixture.state().updateTask('immediate', { title: 'changed' });
        expect(f.state.fixture.persistence()).toMatchObject({ immediate: 1, queued: 0, failed: false });
        expect(f.state.fixture.persistence().generation).toBeGreaterThan(before);
        const reading = f.snapshot();
        await updating;
        expect(await reading).toMatchObject({ ok: false, error: expect.stringContaining('NOT_READY:') });
        expect(f.logText()).not.toContain('Native iOS search snapshot');
        await f.state.fixture.flush();
    });

    it('refuses persistence retry work even after the prior failure flag was cleared', async () => {
        const f = fixture(); await f.boot();
        const adapter = f.state.fixture.adapter(), saved = adapter.saveData.bind(adapter);
        let release!: () => void;
        const held = new Promise<void>((resolve) => { release = resolve; });
        adapter.saveData = async (d: AppData) => { await held; return saved(d); };
        await f.state.fixture.state().addTask('retry work');
        const retrying = f.state.fixture.state().retryPersistence();
        try {
            expect(f.state.fixture.persistence().retrying).toBe(true);
            f.state.fixture.set({ persistenceFailure: null });
            expect(await f.snapshot()).toMatchObject({ ok: false, error: expect.stringContaining('NOT_READY:') });
            expect(f.writes).toEqual([]); expect(f.logText()).toBe('');
        } finally { release(); await retrying; }
    });

    it.each(['_allTasks', '_allProjects', '_allSections', '_allAreas', 'settings', 'isLoading', 'adapter', 'transition'])('refuses a synchronous %s change during shared capture', async (field) => {
        const f = fixture(), row = task('private'); await f.boot(data([row]));
        let changed = false;
        Object.defineProperty(row, 'title', { get() {
            if (!changed) {
                changed = true;
                if (field === 'adapter') f.state.fixture.replaceAdapter({});
                else if (field === 'transition') f.state.fixture.transition();
                else f.state.fixture.set({ [field]: field === 'isLoading' ? true : field === 'settings' ? {} : f.state.fixture.state()[field].slice() });
            }
            return 'private title';
        } });
        expect(await f.snapshot()).toMatchObject({ ok: false, error: expect.stringContaining('NOT_READY:') });
        expect(f.writes).toEqual([]); expect(f.logText()).toBe('');
    });

    it.each([undefined, null, 'private', 1, {}, []].map((argument) => ({ argument })))('rejects extra arguments %#', async ({ argument }) => {
        const f = fixture(); await f.boot();
        expect(await f.snapshot(argument, 'extra')).toEqual({ ok: false, error: 'INVALID_INPUT: Search snapshot takes no arguments' });
        expect(f.writes).toEqual([]); expect(f.logText()).toBe('');
    });

    it('accepts exact UTF16 field bounds, including an empty source title', async () => {
        const f = fixture(); await f.boot(data([task('😀'.repeat(250), { title: '😀'.repeat(8_192),
            projectId: 'p', dueDate: 'd'.repeat(100), startTime: 's'.repeat(100) }), task('empty', { title: '' })],
        [project('p', { title: '😀'.repeat(8_192) })]));
        const answer = await f.snapshot(); expect(answer.ok).toBe(true);
        expect(answer.value.items).toContainEqual({ id: '😀'.repeat(250), title: '😀'.repeat(8_192), list: 'inbox',
            projectName: '😀'.repeat(8_192), dueDate: 'd'.repeat(100), startDate: 's'.repeat(100) });
        expect(answer.value.items).toContainEqual({ id: 'empty', title: '', list: 'inbox' });
    });

    it.each([
        ['id', '', null], ['id', '😀'.repeat(250) + 'x', null], ['id', 1, null], ['title', null, null],
        ['title', '😀'.repeat(8_192) + 'x', null], ['dueDate', 'd'.repeat(101), null], ['dueDate', true, null],
        ['startTime', 's'.repeat(101), null], ['startTime', {}, null],
        ['title', 'valid', '😀'.repeat(8_192) + 'x'], ['title', 'valid', 1],
    ])('refuses the whole output for malformed or oversized %s %#', async (field, value, projectTitle) => {
        const f = fixture(), row = task('valid', { [field]: value } as any);
        const projects = projectTitle === null ? [] : [project('p', { title: projectTitle } as any)];
        if (projects.length) row.projectId = 'p';
        await f.boot(data([task('first-valid'), row], projects));
        expect(await f.snapshot()).toEqual({ ok: false, error: 'INVALID_INPUT: Native iOS search snapshot is invalid' });
        expect(f.writes).toEqual([]); expect(f.logText()).toBe('');
    });

    it('bounds the entire serialized output at exactly 8MiB UTF8 and refuses the next byte', async () => {
        const projects = Array.from({ length: 4 }, (_, i) => project(`p${i}`, { title: '' }));
        const tasks = Array.from({ length: 171 }, (_, i) => task(`byte-${i}`, { projectId: `p${Math.floor(i / 50)}`,
            title: i === 170 ? '' : '漢'.repeat(16_384) }));
        const f = fixture(); await f.boot(data(tasks, projects));
        const emptyBytes = new TextEncoder().encode(JSON.stringify(flattened(f.state.fixture.shared()))).byteLength;
        const remaining = 8 * 1024 * 1024 - emptyBytes;
        tasks[170].title = '漢'.repeat(Math.floor(remaining / 3)) + 'x'.repeat(remaining % 3);
        expect(tasks[170].title.length).toBeLessThanOrEqual(16_384);
        expect(new TextEncoder().encode(JSON.stringify(flattened(f.state.fixture.shared()))).byteLength).toBe(8 * 1024 * 1024);
        expect(await f.snapshot()).toMatchObject({ ok: true });
        tasks[170].title += 'x';
        expect(await f.snapshot()).toEqual({ ok: false, error: 'INVALID_INPUT: Native iOS search snapshot is invalid' });
        expect(f.writes).toEqual([]);
    });

    it('reports only a successful projection count and keeps success when its diagnostic sink fails', async () => {
        const f = fixture(); await f.boot(data([task('private-id')]));
        expect(await f.snapshot()).toMatchObject({ ok: true });
        const entries = f.logText().trim().split('\n').map((line) => JSON.parse(line));
        expect(entries).toEqual([{ ts: expect.any(String), level: 'info', scope: 'native-ios', message: 'Native iOS search snapshot',
            context: { releaseCheck: 'v1.3.5/ios-search-snapshot', count: '1' } }]);
        expect(f.logText()).not.toContain('private-id'); expect(f.logText()).not.toContain('PRIVATE');
        f.failLog(); expect(await f.snapshot()).toMatchObject({ ok: true }); expect(f.writes).toEqual([]);
    });
});
