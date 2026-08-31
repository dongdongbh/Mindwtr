import { describe, expect, it } from 'vitest';
import {
    computeGlobalSearchResults,
    getGlobalSearchFilterPresentation,
    type ComputeGlobalSearchResultsInput,
} from './global-search-filter';
import type { Project, Task } from './types';

const now = '2026-05-03T00:00:00.000Z';

const task = (id: string, title: string, areaId?: string): Task => ({
    id,
    title,
    status: 'next',
    tags: [],
    contexts: [],
    areaId,
    createdAt: now,
    updatedAt: now,
});

const project = (id: string, title: string, areaId?: string): Project => ({
    id,
    title,
    status: 'active',
    color: '#6B7280',
    order: 0,
    tagIds: [],
    areaId,
    createdAt: now,
    updatedAt: now,
});

const run = (overrides: Partial<ComputeGlobalSearchResultsInput>) => computeGlobalSearchResults({
    query: 'needle',
    tasks: [],
    projects: [],
    areas: [],
    includeCompleted: false,
    includeReference: true,
    hideFutureTasks: false,
    selectedStatuses: [],
    selectedArea: 'all',
    selectedTokens: [],
    locationQuery: '',
    duePreset: 'any',
    scope: 'all',
    weekStart: 'sunday',
    ...overrides,
});

const compute = (selectedArea: string) => computeGlobalSearchResults({
    query: 'needle',
    tasks: [
        task('task-work', 'Needle work task', 'area-work'),
        task('task-home', 'Needle home task', 'area-home'),
        { ...task('task-project', 'Needle project task'), projectId: 'project-home' },
    ],
    projects: [
        project('project-work', 'Needle work project', 'area-work'),
        project('project-home', 'Needle home project', 'area-home'),
    ],
    areas: [
        { id: 'area-work' },
        { id: 'area-home' },
    ],
    includeCompleted: false,
    includeReference: true,
    hideFutureTasks: false,
    selectedStatuses: [],
    selectedArea,
    selectedTokens: [],
    locationQuery: '',
    duePreset: 'any',
    scope: 'all',
    weekStart: 'sunday',
});

describe('getGlobalSearchFilterPresentation', () => {
    it('maps every shared filter value through its translation key', () => {
        const labels = getGlobalSearchFilterPresentation((key) => `translated:${key}`);

        expect(labels.sections).toEqual({
            status: 'translated:taskEdit.statusLabel',
            scope: 'translated:search.scope.label',
            area: 'translated:taskEdit.areaLabel',
            due: 'translated:search.due.label',
            tokens: 'translated:filters.contexts',
        });
        expect(labels.scope).toEqual({
            all: 'translated:search.scope.all',
            projects: 'translated:search.scope.projects',
            tasks: 'translated:search.scope.tasks',
            project_tasks: 'translated:search.scope.projectTasks',
        });
        expect(labels.due).toEqual({
            any: 'translated:search.due.any',
            none: 'translated:search.due.none',
            overdue: 'translated:search.due.overdue',
            today: 'translated:search.due.today',
            tomorrow: 'translated:search.due.tomorrow',
            this_week: 'translated:search.due.thisWeek',
            next_week: 'translated:search.due.nextWeek',
        });
        expect(labels.clear).toBe('translated:filters.clear');
    });
});

