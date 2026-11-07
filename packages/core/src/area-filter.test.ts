import { describe, expect, it } from 'vitest';

import type { Area, Project, Task } from './types';
import {
    AREA_FILTER_ALL,
    AREA_FILTER_NONE,
    areaFilterSelectionToFilters,
    areaFilterSelectionToValue,
    cycleAreaFilterSelection,
    excludeAllAreas,
    isAreaFilterSelectionActive,
    isAreaVisibleInSelection,
    projectMatchesAreaFilterSelection,
    resolveAreaFilterSelection,
    isTaskVisibleInArea,
    isTaskVisibleInInbox,
    taskMatchesAreaFilterSelection,
    toggleAreaVisibility,
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

const homeArea: Area = { ...workArea, id: 'area-home', name: 'Home' };
const deletedArea: Area = { ...workArea, id: 'area-old', name: 'Old', deletedAt: '2026-03-17T00:00:00.000Z' };
const allAreas = [workArea, homeArea, deletedArea];

describe('area filter selection', () => {
    it('reads the legacy single-value filter', () => {
        expect(resolveAreaFilterSelection(undefined, allAreas)).toEqual({ included: [], excluded: [] });
        expect(resolveAreaFilterSelection(AREA_FILTER_ALL, allAreas)).toEqual({ included: [], excluded: [] });
        expect(resolveAreaFilterSelection(AREA_FILTER_NONE, allAreas)).toEqual({ included: [AREA_FILTER_NONE], excluded: [] });
        expect(resolveAreaFilterSelection(workArea.id, allAreas)).toEqual({ included: [workArea.id], excluded: [] });
        expect(resolveAreaFilterSelection('missing-area', allAreas)).toEqual({ included: [], excluded: [] });
        expect(resolveAreaFilterSelection(deletedArea.id, allAreas)).toEqual({ included: [], excluded: [] });
        expect(resolveAreaFilterSelection({ areaId: workArea.id }, allAreas)).toEqual({ included: [workArea.id], excluded: [] });
    });

    it('reads the stored selection and drops deleted or unknown areas', () => {
        expect(resolveAreaFilterSelection(
            { areaId: AREA_FILTER_ALL, areaIds: [workArea.id, deletedArea.id, 'gone', workArea.id], excludedAreaIds: [homeArea.id] },
            allAreas,
        )).toEqual({ included: [workArea.id], excluded: [homeArea.id] });

        expect(resolveAreaFilterSelection({ areaId: workArea.id, areaIds: [] }, allAreas)).toEqual({ included: [], excluded: [] });
        expect(resolveAreaFilterSelection({ areaIds: 'nope' }, allAreas)).toEqual({ included: [], excluded: [] });
    });

    it('matches the union of inclusions minus the exclusions', () => {
        const projectById = new Map([[project.id, project]]);
        const areaById = new Map([[workArea.id, workArea], [homeArea.id, homeArea]]);
        const homeProject: Project = { ...project, id: 'project-2', areaId: homeArea.id };
        const orphanProject: Project = { ...project, id: 'project-3', areaId: undefined };
        const match = (selection: { included: string[]; excluded: string[] }) => [
            projectMatchesAreaFilterSelection(project, selection, areaById),
            projectMatchesAreaFilterSelection(homeProject, selection, areaById),
            projectMatchesAreaFilterSelection(orphanProject, selection, areaById),
        ];

        expect(match({ included: [], excluded: [] })).toEqual([true, true, true]);
        expect(match({ included: [homeArea.id], excluded: [] })).toEqual([false, true, false]);
        expect(match({ included: [], excluded: [workArea.id] })).toEqual([false, true, true]);
        expect(match({ included: [workArea.id, homeArea.id], excluded: [homeArea.id] })).toEqual([true, false, false]);
        expect(match({ included: [AREA_FILTER_NONE], excluded: [] })).toEqual([false, false, true]);
        expect(match({ included: [], excluded: [AREA_FILTER_NONE] })).toEqual([true, true, false]);

        const workTask = { ...baseTask, projectId: project.id };
        expect(taskMatchesAreaFilterSelection(workTask, { included: [], excluded: [] }, projectById, areaById)).toBe(true);
        expect(taskMatchesAreaFilterSelection(workTask, { included: [homeArea.id], excluded: [] }, projectById, areaById)).toBe(false);
        expect(taskMatchesAreaFilterSelection(workTask, { included: [], excluded: [workArea.id] }, projectById, areaById)).toBe(false);
        expect(taskMatchesAreaFilterSelection(baseTask, { included: [AREA_FILTER_NONE], excluded: [] }, projectById, areaById)).toBe(true);
        expect(taskMatchesAreaFilterSelection(baseTask, { included: [], excluded: [AREA_FILTER_NONE] }, projectById, areaById)).toBe(false);
    });

    it('cycles a row through included, excluded and unselected', () => {
        const start = { included: [], excluded: [] };
        const included = cycleAreaFilterSelection(start, workArea.id);
        expect(included).toEqual({ included: [workArea.id], excluded: [] });
        const excluded = cycleAreaFilterSelection(included, workArea.id);
        expect(excluded).toEqual({ included: [], excluded: [workArea.id] });
        expect(cycleAreaFilterSelection(excluded, workArea.id)).toEqual({ included: [], excluded: [] });
    });

    it('mirrors a single selected area into the legacy value', () => {
        expect(isAreaFilterSelectionActive({ included: [], excluded: [] })).toBe(false);
        expect(isAreaFilterSelectionActive({ included: [], excluded: [workArea.id] })).toBe(true);

        expect(areaFilterSelectionToValue({ included: [], excluded: [] })).toBe(AREA_FILTER_ALL);
        expect(areaFilterSelectionToValue({ included: [workArea.id], excluded: [] })).toBe(workArea.id);
        expect(areaFilterSelectionToValue({ included: [workArea.id, homeArea.id], excluded: [] })).toBe(AREA_FILTER_ALL);
        expect(areaFilterSelectionToValue({ included: [workArea.id], excluded: [homeArea.id] })).toBe(AREA_FILTER_ALL);
        expect(areaFilterSelectionToFilters({ included: [workArea.id], excluded: [homeArea.id] })).toEqual({
            areaId: AREA_FILTER_ALL,
            areaIds: [workArea.id],
            excludedAreaIds: [homeArea.id],
        });
    });

    it('round-trips what it stores', () => {
        const selection = { included: [workArea.id, AREA_FILTER_NONE], excluded: [homeArea.id] };
        expect(resolveAreaFilterSelection(areaFilterSelectionToFilters(selection), allAreas)).toEqual(selection);
    });
});

describe('area visibility toggles', () => {
    const optionIds = [workArea.id, homeArea.id, AREA_FILTER_NONE];
    const visibleIds = (selection: { included: string[]; excluded: string[] }, ids = optionIds) =>
        ids.filter((id) => isAreaVisibleInSelection(selection, id));

    it('reads visibility from either stored form', () => {
        expect(visibleIds({ included: [], excluded: [] })).toEqual(optionIds);
        expect(visibleIds({ included: [homeArea.id], excluded: [] })).toEqual([homeArea.id]);
        expect(visibleIds({ included: [], excluded: [workArea.id] })).toEqual([homeArea.id, AREA_FILTER_NONE]);
        expect(visibleIds({ included: [workArea.id, homeArea.id], excluded: [homeArea.id] })).toEqual([workArea.id]);
    });

    it('hides one area from the unfiltered state as an exclusion', () => {
        expect(toggleAreaVisibility({ included: [], excluded: [] }, workArea.id, optionIds))
            .toEqual({ included: [], excluded: [workArea.id] });
    });

    it('clears the filter when the last hidden area is shown again', () => {
        expect(toggleAreaVisibility({ included: [], excluded: [workArea.id] }, workArea.id, optionIds))
            .toEqual({ included: [], excluded: [] });
    });

    it('stores a single visible area as an inclusion so it stays the active area', () => {
        const single = toggleAreaVisibility({ included: [], excluded: [homeArea.id] }, AREA_FILTER_NONE, optionIds);
        expect(single).toEqual({ included: [workArea.id], excluded: [] });
        expect(areaFilterSelectionToValue(single)).toBe(workArea.id);
        expect(toggleAreaVisibility(excludeAllAreas(optionIds), homeArea.id, optionIds))
            .toEqual({ included: [homeArea.id], excluded: [] });
    });

    it('normalizes a multi-area inclusion into exclusions', () => {
        expect(toggleAreaVisibility({ included: [workArea.id], excluded: [] }, homeArea.id, optionIds))
            .toEqual({ included: [], excluded: [AREA_FILTER_NONE] });
        expect(toggleAreaVisibility({ included: [workArea.id, homeArea.id], excluded: [] }, homeArea.id, optionIds))
            .toEqual({ included: [workArea.id], excluded: [] });
    });

    it('hides every option and can hide the only one', () => {
        expect(excludeAllAreas(optionIds)).toEqual({ included: [], excluded: optionIds });
        expect(visibleIds(excludeAllAreas(optionIds))).toEqual([]);
        expect(toggleAreaVisibility({ included: [], excluded: [] }, AREA_FILTER_NONE, [AREA_FILTER_NONE]))
            .toEqual({ included: [], excluded: [AREA_FILTER_NONE] });
        expect(toggleAreaVisibility({ included: [], excluded: [AREA_FILTER_NONE] }, AREA_FILTER_NONE, [AREA_FILTER_NONE]))
            .toEqual({ included: [], excluded: [] });
    });

    it('shows a new area unless a single area is selected', () => {
        const withNewArea = [...optionIds, 'area-new'];
        expect(isAreaVisibleInSelection(excludeAllAreas(optionIds), 'area-new')).toBe(true);
        const partial = toggleAreaVisibility({ included: [], excluded: [] }, workArea.id, optionIds);
        expect(visibleIds(partial, withNewArea)).toEqual([homeArea.id, AREA_FILTER_NONE, 'area-new']);
        const single = toggleAreaVisibility({ included: [], excluded: [homeArea.id] }, AREA_FILTER_NONE, optionIds);
        expect(isAreaVisibleInSelection(single, 'area-new')).toBe(false);
    });
});

describe('isTaskVisibleInArea', () => {
    const areaById = new Map([[workArea.id, workArea], [homeArea.id, homeArea]]);
    const ctxFor = (projects: Project[], resolvedAreaFilter = { included: [] as string[], excluded: [] as string[] }) => ({
        areaById,
        projectById: new Map(projects.map((entry) => [entry.id, entry])),
        resolvedAreaFilter,
    });

    it('accepts a loose task with no filter active', () => {
        expect(isTaskVisibleInArea(baseTask, ctxFor([project]))).toBe(true);
    });


    it('rejects a soft-deleted task', () => {
        expect(isTaskVisibleInArea({ ...baseTask, deletedAt: '2026-03-17T00:00:00.000Z' }, ctxFor([project]))).toBe(false);
    });

    it('rejects a task whose project is parked', () => {
        const somedayProject: Project = { ...project, status: 'someday' };
        const task = { ...baseTask, projectId: project.id };
        expect(isTaskVisibleInArea(task, ctxFor([somedayProject]))).toBe(false);
        expect(isTaskVisibleInArea(task, ctxFor([{ ...somedayProject, isFocused: true }]))).toBe(true);
    });

    it('rejects a task outside the area selection', () => {
        const task = { ...baseTask, projectId: project.id };
        expect(isTaskVisibleInArea(task, ctxFor([project], { included: [homeArea.id], excluded: [] }))).toBe(false);
        expect(isTaskVisibleInArea(task, ctxFor([project], { included: [], excluded: [workArea.id] }))).toBe(false);
        expect(isTaskVisibleInArea(task, ctxFor([project], { included: [workArea.id], excluded: [] }))).toBe(true);
    });

    it('keeps a purged task hidden without any purgedAt clause of its own', () => {
        const purged = { ...baseTask, deletedAt: '2026-03-17T00:00:00.000Z', purgedAt: '2026-03-18T00:00:00.000Z' };
        expect(isTaskVisibleInArea(purged, ctxFor([project]))).toBe(false);
    });
});

describe('isTaskVisibleInInbox', () => {
    const personalArea: Area = { ...homeArea, id: 'area-personal', name: 'Personal' };
    const personalProject: Project = {
        ...project,
        id: 'project-personal',
        areaId: personalArea.id,
    };
    const parkedProject: Project = {
        ...project,
        id: 'project-parked',
        status: 'someday',
    };
    const projectById = new Map([
        [project.id, project],
        [personalProject.id, personalProject],
        [parkedProject.id, parkedProject],
    ]);

    it('keeps eligible tasks from every area and with no area in the global Inbox scope', () => {
        const tasks = [
            { ...baseTask, id: 'work-direct', status: 'inbox' as const, areaId: workArea.id },
            { ...baseTask, id: 'personal-project', status: 'inbox' as const, projectId: personalProject.id },
            { ...baseTask, id: 'unassigned', status: 'inbox' as const },
        ];

        expect(tasks.filter((task) => isTaskVisibleInInbox(task, { projectById })).map((task) => task.id))
            .toEqual(['work-direct', 'personal-project', 'unassigned']);
    });

    it('retains deleted and parked-project exclusions without applying a status rule', () => {
        const visibleReturningTask = { ...baseTask, id: 'returning', status: 'someday' as const };
        const deleted = {
            ...baseTask,
            id: 'deleted',
            status: 'inbox' as const,
            deletedAt: '2026-03-17T00:00:00.000Z',
        };
        const parked = { ...baseTask, id: 'parked', status: 'inbox' as const, projectId: parkedProject.id };

        expect(isTaskVisibleInInbox(visibleReturningTask, { projectById })).toBe(true);
        expect(isTaskVisibleInInbox(deleted, { projectById })).toBe(false);
        expect(isTaskVisibleInInbox(parked, { projectById })).toBe(false);
    });
});
