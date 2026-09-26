import { describe, expect, it } from 'vitest';

import {
    applyFilter,
    createTaskFilterPredicate,
    hasActiveFilterCriteria,
    markSavedFilterDeleted,
    normalizeFilterCriteria,
    normalizeSavedFilters,
    SAVED_FILTER_NO_PROJECT_ID,
} from './saved-filters';
import type { SavedFilter, Task } from './types';

const task = (overrides: Partial<Task>): Task => ({
    id: overrides.id ?? 'task',
    title: overrides.title ?? 'Task',
    status: overrides.status ?? 'next',
    tags: overrides.tags ?? [],
    contexts: overrides.contexts ?? [],
    createdAt: overrides.createdAt ?? '2026-05-01T10:00:00.000Z',
    updatedAt: overrides.updatedAt ?? '2026-05-01T10:00:00.000Z',
    ...overrides,
});

describe('saved filters', () => {
    it('combines criteria with AND and values within a criterion with OR', () => {
        const tasks = [
            task({ id: 'desk-high', contexts: ['@desk'], tags: ['#urgent'], priority: 'high' }),
            task({ id: 'phone-high', contexts: ['@phone'], tags: ['#later'], priority: 'high' }),
            task({ id: 'desk-low', contexts: ['@desk'], tags: ['#urgent'], priority: 'low' }),
        ];

        const filtered = applyFilter(tasks, {
            contexts: ['@desk', '@phone'],
            tags: ['#urgent'],
            priority: ['high'],
        });

        expect(filtered.map((item) => item.id)).toEqual(['desk-high']);
    });

    it('can require every selected token for Focus chip filters', () => {
        const tasks = [
            task({ id: 'desk-phone', contexts: ['@desk', '@phone'] }),
            task({ id: 'desk', contexts: ['@desk'] }),
            task({ id: 'phone', contexts: ['@phone'] }),
        ];

        const filtered = applyFilter(tasks, {
            contexts: ['@desk', '@phone'],
        }, { tokenMatchMode: 'all' });

        expect(filtered.map((item) => item.id)).toEqual(['desk-phone']);
    });

    it('can override context matching to any while keeping tag matching strict', () => {
        const tasks = [
            task({ id: 'desk-urgent', contexts: ['@desk'], tags: ['#urgent'] }),
            task({ id: 'phone-urgent', contexts: ['@phone'], tags: ['#urgent'] }),
            task({ id: 'desk-later', contexts: ['@desk'], tags: ['#later'] }),
        ];

        const filtered = applyFilter(tasks, {
            contexts: ['@desk', '@phone'],
            contextMatchMode: 'any',
            tags: ['#urgent'],
        }, { tokenMatchMode: 'all' });

        expect(filtered.map((item) => item.id)).toEqual(['desk-urgent', 'phone-urgent']);
    });

    it('can override tag matching to any while keeping context matching strict', () => {
        const tasks = [
            task({ id: 'desk-quick', contexts: ['@desk'], tags: ['#quick'] }),
            task({ id: 'desk-calls', contexts: ['@desk'], tags: ['#calls'] }),
            task({ id: 'phone-quick', contexts: ['@phone'], tags: ['#quick'] }),
        ];

        const filtered = applyFilter(tasks, {
            contexts: ['@desk'],
            tags: ['#quick', '#calls'],
            tagMatchMode: 'any',
        }, { tokenMatchMode: 'all' });

        expect(filtered.map((item) => item.id)).toEqual(['desk-quick', 'desk-calls']);
    });

    it('requires every selected tag by default when tagMatchMode is unset, matching the Focus/list caller default', () => {
        const tasks = [
            task({ id: 'both', tags: ['#quick', '#calls'] }),
            task({ id: 'quick-only', tags: ['#quick'] }),
            task({ id: 'calls-only', tags: ['#calls'] }),
        ];

        const filtered = applyFilter(tasks, {
            tags: ['#quick', '#calls'],
        }, { tokenMatchMode: 'all' });

        expect(filtered.map((item) => item.id)).toEqual(['both']);
    });

    it('requires every selected tag when tagMatchMode is explicitly all', () => {
        const tasks = [
            task({ id: 'both', tags: ['#quick', '#calls'] }),
            task({ id: 'quick-only', tags: ['#quick'] }),
        ];

        const filtered = applyFilter(tasks, {
            tags: ['#quick', '#calls'],
            tagMatchMode: 'all',
        }, { tokenMatchMode: 'any' });

        expect(filtered.map((item) => item.id)).toEqual(['both']);
    });

    it('subtracts tasks carrying an excluded tag even when they match every include', () => {
        const tasks = [
            task({ id: 'keep', contexts: ['@desk'], tags: ['#urgent'] }),
            task({ id: 'drop', contexts: ['@desk'], tags: ['#urgent', '#waiting'] }),
        ];

        const filtered = applyFilter(tasks, {
            contexts: ['@desk'],
            tags: ['#urgent'],
            excludedTags: ['#waiting'],
        }, { tokenMatchMode: 'all' });

        expect(filtered.map((item) => item.id)).toEqual(['keep']);
    });

    it('excludes hierarchically: a parent excluded token drops child tokens', () => {
        const tasks = [
            task({ id: 'chores', tags: ['#home/chores'] }),
            task({ id: 'garden', tags: ['#home/garden'] }),
            task({ id: 'work', tags: ['#work'] }),
        ];

        const filtered = applyFilter(tasks, { excludedTags: ['#home'] });

        expect(filtered.map((item) => item.id)).toEqual(['work']);
    });

    it('excludes with ANY semantics regardless of the tag match mode', () => {
        const tasks = [
            task({ id: 'keep', contexts: ['@desk'] }),
            task({ id: 'drop-home', contexts: ['@desk', '@home'] }),
            task({ id: 'drop-car', contexts: ['@desk', '@car'] }),
        ];

        const filtered = applyFilter(tasks, {
            contexts: ['@desk'],
            excludedContexts: ['@home', '@car'],
            contextMatchMode: 'all',
        }, { tokenMatchMode: 'all' });

        expect(filtered.map((item) => item.id)).toEqual(['keep']);
    });

    it('matches a stored bare context/tag token against a prefixed filter selection (#1013 dead-filter symptom)', () => {
        const tasks = [
            task({ id: 'bare-home', contexts: ['home'], tags: ['urgent'] }),
            task({ id: 'prefixed-office', contexts: ['@office'], tags: ['#later'] }),
        ];

        const filtered = applyFilter(tasks, {
            contexts: ['@home'],
            tags: ['#urgent'],
        });

        expect(filtered.map((item) => item.id)).toEqual(['bare-home']);
    });

    it('excludes a task carrying a stored bare token when the excluded filter is prefixed', () => {
        const tasks = [
            task({ id: 'keep', contexts: ['@desk'] }),
            task({ id: 'drop-bare-home', contexts: ['@desk', 'home'] }),
        ];

        const filtered = applyFilter(tasks, {
            contexts: ['@desk'],
            excludedContexts: ['@home'],
        });

        expect(filtered.map((item) => item.id)).toEqual(['keep']);
    });

    it('normalization drops an excluded token that is also included (include wins)', () => {
        const normalized = normalizeFilterCriteria({
            contexts: ['@desk', '@phone'],
            excludedContexts: ['@phone', '@home'],
            tags: ['#urgent'],
            excludedTags: ['#urgent'],
        });

        expect(normalized.excludedContexts).toEqual(['@home']);
        expect(normalized.excludedTags).toBeUndefined();
    });

    it('counts excluded lists as active filter criteria', () => {
        expect(hasActiveFilterCriteria({ excludedTags: ['#waiting'] })).toBe(true);
    });

    it('supports due date presets and no-project filters', () => {
        const now = new Date('2026-05-09T12:00:00.000Z');
        const tasks = [
            task({ id: 'today', dueDate: '2026-05-09', projectId: undefined }),
            task({ id: 'tomorrow', dueDate: '2026-05-10', projectId: undefined }),
            task({ id: 'project', dueDate: '2026-05-09', projectId: 'project-1' }),
        ];

        const filtered = applyFilter(tasks, {
            dueDateRange: { preset: 'today' },
            projects: [SAVED_FILTER_NO_PROJECT_ID],
        }, { now });

        expect(filtered.map((item) => item.id)).toEqual(['today']);
    });

    it('supports time estimate ranges and empty priority matching', () => {
        const tasks = [
            task({ id: 'short', timeEstimate: '10min' }),
            task({ id: 'medium', timeEstimate: '1hr' }),
            task({ id: 'prioritized', priority: 'high', timeEstimate: '30min' }),
        ];

        const filtered = applyFilter(tasks, {
            priority: ['none'],
            timeEstimateRange: { min: 30, max: 90 },
        });

        expect(filtered.map((item) => item.id)).toEqual(['medium']);
    });

    it('matches custom time estimates by preset bucket while preserving exact ranges', () => {
        const tasks = [
            task({ id: 'preset-2h', timeEstimate: '2hr' }),
            task({ id: 'custom-150', timeEstimate: 'custom:150' }),
            task({ id: 'preset-3h', timeEstimate: '3hr' }),
        ];

        expect(applyFilter(tasks, { timeEstimates: ['3hr'] }).map((item) => item.id)).toEqual(['custom-150', 'preset-3h']);
        expect(applyFilter(tasks, { timeEstimateRange: { min: 130, max: 160 } }).map((item) => item.id)).toEqual(['custom-150']);
    });

    it('matches location criteria by case-insensitive text', () => {
        const tasks = [
            task({ id: 'office', location: 'Main Office' }),
            task({ id: 'home', location: 'Home desk' }),
            task({ id: 'none' }),
        ];

        const filtered = applyFilter(tasks, {
            locations: ['office'],
        });

        expect(filtered.map((item) => item.id)).toEqual(['office']);
    });

    it('prepares the project lookup once when applying area filters', () => {
        const OriginalMap = globalThis.Map;
        const setGlobalMap = (value: MapConstructor) => {
            (globalThis as typeof globalThis & { Map: MapConstructor }).Map = value;
        };
        let mapConstructions = 0;
        class CountingMap<K, V> extends OriginalMap<K, V> {
            constructor(entries?: Iterable<readonly [K, V]> | null) {
                mapConstructions += 1;
                super(entries);
            }
        }
        setGlobalMap(CountingMap as unknown as MapConstructor);

        try {
            const tasks = [
                task({ id: 'work-a', projectId: 'project-work' }),
                task({ id: 'work-b', projectId: 'project-work' }),
                task({ id: 'home', projectId: 'project-home' }),
            ];

            const filtered = applyFilter(tasks, {
                areas: ['area-work'],
            }, {
                projects: [
                    { id: 'project-work', title: 'Work', status: 'active', areaId: 'area-work', createdAt: '2026-05-01T00:00:00.000Z', updatedAt: '2026-05-01T00:00:00.000Z' },
                    { id: 'project-home', title: 'Home', status: 'active', areaId: 'area-home', createdAt: '2026-05-01T00:00:00.000Z', updatedAt: '2026-05-01T00:00:00.000Z' },
                ],
            });

            expect(filtered.map((item) => item.id)).toEqual(['work-a', 'work-b']);
            expect(mapConstructions).toBe(1);
        } finally {
            setGlobalMap(OriginalMap);
        }
    });

    it('creates a reusable predicate without rebuilding project lookup per task', () => {
        const OriginalMap = globalThis.Map;
        const setGlobalMap = (value: MapConstructor) => {
            (globalThis as typeof globalThis & { Map: MapConstructor }).Map = value;
        };
        let mapConstructions = 0;
        class CountingMap<K, V> extends OriginalMap<K, V> {
            constructor(entries?: Iterable<readonly [K, V]> | null) {
                mapConstructions += 1;
                super(entries);
            }
        }
        setGlobalMap(CountingMap as unknown as MapConstructor);

        try {
            const tasks = [
                task({ id: 'work-a', projectId: 'project-work' }),
                task({ id: 'work-b', projectId: 'project-work' }),
                task({ id: 'home', projectId: 'project-home' }),
            ];
            const predicate = createTaskFilterPredicate({
                areas: ['area-work'],
            }, {
                projects: [
                    { id: 'project-work', title: 'Work', status: 'active', areaId: 'area-work', createdAt: '2026-05-01T00:00:00.000Z', updatedAt: '2026-05-01T00:00:00.000Z' },
                    { id: 'project-home', title: 'Home', status: 'active', areaId: 'area-home', createdAt: '2026-05-01T00:00:00.000Z', updatedAt: '2026-05-01T00:00:00.000Z' },
                ],
            });

            expect(tasks.filter(predicate).map((item) => item.id)).toEqual(['work-a', 'work-b']);
            expect(tasks.filter(predicate).map((item) => item.id)).toEqual(['work-a', 'work-b']);
            expect(mapConstructions).toBe(1);
        } finally {
            setGlobalMap(OriginalMap);
        }
    });

    it('normalizes saved filter payloads for settings sync and storage', () => {
        const filters = normalizeSavedFilters([
            {
                id: 'filter-1',
                name: ' Desk ',
                view: 'focus',
                criteria: {
                    contexts: ['desk', '@desk'],
                    contextMatchMode: 'any',
                    tags: ['quick', '#calls'],
                    tagMatchMode: 'any',
                    priority: ['high', 'invalid'],
                    locations: [' Office ', ''],
                },
                sortBy: 'start',
                sortOrder: 'asc',
                groupBy: 'project',
                createdAt: '2026-05-02T00:00:00.000Z',
                updatedAt: '2026-05-02T00:00:00.000Z',
                deletedAt: '2026-05-03T00:00:00.000Z',
            },
            { id: '', name: 'Invalid', view: 'focus', criteria: {} },
        ]);

        expect(filters).toHaveLength(1);
        expect(filters[0]).toMatchObject({
            id: 'filter-1',
            name: 'Desk',
            criteria: {
                contexts: ['@desk'],
                contextMatchMode: 'any',
                tags: ['#quick', '#calls'],
                tagMatchMode: 'any',
                priority: ['high'],
                locations: ['Office'],
            },
            sortBy: 'start',
            sortOrder: 'asc',
            groupBy: 'project',
            deletedAt: '2026-05-03T00:00:00.000Z',
        });
        expect(hasActiveFilterCriteria(filters[0]?.criteria)).toBe(true);
    });

    it('preserves tag grouping for saved Focus filters', () => {
        const filters = normalizeSavedFilters([
            {
                id: 'filter-1',
                name: 'Tag view',
                view: 'focus',
                criteria: { tags: ['#deep'] },
                groupBy: 'tag',
                createdAt: '2026-05-02T00:00:00.000Z',
                updatedAt: '2026-05-02T00:00:00.000Z',
            },
        ]);

        expect(filters[0]?.groupBy).toBe('tag');
    });

    it('marks saved filters as tombstones instead of removing them', () => {
        const filters = markSavedFilterDeleted([
            {
                id: 'filter-1',
                name: 'Desk',
                view: 'focus',
                criteria: { contexts: ['@desk'] },
                createdAt: '2026-05-02T00:00:00.000Z',
                updatedAt: '2026-05-02T00:00:00.000Z',
            },
        ], 'filter-1', '2026-05-03T00:00:00.000Z');

        expect(filters).toEqual([
            expect.objectContaining({
                id: 'filter-1',
                updatedAt: '2026-05-03T00:00:00.000Z',
                deletedAt: '2026-05-03T00:00:00.000Z',
            }),
        ]);
    });

    it('changes only the deleted entry: every other one stays as stored, in stored order', () => {
        // A newer app's view and fields, stored after an older filter.
        const newer = {
            id: 'filter-newer',
            name: 'Board lane',
            view: 'board-lane',
            criteria: { contexts: ['@desk'], futureCriterion: true },
            futureField: 'kept',
            createdAt: '2026-05-05T00:00:00.000Z',
            updatedAt: '2026-05-05T00:00:00.000Z',
        } as unknown as SavedFilter;
        const older: SavedFilter = {
            id: 'filter-older',
            name: 'Desk',
            view: 'focus',
            criteria: { contexts: ['@desk'] },
            createdAt: '2026-05-01T00:00:00.000Z',
            updatedAt: '2026-05-01T00:00:00.000Z',
        };
        const doomed = { ...older, id: 'filter-doomed', name: 'Doomed', futureField: 'kept too' } as SavedFilter;
        const stored = [newer, doomed, older];
        const before = structuredClone(stored);

        const filters = markSavedFilterDeleted(stored, 'filter-doomed', '2026-05-06T00:00:00.000Z');

        expect(filters).toEqual([
            newer,
            { ...doomed, updatedAt: '2026-05-06T00:00:00.000Z', deletedAt: '2026-05-06T00:00:00.000Z' },
            older,
        ]);
        expect(filters[0]).toBe(newer);
        expect(stored).toEqual(before);
    });
});