describe('computeGlobalSearchResults', () => {
    it('returns matches across every area when all areas is selected', () => {
        const result = compute('all');

        expect(result.results.map((item) => item.item.id)).toEqual([
            'project-work',
            'project-home',
            'task-work',
            'task-home',
            'task-project',
        ]);
    });

    it('still narrows tasks and projects when an explicit area is selected', () => {
        const result = compute('area-home');

        expect(result.results.map((item) => item.item.id)).toEqual([
            'project-home',
            'task-home',
            'task-project',
        ]);
    });

    // FTS answers arrive debounced and async, so mid-typing they describe an
    // older query; merging them first made the visible list reshuffle on every
    // keystroke.
    it('ignores full-text results fetched for a different query', () => {
        const result = run({
            query: 'Needle work',
            tasks: [task('task-work', 'Needle work task')],
            ftsResults: {
                tasks: [task('task-stale', 'Needle stale hit')],
                projects: [],
            },
            ftsQuery: 'Needle',
        });

        expect(result.results.map((item) => item.item.id)).toEqual(['task-work']);
    });

    it('merges full-text results once they answer the current query', () => {
        const result = run({
            query: 'Needle',
            tasks: [task('task-work', 'Needle work task')],
            ftsResults: {
                tasks: [task('task-fts', 'Needle fts task')],
                projects: [],
            },
            ftsQuery: 'Needle',
        });

        expect(result.results.map((item) => item.item.id)).toEqual(['task-fts', 'task-work']);
    });

    it('surfaces source result limits in the truncation label', () => {
        const result = run({
            tasks: [task('task-work', 'Needle work task')],
            ftsResults: {
                tasks: [task('task-fts', 'Needle fts task')],
                projects: [],
                limited: true,
                limit: 200,
            },
        });

        expect(result.isTruncated).toBe(true);
        expect(result.totalResultsLabel).toBe('200+');
    });

    it('narrows task results by location text', () => {
        const result = run({
            tasks: [
                { ...task('task-office', 'Needle office task'), location: 'Main Office' },
                { ...task('task-home', 'Needle home task'), location: 'Home desk' },
            ],
            projects: [project('project-work', 'Needle work project', 'area-work')],
            areas: [{ id: 'area-work' }],
            locationQuery: 'office',
        });

        expect(result.results.map((item) => item.item.id)).toEqual(['task-office']);
    });

    it('returns matching tasks when only filters are active', () => {
        const result = run({
            query: '',
            tasks: [
                { ...task('task-client-done', 'Client follow-up'), status: 'done', tags: ['#client'] },
                { ...task('task-client-archived', 'Filed client note'), status: 'archived', tags: ['#client'] },
                { ...task('task-home', 'Home task'), tags: ['#home'] },
            ],
            projects: [project('project-client', 'Client project')],
            selectedStatuses: ['done', 'archived'],
            selectedTokens: ['#client'],
            ftsResults: {
                tasks: [{ ...task('stale-result', 'Previous text result'), status: 'done', tags: ['#client'] }],
                projects: [],
            },
        });

        expect(result.hasActiveSearch).toBe(true);
        expect(result.results.map((item) => item.item.id)).toEqual([
            'task-client-done',
            'task-client-archived',
        ]);
    });

    it('keeps the empty-query prompt when no filters are active', () => {
        const result = run({
            query: '',
            tasks: [task('task-work', 'Work task')],
            projects: [project('project-work', 'Work project')],
        });

        expect(result.hasActiveSearch).toBe(false);
        expect(result.results).toEqual([]);
    });

    describe('id lookups bypass the default done/archived hiding', () => {
        const matchingId = 'c5290e2c-1b77-4f77-8927-6d187e141891';
        const idLookup = () => run({
            query: `id:${matchingId}`,
            tasks: [
                { ...task(matchingId, 'Archived sync warning task'), status: 'archived' },
                { ...task('other-task', 'Other task'), status: 'next' },
            ],
            includeReference: false,
        });

        it('keeps task id lookups visible when completed tasks are hidden by default', () => {
            expect(idLookup().results.map((item) => item.item.id)).toEqual([matchingId]);
        });

        it('reports nothing hidden when the id lookup already surfaced the task', () => {
            expect(idLookup().hiddenCompletedCount).toBe(0);
        });
    });

    describe('hiddenCompletedCount', () => {
        const hiddenInput: Partial<ComputeGlobalSearchResultsInput> = {
            tasks: [
                { ...task('task-open', 'Needle open task'), status: 'next' },
                { ...task('task-done', 'Needle done task'), status: 'done' },
                { ...task('task-archived', 'Needle archived task'), status: 'archived' },
            ],
            projects: [
                project('project-open', 'Needle open project'),
                { ...project('project-archived', 'Needle archived project'), status: 'archived' },
            ],
        };

        it('counts the completed tasks and archived projects the default hiding removed', () => {
            const result = run(hiddenInput);

            expect(result.results.map((item) => item.item.id)).toEqual(['project-open', 'task-open']);
            expect(result.hiddenCompletedCount).toBe(3);
        });

        it('drops to zero once completed matches are included', () => {
            const result = run({ ...hiddenInput, includeCompleted: true });

            expect(result.hiddenCompletedCount).toBe(0);
            expect(result.results).toHaveLength(5);
        });

        // Project hiding is independent of the task filters, so these two isolate
        // the task side by dropping the archived project from the input.
        const hiddenTasksOnly = { ...hiddenInput, projects: [project('project-open', 'Needle open project')] };

        it('ignores matches that other filters would have excluded anyway', () => {
            const result = run({
                ...hiddenTasksOnly,
                selectedTokens: ['#client'],
            });

            expect(result.hiddenCompletedCount).toBe(0);
        });

        it('stays zero while an explicit status filter is driving the results', () => {
            const result = run({ ...hiddenTasksOnly, selectedStatuses: ['next'] });

            expect(result.hiddenCompletedCount).toBe(0);
        });
    });

    describe('unknown areas', () => {
        const orphanInput: Partial<ComputeGlobalSearchResultsInput> = {
            tasks: [
                task('task-work', 'Needle work task', 'area-work'),
                task('task-orphan', 'Needle orphan task', 'area-deleted'),
            ],
            projects: [{ ...project('project-orphan', 'Needle orphan project', 'area-deleted') }],
            areas: [{ id: 'area-work' }],
        };

        it('treats a task pointing at a deleted area as having no area', () => {
            const result = run({ ...orphanInput, selectedArea: 'none' });

            expect(result.results.map((item) => item.item.id)).toEqual(['project-orphan', 'task-orphan']);
        });

        it('does not leak deleted-area items into a real area filter', () => {
            const result = run({ ...orphanInput, selectedArea: 'area-work' });

            expect(result.results.map((item) => item.item.id)).toEqual(['task-work']);
        });
    });

    describe('fts and fallback merge', () => {
        it('unions fts hits with fallback matches instead of replacing them', () => {
            const result = run({
                tasks: [
                    task('task-local', 'Needle local task'),
                    task('task-both', 'Needle shared task'),
                ],
                projects: [project('project-local', 'Needle local project')],
                ftsResults: {
                    tasks: [task('task-fts', 'Needle fts task'), task('task-both', 'Needle shared task')],
                    projects: [],
                },
            });

            expect(result.results.map((item) => item.item.id)).toEqual([
                'project-local',
                'task-fts',
                'task-both',
                'task-local',
            ]);
        });

        it('propagates a limit flag from either side of the merge', () => {
            const fromFts = run({
                tasks: [task('task-local', 'Needle local task')],
                ftsResults: {
                    tasks: [task('task-fts', 'Needle fts task')],
                    projects: [],
                    limited: true,
                    limit: 50,
                },
            });
            const fromFallback = run({
                tasks: [task('task-local', 'Needle local task')],
                ftsResults: {
                    tasks: [task('task-fts', 'Needle fts task')],
                    projects: [],
                },
            });

            expect(fromFts.totalResultsLabel).toBe('50+');
            expect(fromFts.isTruncated).toBe(true);
            expect(fromFallback.totalResultsLabel).toBe('2');
            expect(fromFallback.isTruncated).toBe(false);
        });
    });
});
