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
        import { createWidgetPayloadProjection, createPublishedWidgetProjection, iosWidgetProjectionOptions, IOS_WIDGET_FAMILY_CACHE_ITEMS } from '../../../packages/core/src/widget-payload';
        import { getFocusWidgetFilter, setFocusWidgetFilter } from '../../../packages/core/src/focus-widget-filter';
        const canonical = () => { const s = useTaskStore.getState(); return {
            tasks: s._allTasks, projects: s._allProjects, sections: s._allSections, areas: s._allAreas, settings: s.settings }; };
        globalThis.fixture = { state: useTaskStore.getState, set: useTaskStore.setState,
            focusFilter: setFocusWidgetFilter, currentFocusFilter: getFocusWidgetFilter,
            canonical, shared: (language = 'en', systemLocale) => createWidgetPayloadProjection(canonical(), language, { listIds: ['next'], systemLocale, focusFilter: getFocusWidgetFilter() }).build(IOS_WIDGET_FAMILY_CACHE_ITEMS.medium),
            familyShared: (language = 'en', systemLocale, systemColorScheme = 'light') => {
                const projection = createPublishedWidgetProjection(createWidgetPayloadProjection(canonical(), language,
                    iosWidgetProjectionOptions({ systemLocale, systemColorScheme, focusFilter: getFocusWidgetFilter() })), language);
                return { version: 1, payloads: Object.fromEntries(Object.entries(IOS_WIDGET_FAMILY_CACHE_ITEMS)
                    .map(([family, count]) => [family, JSON.stringify(projection.build(count))])) };
            },
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
        snapshot: (...args: unknown[]) => poll(state.MindwtrHost.iosWidgetNextSnapshot(...args)),
        actionSnapshot: (...args: unknown[]) => poll(state.MindwtrHost.iosWidgetNextActionSnapshot(...args)),
        familySnapshot: (...args: unknown[]) => poll(state.MindwtrHost.iosWidgetFamilySnapshot(...args)),
        failLog: () => { failLog = true; }, logText: () => logText };
    fixtures.push(f); return f;
};

const projected = (payload: any) => ({ version: 1, title: payload.lists.next.title, emptyMessage: payload.emptyMessage,
    totalCount: payload.lists.next.totalCount, items: payload.lists.next.items.map(({ id, title, contextLabel, dueLabel, dueTone }: any) =>
        ({ id, title, contextLabel, dueLabel, dueTone })) });
const readonly = async (f: ReturnType<typeof fixture>, before: any) => {
    await f.state.fixture.flush();
    const after = f.state.fixture.canonical();
    for (const field of ['tasks', 'projects', 'sections', 'areas', 'settings']) expect(after[field]).toBe(before[field]);
    expect(f.writes).toEqual([]);
};

