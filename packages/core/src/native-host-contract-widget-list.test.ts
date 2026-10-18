import { afterEach, describe, expect, it, vi } from 'vitest';
import { createNativeHostContract } from './native-host-contract';
import { flushPendingSave, resetForTests, setStorageAdapter, useTaskStore } from './store';
import type { AppData, Project, Task } from './types';
import { resolveWidgetListDestination } from './widget-list-destination';

// RN's widget list screen (app/(drawer)/widget-list/[id].tsx and widget-list-screen.test.tsx), through the native host contract.
const now = new Date().toISOString();
const task = (id: string, fields: Partial<Task> = {}): Task => ({
    id, title: id, status: 'next', tags: [], contexts: [], createdAt: now, updatedAt: now, ...fields,
});
const copy = <T,>(item: T): T => JSON.parse(JSON.stringify(item)) as T;
const value = <T,>(result: { ok: true; value: T } | { ok: false; error: { code: string; message: string } }): T => {
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
    return result.value;
};
const open = async (seed: Partial<AppData>) => {
    await flushPendingSave();
    resetForTests();
    let data = copy({ tasks: [], projects: [], sections: [], areas: [], people: [], settings: {}, ...seed });
    setStorageAdapter({ getData: async () => data, saveData: vi.fn(async (next: unknown) => { data = copy(next) as typeof data; }) });
    useTaskStore.setState({ _allTasks: [], _allProjects: [], _allSections: [], _allAreas: [], _allPeople: [],
        settings: {}, error: null, persistenceFailure: null, isLoading: false, editLockCount: 0, lastDataChangeAt: 0 });
    await useTaskStore.getState().fetchData({ throwOnError: true });
    await flushPendingSave();
    const host = createNativeHostContract();
    value(await host.setLanguage({ storedLanguage: 'en', systemLocale: 'en-US' }));
    value(await host.activate({ writeSafetyReady: true }));
    return host;
};
const ids = (rows: { id: string }[]) => rows.map((row) => row.id);

afterEach(async () => {
    await flushPendingSave();
    resetForTests();
    vi.useRealTimers();
    vi.restoreAllMocks();
});

describe('native host contract: widget list screen', () => {
    it('opens the full Upcoming list through the header route and re-evaluates the local day', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date(2026, 9, 17, 12));
        const host = await open({ tasks: Array.from({ length: 90 }, (_, i) => task(`upcoming-${i}`, { startTime: '2026-10-18' })) });
        const first = value(host.getWidgetListView({ id: 'upcoming', limit: 50 }));
        const second = value(host.getWidgetListView({ id: 'upcoming', offset: 50, limit: 50, revision: first.revision }));
        expect(first).toMatchObject({ found: true, title: 'Upcoming', total: 90, empty: null });
        expect([...first.rows, ...second.rows]).toHaveLength(90);
        vi.setSystemTime(new Date(2026, 9, 18, 0));
        expect(value(host.getWidgetListView({ id: 'upcoming' }))).toMatchObject({ found: true, title: 'Upcoming', total: 0, rows: [] });
    });
    it('keeps the full live list, windowed, and drops a completed task', async () => {
        const host = await open({ tasks: Array.from({ length: 90 }, (_, i) => task(`task-${String(i).padStart(2, '0')}`)) });
        const first = value(host.getWidgetListView({ id: 'next', offset: 0, limit: 50 }));
        expect(first).toMatchObject({ found: true, title: 'Next Actions', total: 90, empty: null });
        const second = value(host.getWidgetListView({ id: 'next', offset: 50, limit: 50, revision: first.revision }));
        const state = useTaskStore.getState();
        const expected = resolveWidgetListDestination({ tasks: state._allTasks, projects: state._allProjects, sections: state._allSections,
            areas: state._allAreas, settings: state.settings }, 'en', 'next')!;
        expect([...ids(first.rows), ...ids(second.rows)]).toEqual(ids(expected.tasks));
        await useTaskStore.getState().updateTask('task-00', { status: 'done' });
        const after = value(host.getWidgetListView({ id: 'next' }));
        expect(after.total).toBe(89);
        expect(ids(after.rows)).not.toContain('task-00');
        expect(host.getWidgetListView({ id: 'next', offset: 50, limit: 50, revision: first.revision })).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
    });

    it('opens direct context/tag routes with live shared matching and keeps removed selections empty', async () => {
        const host = await open({ tasks: [task('desk', { contexts: ['@家/desk +?'], status: 'waiting' }), task('tag', { tags: ['#urgent'] })] });
        expect(value(host.getWidgetListView({ id: 'context:@家/desk +?' }))).toMatchObject({ found: true, title: '@家/desk +?', total: 1 });
        expect(ids(value(host.getWidgetListView({ id: 'tag:#urgent' })).rows)).toEqual(['tag']);
        await useTaskStore.getState().updateTask('desk', { contexts: [] });
        expect(value(host.getWidgetListView({ id: 'context:@家/desk +?' }))).toMatchObject({ found: true, title: '@家/desk +?', total: 0, rows: [] });
    });

    it('uses a saved filter by ID, follows its rename, and becomes empty when it is deleted', async () => {
        const host = await open({
            tasks: [task('Zebra'), task('Alpha')],
            settings: { savedFilters: [{ id: 'desk', name: 'Desk', view: 'next', criteria: {}, sortBy: 'title', sortOrder: 'asc', createdAt: now, updatedAt: now }] },
        });
        const view = value(host.getWidgetListView({ id: 'filter:desk' }));
        expect(ids(view.rows)).toEqual(['Alpha', 'Zebra']);
        expect(view.title).toBe('Desk');
        const filters = useTaskStore.getState().settings.savedFilters!;
        await useTaskStore.getState().updateSettings({ savedFilters: [{ ...filters[0], name: 'Renamed' }] });
        expect(value(host.getWidgetListView({ id: 'filter:desk' })).title).toBe('Renamed');
        await useTaskStore.getState().updateSettings({ savedFilters: [] });
        expect(value(host.getWidgetListView({ id: 'filter:desk' }))).toMatchObject({
            found: false, title: 'No results found', total: 0, rows: [], empty: { message: 'No results found' },
        });
    });

    it('fails closed for a route ID that names no list', async () => {
        const host = await open({ tasks: [task('hidden')] });
        for (const id of ['', 'focus', 'filter:', 'filter: ', 'next/extra', 'inbox', 'next\u0000']) {
            expect(value(host.getWidgetListView({ id }))).toMatchObject({ found: false, total: 0, rows: [] });
        }
        expect(host.getWidgetListView({ id: 7 } as never)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(host.getWidgetListView({ id: 'next', limit: 101 })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    });

    it('retains canonical parent tombstones so the list matches widget visibility', async () => {
        const host = await open({});
        // As RN's screen test: the canonical pools hold the deleted parent; the visible pools do not.
        const deleted: Project = { id: 'deleted-project', title: 'Deleted', status: 'active', color: '#000000', order: 0, tagIds: [],
            createdAt: now, updatedAt: now, deletedAt: now };
        const tasks = [task('visible'), task('hidden-child', { projectId: 'deleted-project' })];
        useTaskStore.setState({ tasks, _allTasks: tasks, projects: [], _allProjects: [deleted] });
        expect(ids(value(host.getWidgetListView({ id: 'next' })).rows)).toEqual(['visible']);
    });
});
