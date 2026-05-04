import { describe, expect, it } from 'vitest';
import type { Project, Task } from '@mindwtr/core';
import { computeGlobalSearchResults } from './global-search-filtering';

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
    duePreset: 'any',
    scope: 'all',
    weekStart: 'sunday',
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

    it('surfaces source result limits in the truncation label', () => {
        const result = computeGlobalSearchResults({
            query: 'needle',
            tasks: [task('task-work', 'Needle work task')],
            projects: [],
            areas: [],
            includeCompleted: false,
            includeReference: true,
            hideFutureTasks: false,
            selectedStatuses: [],
            selectedArea: 'all',
            selectedTokens: [],
            duePreset: 'any',
            scope: 'all',
            weekStart: 'sunday',
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
});