describe('actual exported canonical iOS Next widget snapshot', () => {
    it('keeps canonical Next order/count/cap and a Next task also present in the flattened Focus snapshot', async () => {
        const tasks = Array.from({ length: 17 }, (_, i) => task(`next-${i}`, { status: 'next', title: `Next ${i}`,
            projectId: 'live', order: i, description: 'PRIVATE note', tags: ['PRIVATE tag'] }));
        tasks.push(task('deleted-parent', { status: 'next', projectId: 'deleted' }),
            task('archived-parent', { status: 'next', projectId: 'archived' }), task('done', { status: 'done' }),
            task('tombstone', { status: 'next', deletedAt: at }));
        const f = fixture(); await f.boot(data(tasks, [project('live'), project('deleted', { deletedAt: at }),
            project('archived', { status: 'archived' })]));
        const before = f.state.fixture.canonical(), canonical = projected(f.state.fixture.shared());
        const answer = await f.snapshot(); expect(answer).toEqual({ ok: true, value: canonical });
        expect(canonical.totalCount).toBe(17); expect(canonical.items).toHaveLength(13);
        expect(canonical.items.map((row: any) => row.id)).not.toContain('deleted-parent');
        expect(canonical.items[0].contextLabel).toBe('PRIVATE live');
        const search = await f.poll(f.state.MindwtrHost.iosSearchSnapshot());
        expect(Object.keys(search.value)).toEqual(['items']);
        const overlap = search.value.items.find((row: any) => row.list === 'focus' && canonical.items.some((next: any) => next.id === row.id));
        expect(overlap).toBeDefined();
        expect(answer.value.items.map((row: any) => row.id)).toContain(overlap.id);
        for (const row of answer.value.items) expect(Object.keys(row).sort()).toEqual(['contextLabel', 'dueLabel', 'dueTone', 'id', 'title']);
        expect(Object.keys(answer.value).sort()).toEqual(['emptyMessage', 'items', 'title', 'totalCount', 'version']);
        expect(JSON.stringify(answer.value)).not.toContain('PRIVATE note');
        expect(JSON.stringify(answer.value)).not.toContain('PRIVATE tag');
        await readonly(f, before);
    });

    it('uses current runtime language/locale and canonical area, sequencing and empty text', async () => {
        const f = fixture(); await f.boot(data([task('first', { status: 'next', projectId: 'seq', order: 0 }),
            task('blocked', { status: 'next', projectId: 'seq', order: 1 }),
            task('future', { status: 'next', startTime: '2099-01-01' }),
            task('hidden-area', { status: 'next', areaId: 'hidden' })], [project('seq', { isSequential: true })], {
                areas: [{ id: 'hidden', name: 'Hidden', color: '#123456', order: 0, createdAt: at, updatedAt: at }],
                settings: { filters: { areaId: '__none__' } },
            }));
        expect(await f.poll(f.state.MindwtrHost.language('de', 'de-DE'))).toMatchObject({ ok: true });
        const filtered = await f.snapshot();
        expect(filtered).toEqual({ ok: true, value: projected(f.state.fixture.shared('de', 'de-DE')) });
        expect(filtered.value.items.map((row: any) => row.id)).toEqual(['first']);
        f.state.fixture.install(data());
        const empty = await f.snapshot();
        expect(empty).toEqual({ ok: true, value: projected(f.state.fixture.shared('de', 'de-DE')) });
        expect(empty.value.totalCount).toBe(0); expect(empty.value.items).toEqual([]);
        expect(empty.value.title).not.toBe('Next Actions'); expect(empty.value.emptyMessage.length).toBeGreaterThan(0);
        expect(f.writes).toEqual([]);
    });

    it.each(['menuRead', 'focus'])('caches successful %s controls, advances observation on filter/sort only, and leaves durable rows unchanged', async (route) => {
        const seed = data([task('a', { status: 'next', title: 'A', contexts: ['@home'], priority: 'low' }),
            task('z', { status: 'next', title: 'Z', contexts: ['@home'], priority: 'high' }),
            task('drop', { status: 'next', contexts: ['@office'] })]);
        const f = fixture(); await f.boot(seed);
        await f.state.fixture.adapter().saveData(seed);
        const durable = () => f.database.query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
            .all().map((row: any) => [row.name, f.database.query(`SELECT * FROM "${row.name.replaceAll('"', '""')}"`).all()]);
        const saved = durable(), before = f.state.fixture.canonical();
        expect(saved.some(([, rows]: any) => rows.some((row: any) => row.id === 'a'))).toBe(true);
        f.writes.length = 0;
        const observe = () => JSON.parse(f.state.MindwtrHost.iosSearchObservation());
        const read = async (controls?: any, controlEdit?: any) => {
            const answer = await f.poll(route === 'menuRead'
                ? f.state.MindwtrHost.menuRead('focus', JSON.stringify({ limit: 1, controls, controlEdit }))
                : f.state.MindwtrHost.focus(1, controls ? JSON.stringify(controls) : '', controlEdit ? JSON.stringify(controlEdit) : ''));
            expect(answer.ok).toBe(true);
            return answer.value;
        };
        const base = await read({});
        const first = observe(); expect(Object.keys(first).sort()).toEqual(['nextAt', 'ready', 'revision']);
        expect(first.ready).toBe(true);
        const filtered = await read(base.controls.state, { type: 'filter', edit: { type: 'toggleToken', value: '@home' } });
        const second = observe(); expect(second.revision).toBe(first.revision + 1);
        expect(f.state.fixture.currentFocusFilter()).toEqual({ ...filtered.controls.widgetFilter, sortOrder: undefined });
        const filteredNext = await f.snapshot();
        expect(filteredNext).toEqual({ ok: true, value: projected(f.state.fixture.shared()) });
        expect(filteredNext.value.items.map((row: any) => row.id).sort()).toEqual(['a', 'z']);
        const sorted = await read(filtered.controls.state, { type: 'sort', sortBy: 'priority' });
        const third = observe(); expect(third.revision).toBe(second.revision + 1);
        expect(f.state.fixture.currentFocusFilter()).toEqual({ ...sorted.controls.widgetFilter, sortOrder: undefined });
        expect(await f.snapshot()).toEqual({ ok: true, value: projected(f.state.fixture.shared()) });
        await read(sorted.controls.state); expect(observe()).toEqual(third);
        const rejected = await f.poll(f.state.MindwtrHost.menuRead('focus', JSON.stringify({ limit: 0 })));
        expect(rejected.ok).toBe(false); expect(observe()).toEqual(third);
        expect(durable()).toEqual(saved); await readonly(f, before);
    });

    it('does not change Android menuRead filter-cache behavior', async () => {
        const f = fixture(); await f.boot(data([task('one', { status: 'next', contexts: ['@home'] })]));
        f.state.__mindwtrHostPlatform = 'android';
        const filter = f.state.fixture.currentFocusFilter();
        const answer = await f.poll(f.state.MindwtrHost.menuRead('focus', JSON.stringify({ limit: 1,
            controlEdit: { type: 'filter', edit: { type: 'toggleToken', value: '@home' } } })));
        expect(answer.ok).toBe(true); expect(f.state.fixture.currentFocusFilter()).toBe(filter);
        expect(f.writes).toEqual([]);
    });

    it('uses the existing cached Focus criteria/sort and refuses a filter replacement or in-place change during read', async () => {
        const f = fixture(); await f.boot(data([task('a', { status: 'next', title: 'A', tags: ['keep'] }),
            task('z', { status: 'next', title: 'Z', tags: ['keep'] }), task('drop', { status: 'next', tags: ['drop'] })]));
        f.state.fixture.focusFilter({ criteria: { tags: ['keep'] }, sortBy: 'title', sortOrder: 'desc' });
        const answer = await f.snapshot();
        expect(answer).toEqual({ ok: true, value: projected(f.state.fixture.shared()) });
        expect(answer.value.items.map((row: any) => row.id)).toEqual(['z', 'a']);
        for (const mode of ['replace', 'mutate']) {
            const row = task('private', { status: 'next' });
            f.state.fixture.install(data([row]));
            f.state.fixture.focusFilter({ criteria: {}, sortBy: 'default' });
            let changed = false;
            Object.defineProperty(row, 'title', { get() {
                if (!changed) {
                    changed = true;
                    if (mode === 'replace') f.state.fixture.focusFilter({ criteria: { tags: ['none'] }, sortBy: 'default' });
                    else f.state.fixture.currentFocusFilter().criteria.tags = ['none'];
                }
                return 'Private';
            } });
            expect(await f.snapshot()).toMatchObject({ ok: false, error: expect.stringContaining('NOT_READY:') });
        }
        expect(f.writes).toEqual([]);
    });

    it.each(['boot', 'platform', 'sandbox', 'transition', 'adapter', 'loading', 'load-error', 'failed'])('refuses %s without output, writes or success marker', async (guard) => {
        const f = fixture(); if (guard !== 'boot') await f.boot(data([task('private', { status: 'next' })]));
        if (guard === 'platform') f.state.__mindwtrHostPlatform = 'android';
        if (guard === 'sandbox') f.state.fixture.sandbox();
        if (guard === 'transition') f.state.fixture.transition();
        if (guard === 'adapter') f.state.fixture.replaceAdapter({});
        if (guard === 'loading') f.state.fixture.set({ isLoading: true });
        if (guard === 'load-error') f.state.fixture.set({ error: 'Failed to fetch data: private storage failure' });
        if (guard === 'failed') f.state.fixture.set({ persistenceFailure: { message: 'private failure' } });
        const answer = await f.snapshot(); expect(answer.ok).toBe(false);
        expect(answer.error).toStartWith(guard === 'failed' ? 'SAVE_FAILED:' : 'NOT_READY:');
        expect(f.writes).toEqual([]); expect(f.logText()).toBe('');
    });

    it('holds an owed save instead of flushing or publishing it', async () => {
        const f = fixture(); await f.boot();
        await f.state.fixture.state().addTask('private new task');
        expect(f.state.fixture.persistence().queued).toBeGreaterThan(0);
        expect(await f.snapshot()).toMatchObject({ ok: false, error: expect.stringContaining('NOT_READY:') });
        expect(f.state.fixture.persistence().queued).toBeGreaterThan(0);
        expect(f.writes).toEqual([]); expect(f.logText()).toBe('');
        await f.state.fixture.flush(); f.writes.length = 0;
        expect(await f.snapshot()).toMatchObject({ ok: true }); expect(f.writes).toEqual([]);
    });

    it.each(['_allTasks', '_allProjects', '_allSections', '_allAreas', 'settings', 'adapter'])('refuses a synchronous %s replacement during projection', async (field) => {
        const row = task('private', { status: 'next' }), f = fixture(); await f.boot(data([row]));
        let changed = false;
        Object.defineProperty(row, 'title', { get() {
            if (!changed) {
                changed = true;
                if (field === 'adapter') f.state.fixture.replaceAdapter({});
                else f.state.fixture.set({ [field]: field === 'settings' ? {} : f.state.fixture.state()[field].slice() });
            }
            return 'PRIVATE title';
        } });
        expect(await f.snapshot()).toMatchObject({ ok: false, error: expect.stringContaining('NOT_READY:') });
        expect(f.writes).toEqual([]); expect(f.logText()).toBe('');
    });

    it.each([null, 'private', 1, {}, []].map((argument) => ({ argument })))('rejects extra arguments %#', async ({ argument }) => {
        const f = fixture(); await f.boot();
        expect(await f.snapshot(argument)).toEqual({ ok: false, error: 'INVALID_INPUT: Widget Next snapshot takes no arguments' });
        expect(f.writes).toEqual([]); expect(f.logText()).toBe('');
    });

    it('refuses malformed canonical fields and the whole 1MiB byte overflow instead of a false empty list', async () => {
        const f = fixture(); await f.boot(data([task('x'.repeat(501), { status: 'next' })]));
        expect(await f.snapshot()).toEqual({ ok: false, error: 'INVALID_INPUT: Native iOS widget Next snapshot is invalid' });
        const projects = Array.from({ length: 13 }, (_, i) => project(`p${i}`, { title: '漢'.repeat(16_384) }));
        f.state.fixture.install(data(projects.map((p) => task(p.id, { status: 'next', projectId: p.id, title: '漢'.repeat(16_384) })), projects));
        expect(new TextEncoder().encode(JSON.stringify(projected(f.state.fixture.shared()))).byteLength).toBeGreaterThan(1024 * 1024);
        expect(await f.snapshot()).toEqual({ ok: false, error: 'INVALID_INPUT: Native iOS widget Next snapshot is invalid' });
        expect(f.writes).toEqual([]); expect(f.logText()).toBe('');
    });

    it('records only the successful bounded count and tolerates a failed diagnostic sink', async () => {
        const f = fixture(); await f.boot(data([task('PRIVATE-id', { status: 'next' })]));
        expect(await f.snapshot()).toMatchObject({ ok: true });
        expect(f.logText().trim().split('\n').map((line) => JSON.parse(line))).toEqual([
            { ts: expect.any(String), level: 'info', scope: 'native-ios', message: 'Native iOS Next widget snapshot',
                context: { releaseCheck: 'v1.3.9/ios-widget-next-snapshot', count: '1' } },
        ]);
        expect(f.logText()).not.toContain('PRIVATE');
        f.failLog(); expect(await f.snapshot()).toMatchObject({ ok: true }); expect(f.writes).toEqual([]);
    });
});


