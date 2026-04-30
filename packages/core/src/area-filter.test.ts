import { describe, expect, it } from 'vitest';

import type { Area, Project, Task } from './types';
import {
    AREA_FILTER_ALL,
    AREA_FILTER_NONE,
    projectMatchesAreaFilter,
    resolveAreaFilter,
    taskMatchesAreaFilter,
} from './area-filter';

const workArea: Area = {
    id: 'area-work',
    name: 'Work',
    order: 0,
    createdAt: '2026-03-16T00:00:00.000Z',
    updatedAt: '2026-03-16T00:00:00.000Z',
};

const project: Project = {
    id: 'project-1',
    title: 'Website',
    status: 'active',
    color: '#3b82f6',
    order: 0,
    tagIds: [],
    areaId: workArea.id,
    createdAt: '2026-03-16T00:00:00.000Z',
    updatedAt: '2026-03-16T00:00:00.000Z',
};

const baseTask: Task = {
    id: 'task-1',
    title: 'Ship changes',
    status: 'next',
    tags: [],
    contexts: [],
    createdAt: '2026-03-16T00:00:00.000Z',
    updatedAt: '2026-03-16T00:00:00.000Z',
};

describe('area filter utils', () => {
    it('resolves missing, deleted, and stale area filters to all areas', () => {
        expect(resolveAreaFilter(undefined, [workArea])).toBe(AREA_FILTER_ALL);
        expect(resolveAreaFilter('missing-area', [workArea])).toBe(AREA_FILTER_ALL);
        expect(resolveAreaFilter(workArea.id, [workArea])).toBe(workArea.id);
        expect(resolveAreaFilter(workArea.id, [{ ...workArea, deletedAt: '2026-03-17T00:00:00.000Z' }])).toBe(AREA_FILTER_ALL);
    });

    it('matches projects against all, none, and explicit areas', () => {
        const areaById = new Map([[workArea.id, workArea]]);

        expect(projectMatchesAreaFilter(project, AREA_FILTER_ALL, areaById)).toBe(true);
        expect(projectMatchesAreaFilter(project, workArea.id, areaById)).toBe(true);
        expect(projectMatchesAreaFilter(project, AREA_FILTER_NONE, areaById)).toBe(false);
        expect(projectMatchesAreaFilter({ ...project, areaId: undefined }, AREA_FILTER_NONE, areaById)).toBe(true);
    });

    it('matches tasks using the project area when present', () => {
        const projectById = new Map([[project.id, project]]);
        const areaById = new Map([[workArea.id, workArea]]);

        expect(taskMatchesAreaFilter({ ...baseTask, projectId: project.id }, AREA_FILTER_ALL, projectById, areaById)).toBe(true);
        expect(taskMatchesAreaFilter({ ...baseTask, projectId: project.id }, workArea.id, projectById, areaById)).toBe(true);
        expect(taskMatchesAreaFilter({ ...baseTask, projectId: project.id }, AREA_FILTER_NONE, projectById, areaById)).toBe(false);
        expect(taskMatchesAreaFilter({ ...baseTask }, AREA_FILTER_NONE, projectById, areaById)).toBe(true);
    });
});
