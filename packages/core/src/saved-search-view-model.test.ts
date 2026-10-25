import { afterEach, describe, expect, it } from 'vitest';
import {
    getSavedSearchGlobalSortLabel,
    getSavedSearchOwnSortBy,
    resolveSavedSearchSortBy,
    selectSavedSearchTasks,
    setSavedSearchSortById,
} from './saved-search-view-model';
import { flushPendingSave, resetForTests, setStorageAdapter, useTaskStore } from './store';
import type { AppSettings, SavedSearch, Task } from './types';

const task = (id: string, title: string, extra: Partial<Task> = {}): Task => ({
    id, title, status: 'next', tags: [], contexts: [],
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', ...extra,
});

describe('saved search sort (#1453)', () => {
    afterEach(async () => {
        await flushPendingSave();
        resetForTests();
    });

    const settings = { taskSortBy: 'due' } as AppSettings;

    it('a saved search sort wins over the global sort', () => {
        expect(resolveSavedSearchSortBy({ id: 's', name: 'S', query: 'x', sort: 'start' }, settings)).toBe('start');
        expect(getSavedSearchOwnSortBy({ id: 's', name: 'S', query: 'x', sort: 'start' }, settings)).toBe('start');
        // 'default' is the app's comparator, not "follow the global sort".
        expect(resolveSavedSearchSortBy({ id: 's', name: 'S', query: 'x', sort: 'default' }, settings)).toBe('default');
    });

    it('a saved search without a sort follows the global sort', () => {
        expect(resolveSavedSearchSortBy({ id: 's', name: 'S', query: 'x' }, settings)).toBe('due');
        expect(getSavedSearchOwnSortBy({ id: 's', name: 'S', query: 'x' }, settings)).toBeNull();
        expect(resolveSavedSearchSortBy(undefined, settings)).toBe('due');
    });

    it('an unknown or gated sort shows the global sort', () => {
        expect(resolveSavedSearchSortBy({ id: 's', name: 'S', query: 'x', sort: 'mystery' }, settings)).toBe('due');
        expect(resolveSavedSearchSortBy({ id: 's', name: 'S', query: 'x', sort: 'completed' }, settings)).toBe('due');
        const noEstimates = { ...settings, features: { timeEstimates: false } } as AppSettings;
        expect(resolveSavedSearchSortBy({ id: 's', name: 'S', query: 'x', sort: 'timeEstimate' }, noEstimates)).toBe('due');
        expect(getSavedSearchOwnSortBy({ id: 's', name: 'S', query: 'x', sort: 'timeEstimate' }, noEstimates)).toBeNull();
    });

    it('the global choice label names the current global sort', () => {
        const t = (key: string) => ({ 'search.sortUseGlobal': 'Use global setting ({sort})', 'sort.due': 'Due date' }[key] ?? key);
        expect(getSavedSearchGlobalSortLabel(settings, t)).toBe('Use global setting (Due date)');
    });

    it('a sort changes order only: the same tasks match', () => {
        const tasks = [
            task('a', 'alpha milk', { startTime: '2026-03-01' }),
            task('b', 'beta milk', { startTime: '2099-01-01' }),
            task('c', 'gamma milk', { status: 'waiting' }),
            task('d', 'delta bread'),
        ];
        const base = { query: 'milk', tasks, projects: [], areaFilter: { included: [], excluded: [] } as never, areaById: new Map() };
        const byTitle = selectSavedSearchTasks({ ...base, sortBy: 'title' }).map((entry) => entry.id);
        const byStart = selectSavedSearchTasks({ ...base, sortBy: 'start' }).map((entry) => entry.id);
        expect([...byTitle].sort()).toEqual([...byStart].sort());
        expect(byTitle).toContain('b');
        expect(byTitle).not.toContain('d');
    });

    it('a choice writes only that saved search; clearing removes its sort; a repeat writes nothing', async () => {
        const writes: unknown[] = [];
        const searches: SavedSearch[] = [
            { id: 'one', name: 'One', query: 'status:next', groupBy: 'project' },
            { id: 'two', name: 'Two', query: '@home', sort: 'mystery' },
        ];
        setStorageAdapter({
            getData: async () => ({ tasks: [], projects: [], sections: [], areas: [], settings: { savedSearches: searches } }),
            saveData: async (data) => { writes.push(data); },
        });
        await useTaskStore.getState().fetchData();
        const other = useTaskStore.getState().settings.savedSearches![1];

        expect(await setSavedSearchSortById('one', 'start')).toBe(true);
        let stored = useTaskStore.getState().settings.savedSearches!;
        expect(stored[0]).toEqual({ id: 'one', name: 'One', query: 'status:next', groupBy: 'project', sort: 'start' });
        expect(stored[1]).toBe(other);
        expect(useTaskStore.getState().settings.taskSortBy).toBeUndefined();

        expect(await setSavedSearchSortById('one', 'start')).toBe(false);
        expect(await setSavedSearchSortById('gone', 'due')).toBe(false);

        expect(await setSavedSearchSortById('one', null)).toBe(true);
        stored = useTaskStore.getState().settings.savedSearches!;
        expect(stored[0]).toEqual({ id: 'one', name: 'One', query: 'status:next', groupBy: 'project' });
        expect('sort' in stored[0]).toBe(false);
        expect(await setSavedSearchSortById('one', null)).toBe(false);
        // The unknown value on the other search was never erased.
        expect(useTaskStore.getState().settings.savedSearches![1].sort).toBe('mystery');
    });
});