describe('private iOS Next widget completion capabilities', () => {
    it('binds original tokens and translated labels to the same canonical ordered snapshot without writes', async () => {
        const f = fixture(); await f.boot(data([task('e\u0301', { status: 'next', rev: 7 }),
            task('é', { status: 'next', rev: 8 }), task('\ufeffedge', { status: 'next', rev: 9 })]));
        expect(await f.poll(f.state.MindwtrHost.language('de', 'de-DE'))).toMatchObject({ ok: true });
        const before = f.state.fixture.canonical(), shared = f.state.fixture.shared('de', 'de-DE');
        const answer = await f.actionSnapshot();
        expect(answer.ok).toBe(true);
        expect(Object.keys(answer.value).sort()).toEqual(['completeLabel', 'snapshot', 'tokens', 'undoLabel']);
        expect(JSON.parse(answer.value.snapshot)).toEqual(projected(shared));
        expect(answer.value.tokens).toEqual(shared.lists.next.items.map((row: any) => row.completionToken ?? null));
        expect(answer.value.completeLabel).toBe(shared.completeLabel); expect(answer.value.undoLabel).toBe(shared.undoLabel);
        expect(answer.value.tokens.map((token: string) => JSON.parse(token)[0])).toEqual(shared.lists.next.items.map((row: any) => row.id));
        expect(await f.snapshot()).toEqual({ ok: true, value: projected(shared) });
        await readonly(f, before);
    });
    it('returns a bounded empty capability list', async () => {
        const f = fixture(); await f.boot(); const answer = await f.actionSnapshot();
        expect(answer.ok).toBe(true); expect(answer.value.tokens).toEqual([]);
        expect(JSON.parse(answer.value.snapshot).items).toEqual([]);
    });
    it('refuses arguments and non-iOS ownership', async () => {
        const f = fixture(); await f.boot(); expect((await f.actionSnapshot('extra')).ok).toBe(false);
        f.state.__mindwtrHostPlatform = 'android'; expect((await f.actionSnapshot()).ok).toBe(false);
        expect(f.writes).toEqual([]);
    });
});

describe('private iOS full-family widget read', () => {
    const appearance = (systemColorScheme: 'light' | 'dark') => JSON.stringify({ systemColorScheme });

    it('returns every family byte-for-byte from the real published core projection and retains refill budgets and chooser lists', async () => {
        const f = fixture();
        await f.boot(data([
            ...Array.from({ length: 40 }, (_, index) => task(`next-${index}`, {
                status: 'next', tags: ['keep'], contexts: ['@desk'], rev: index + 1,
            })),
            task('inbox', { status: 'inbox' }), task('deleted', { status: 'next', deletedAt: at }),
        ], [], { settings: { theme: 'system', savedFilters: [{ id: 'retained-filter', name: 'Retained chooser', view: 'focus',
            criteria: { tags: ['keep'] }, createdAt: at, updatedAt: at }] } }));
        expect(await f.poll(f.state.MindwtrHost.language('de', 'de-DE'))).toMatchObject({ ok: true });
        f.state.fixture.focusFilter({ criteria: { tags: ['keep'] }, sortBy: 'title', sortOrder: 'desc' });
        const before = f.state.fixture.canonical();
        const answer = await f.familySnapshot(appearance('dark'));
        expect(answer).toEqual({ ok: true, value: f.state.fixture.familyShared('de', 'de-DE', 'dark') });
        expect(Object.keys(answer.value).sort()).toEqual(['payloads', 'version']);
        expect(Object.keys(answer.value.payloads).sort()).toEqual(['default', 'extraLarge', 'large', 'medium', 'small']);
        for (const [family, count] of Object.entries({ default: 20, small: 11, medium: 13, large: 20, extraLarge: 32 })) {
            const payload = JSON.parse(answer.value.payloads[family]);
            expect(payload.lists.next.items).toHaveLength(count);
            expect(payload.lists.inbox.items.map((row: { id: string }) => row.id)).toEqual(['inbox']);
            expect(payload.lists['filter:retained-filter'].items).toHaveLength(count);
            expect(payload.savedFilters.some((filter: { id: string }) => filter.id === 'retained-filter')).toBe(true);
            expect(payload.quickCaptureUri).toStartWith('mindwtr:');
            expect(JSON.parse(payload.lists.next.items[0].completionToken)[0]).toBe(payload.lists.next.items[0].id);
        }
        await readonly(f, before);
    });

    it.each([
        { theme: 'dark', system: 'light' },
        { theme: 'system', system: 'dark' },
        { theme: 'system', system: 'light' },
    ] satisfies { theme: 'dark' | 'system'; system: 'light' | 'dark' }[])('uses the existing saved theme and system palette resolver %#', async ({ theme, system }) => {
        const f = fixture(); await f.boot(data([task('palette', { status: 'next' })], [], { settings: { theme } }));
        const answer = await f.familySnapshot(appearance(system));
        expect(answer).toEqual({ ok: true, value: f.state.fixture.familyShared('en', undefined, system) });
        const actual = JSON.parse(answer.value.payloads.default);
        expect(actual.themeMode).toBe(theme);
        const dark = JSON.parse(f.state.fixture.familyShared('en', undefined, 'dark').payloads.default);
        const light = JSON.parse(f.state.fixture.familyShared('en', undefined, 'light').payloads.default);
        if (theme === 'dark') expect(actual.palette).toEqual(dark.palette);
        else {
            expect(dark.palette).not.toEqual(light.palette);
            expect(actual.palette).toEqual(system === 'dark' ? dark.palette : light.palette);
        }
        expect(f.writes).toEqual([]);
    });

    it.each(['boot', 'platform', 'sandbox', 'transition', 'adapter', 'loading', 'load-error', 'failed'])('refuses %s before exposing any family or writing', async (guard) => {
        const f = fixture(); if (guard !== 'boot') await f.boot(data([task('private', { status: 'next' })]));
        if (guard === 'platform') f.state.__mindwtrHostPlatform = 'android';
        if (guard === 'sandbox') f.state.fixture.sandbox();
        if (guard === 'transition') f.state.fixture.transition();
        if (guard === 'adapter') f.state.fixture.replaceAdapter({});
        if (guard === 'loading') f.state.fixture.set({ isLoading: true });
        if (guard === 'load-error') f.state.fixture.set({ error: 'Failed to fetch data: private storage failure' });
        if (guard === 'failed') f.state.fixture.set({ persistenceFailure: { message: 'private failure' } });
        const answer = await f.familySnapshot(appearance('light'));
        expect(answer.ok).toBe(false);
        expect(answer.error).toStartWith(guard === 'failed' ? 'SAVE_FAILED:' : 'NOT_READY:');
        expect(answer.value).toBeUndefined(); expect(f.writes).toEqual([]); expect(f.logText()).toBe('');
    });

    it.each(['_allTasks', '_allProjects', '_allSections', '_allAreas', 'settings', 'adapter', 'filter-replace', 'filter-mutate'])('rejects stale %s ownership during real projection without partial publication', async (field) => {
        const row = task('private', { status: 'next' }), f = fixture(); await f.boot(data([row]));
        f.state.fixture.focusFilter({ criteria: {}, sortBy: 'default' });
        let changed = false;
        Object.defineProperty(row, 'title', { get() {
            if (!changed) {
                changed = true;
                if (field === 'adapter') f.state.fixture.replaceAdapter({});
                else if (field === 'filter-replace') f.state.fixture.focusFilter({ criteria: { tags: ['none'] }, sortBy: 'default' });
                else if (field === 'filter-mutate') f.state.fixture.currentFocusFilter().criteria.tags = ['none'];
                else f.state.fixture.set({ [field]: field === 'settings' ? {} : f.state.fixture.state()[field].slice() });
            }
            return 'Private';
        } });
        const answer = await f.familySnapshot(appearance('light'));
        expect(answer).toMatchObject({ ok: false, error: expect.stringContaining('NOT_READY:') });
        expect(answer.value).toBeUndefined(); expect(f.writes).toEqual([]); expect(f.logText()).toBe('');
    });

    it('rejects the complete escaped UTF-8 envelope at the shared native size bound instead of returning partial families', async () => {
        const f = fixture();
        await f.boot(data(Array.from({ length: 32 }, (_, index) => task(`large-${index}`, { status: 'next', title: '漢'.repeat(16_384) }))));
        const expected = { ok: true, value: f.state.fixture.familyShared('en', undefined, 'light') };
        expect(new TextEncoder().encode(JSON.stringify(expected)).byteLength).toBeGreaterThan(2_000_000);
        const answer = await f.familySnapshot(appearance('light'));
        expect(answer).toEqual({ ok: false, error: 'INVALID_INPUT: Native iOS widget family snapshot is invalid' });
        expect(answer.value).toBeUndefined(); expect(f.writes).toEqual([]); expect(f.logText()).toBe('');
    });

    it('does not flush or acknowledge an owed save to make a read appear ready', async () => {
        const f = fixture(); await f.boot();
        await f.state.fixture.state().addTask('Private queued task');
        expect(f.state.fixture.persistence().queued).toBeGreaterThan(0);
        expect(await f.familySnapshot(appearance('dark'))).toMatchObject({ ok: false, error: expect.stringContaining('NOT_READY:') });
        expect(f.state.fixture.persistence().queued).toBeGreaterThan(0);
        expect(f.writes).toEqual([]); expect(f.logText()).toBe('');
        await f.state.fixture.flush(); f.writes.length = 0;
        expect(await f.familySnapshot(appearance('dark'))).toMatchObject({ ok: true });
        expect(f.writes).toEqual([]);
    });

    it('counts JSON-string escaping in the outer native reply instead of summing the five raw strings', async () => {
        const f = fixture();
        await f.boot(data(Array.from({ length: 32 }, (_, index) => task(`quoted-${index}`, { status: 'next', title: '"'.repeat(8_000) }))));
        const value = f.state.fixture.familyShared('en', undefined, 'light');
        const rawBytes = Object.values(value.payloads).reduce((count: number, payload) => count + new TextEncoder().encode(String(payload)).byteLength, 0);
        expect(rawBytes).toBeLessThan(2_000_000);
        expect(new TextEncoder().encode(JSON.stringify({ ok: true, value })).byteLength).toBeGreaterThan(2_000_000);
        expect(await f.familySnapshot(appearance('light'))).toEqual({ ok: false, error: 'INVALID_INPUT: Native iOS widget family snapshot is invalid' });
        expect(f.writes).toEqual([]); expect(f.logText()).toBe('');
    });

    it.each([undefined, null, 1, '{}', 'null', '[]', '{"systemColorScheme":true}', '{"systemColorScheme":"system"}', '{"systemColorScheme":"dark","extra":1}'])('rejects an invalid closed appearance input %#', async (input) => {
        const f = fixture(); await f.boot();
        const answer = await f.familySnapshot(input);
        expect(answer).toEqual({ ok: false, error: 'INVALID_INPUT: Native iOS widget family snapshot is invalid' });
        expect(f.writes).toEqual([]); expect(f.logText()).toBe('');
    });

    it('rejects missing/extra arguments and logs only the fixed successful read receipt', async () => {
        const f = fixture(); await f.boot(data([task('PRIVATE-id', { status: 'next' })]));
        for (const args of [[], [appearance('light'), 'extra']]) {
            expect(await f.familySnapshot(...args)).toEqual({ ok: false, error: 'INVALID_INPUT: Widget family snapshot takes one appearance object' });
        }
        expect(f.logText()).toBe('');
        expect(await f.familySnapshot(appearance('light'))).toMatchObject({ ok: true });
        expect(f.logText().trim().split('\n').map((line) => JSON.parse(line))).toEqual([
            { ts: expect.any(String), level: 'info', scope: 'native-ios', message: 'Native iOS widget families read',
                context: { releaseCheck: 'v1.3.9/ios-widget-family-read', operation: 'read', outcome: 'ready' } },
        ]);
        expect(f.logText()).not.toContain('PRIVATE');
        f.failLog(); expect(await f.familySnapshot(appearance('dark'))).toMatchObject({ ok: true });
        expect(f.writes).toEqual([]);
    });
});
