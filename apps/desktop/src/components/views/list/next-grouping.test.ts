import { describe, expect, it } from 'vitest';
import type { Area, Project, Task } from '@mindwtr/core';
import {
    CONTEXTS_AXES,
    emptyCollapsedGroups,
    FOCUS_AXES,
    getGroupAxisLabel,
    groupTasksByArea,
    groupTasksByContext,
    groupTasksByPerson,
    groupTasksByProject,
    groupTasksByTag,
    groupTasks,
    DONE_AXES,
    REFERENCE_AXES,
    SOMEDAY_AXES,
    sanitizeAxis,
    sanitizeCollapsedGroups,
    type TaskGroupAxis,
} from './next-grouping';
import { flattenVisibleGroupTasks } from './GroupedTaskSections';
import { DEFAULT_CONTEXTS_VIEW_STATE, sanitizeContextsViewState } from '../../../lib/contexts-view-state';

const baseTask = (overrides: Partial<Task>): Task => ({
    id: 'task-base',
    title: 'Task',
    status: 'next',
    tags: [],
    contexts: [],
    createdAt: '2026-03-01T00:00:00.000Z',
    updatedAt: '2026-03-01T00:00:00.000Z',
    ...overrides,
});

describe('groupTasksByArea', () => {
    it('groups next tasks by resolved area and keeps general tasks in a muted section', () => {
        const areas: Area[] = [
            {
                id: 'a1',
                name: 'Work',
                color: '#111111',
                order: 0,
                createdAt: '2026-03-01T00:00:00.000Z',
                updatedAt: '2026-03-01T00:00:00.000Z',
            },
            {
                id: 'a2',
                name: 'Home',
                color: '#222222',
                order: 1,
                createdAt: '2026-03-01T00:00:00.000Z',
                updatedAt: '2026-03-01T00:00:00.000Z',
            },
        ];
        const projectMap = new Map<string, Project>([
            ['p1', {
                id: 'p1',
                title: 'Project',
                status: 'active',
                color: '#ffffff',
                order: 0,
                tagIds: [],
                areaId: 'a1',
                createdAt: '2026-03-01T00:00:00.000Z',
                updatedAt: '2026-03-01T00:00:00.000Z',
            }],
        ]);
        const tasks = [
            baseTask({ id: 't1', title: 'General' }),
            baseTask({ id: 't2', title: 'Home task', areaId: 'a2' }),
            baseTask({ id: 't3', title: 'Work task', projectId: 'p1' }),
        ];

        const groups = groupTasksByArea({
            areas,
            tasks,
            projectMap,
            noAreaLabel: 'No area',
        });

        expect(groups.map((group) => group.title)).toEqual(['Work', 'Home', 'No area']);
        expect(groups[2]?.muted).toBe(true);
        expect(groups[0]?.tasks.map((task) => task.id)).toEqual(['t3']);
        expect(groups[1]?.tasks.map((task) => task.id)).toEqual(['t2']);
    });
});

describe('groupTasksByPerson', () => {
    it('sorts named people alphabetically and keeps the Unassigned group last', () => {
        const tasks = [
            baseTask({ id: 't1', title: 'For Zoe', assignedTo: 'Zoe' }),
            baseTask({ id: 't2', title: 'Nobody yet' }),
            baseTask({ id: 't3', title: 'For Ana', assignedTo: 'Ana' }),
        ];

        const groups = groupTasksByPerson({ tasks, unassignedLabel: 'Unassigned' });

        expect(groups.map((group) => group.title)).toEqual(['Ana', 'Zoe', 'Unassigned']);
        expect(groups[2]).toMatchObject({ id: 'person:none', muted: true });
    });
});

describe('groupTasksByContext', () => {
    it('groups tasks under every context and keeps context-less tasks in a muted section', () => {
        const tasks = [
            baseTask({ id: 't1', title: 'No context' }),
            baseTask({ id: 't2', title: 'Work', contexts: ['@work', '@deep', '@work'] }),
            baseTask({ id: 't3', title: 'Home', contexts: ['@home'] }),
        ];

        const groups = groupTasksByContext({
            tasks,
            noContextLabel: 'No context',
        });

        expect(groups.map((group) => group.title)).toEqual(['@deep', '@home', '@work', 'No context']);
        expect(groups[3]?.tasks.map((task) => task.id)).toEqual(['t1']);
        expect(groups.find((group) => group.id === 'context:@deep')?.tasks.map((task) => task.id)).toEqual(['t2']);
        expect(groups.find((group) => group.id === 'context:@work')?.tasks.map((task) => task.id)).toEqual(['t2']);
    });
});

describe('groupTasksByTag', () => {
    it('groups tasks under every tag and keeps tag-less tasks in a muted section', () => {
        const tasks = [
            baseTask({ id: 't1', title: 'No tags' }),
            baseTask({ id: 't2', title: 'Multi tag', tags: ['#work', '#deep', '#work'] }),
            baseTask({ id: 't3', title: 'Home', tags: ['#home'] }),
        ];

        const groups = groupTasksByTag({
            tasks,
            noTagLabel: 'No tags',
        });

        expect(groups.map((group) => group.title)).toEqual(['#deep', '#home', '#work', 'No tags']);
        expect(groups[3]?.muted).toBe(true);
        expect(groups.find((group) => group.id === 'tag:#deep')?.tasks.map((task) => task.id)).toEqual(['t2']);
        expect(groups.find((group) => group.id === 'tag:#work')?.tasks.map((task) => task.id)).toEqual(['t2']);
    });
});

describe('flattenVisibleGroupTasks', () => {
    const tasks = [
        baseTask({ id: 't1', title: 'Multi tag', tags: ['#work', '#deep'] }),
        baseTask({ id: 't2', title: 'Home', tags: ['#home'] }),
    ];
    const groups = groupTasksByTag({ tasks, noTagLabel: 'No tags' });

    it('lists a task in several groups only once', () => {
        // Section order, one entry per task: the keyboard walk and Select all step
        // by task, so a repeat leaves the cursor on an index no row claims (#970).
        expect(flattenVisibleGroupTasks(groups, new Set()).map((task) => task.id)).toEqual(['t1', 't2']);
    });

    it('drops the tasks of a collapsed group but keeps ones another group still shows', () => {
        const collapsed = new Set(['tag:#deep']);
        expect(flattenVisibleGroupTasks(groups, collapsed).map((task) => task.id)).toEqual(['t2', 't1']);
        expect(flattenVisibleGroupTasks(groups, new Set(['tag:#deep', 'tag:#work'])).map((task) => task.id))
            .toEqual(['t2']);
    });
});

describe('groupTasksByProject', () => {
    it('groups by project order and keeps project-less tasks in a muted section', () => {
        const projectMap = new Map<string, Project>([
            ['p1', {
                id: 'p1',
                title: 'Alpha',
                status: 'active',
                color: '#111111',
                order: 1,
                tagIds: [],
                createdAt: '2026-03-01T00:00:00.000Z',
                updatedAt: '2026-03-01T00:00:00.000Z',
            }],
            ['p2', {
                id: 'p2',
                title: 'Beta',
                status: 'active',
                color: '#222222',
                order: 0,
                tagIds: [],
                createdAt: '2026-03-01T00:00:00.000Z',
                updatedAt: '2026-03-01T00:00:00.000Z',
            }],
        ]);
        const tasks = [
            baseTask({ id: 't1', title: 'No project task' }),
            baseTask({ id: 't2', title: 'Alpha task', projectId: 'p1' }),
            baseTask({ id: 't3', title: 'Beta task', projectId: 'p2' }),
        ];

        const groups = groupTasksByProject({
            tasks,
            projectMap,
            noProjectLabel: 'No project',
        });

        expect(groups.map((group) => group.title)).toEqual(['Beta', 'Alpha', 'No project']);
        expect(groups[2]?.muted).toBe(true);
        expect(groups[0]?.tasks.map((task) => task.id)).toEqual(['t3']);
        expect(groups[1]?.tasks.map((task) => task.id)).toEqual(['t2']);
    });

    // The header dot must agree with the project chips on the rows below it,
    // which show the AREA color; the project's own color is only the fallback
    // for a project without an area (Discord report: gray header dot over
    // blue-chipped rows).
    it('colors the group dot with the area color, falling back to the project color', () => {
        const projectMap = new Map<string, Project>([
            ['p1', {
                id: 'p1',
                title: 'In area',
                status: 'active',
                color: '#6B7280',
                areaId: 'a1',
                order: 0,
                tagIds: [],
                createdAt: '2026-03-01T00:00:00.000Z',
                updatedAt: '2026-03-01T00:00:00.000Z',
            }],
            ['p2', {
                id: 'p2',
                title: 'No area',
                status: 'active',
                color: '#22C55E',
                order: 1,
                tagIds: [],
                createdAt: '2026-03-01T00:00:00.000Z',
                updatedAt: '2026-03-01T00:00:00.000Z',
            }],
        ]);
        const areas: Area[] = [{
            id: 'a1',
            name: 'Studies',
            color: '#3B82F6',
            order: 0,
            createdAt: '2026-03-01T00:00:00.000Z',
            updatedAt: '2026-03-01T00:00:00.000Z',
        }];
        const tasks = [
            baseTask({ id: 't1', title: 'A', projectId: 'p1' }),
            baseTask({ id: 't2', title: 'B', projectId: 'p2' }),
        ];

        const groups = groupTasksByProject({ tasks, projectMap, areas, noProjectLabel: 'No project' });

        expect(groups.find((group) => group.title === 'In area')?.dotColor).toBe('#3B82F6');
        expect(groups.find((group) => group.title === 'No area')?.dotColor).toBe('#22C55E');
    });
});

// #963: grouping is for finding a group, so the ungrouped pile goes last. This
// walks every axis any view offers rather than the four that were wrong, so an
// axis added later cannot quietly reintroduce a leading catch-all.
describe('every grouping axis', () => {
    const EVERY_AXIS: TaskGroupAxis[] = Array.from(new Set<TaskGroupAxis>([
        ...FOCUS_AXES, ...REFERENCE_AXES, ...DONE_AXES, ...SOMEDAY_AXES, ...CONTEXTS_AXES,
    ])).filter((axis) => axis !== 'none');

    const areas: Area[] = [{
        id: 'a1',
        name: 'Work',
        color: '#111111',
        order: 0,
        createdAt: '2026-03-01T00:00:00.000Z',
        updatedAt: '2026-03-01T00:00:00.000Z',
    }];
    const project: Project = {
        id: 'p1',
        title: 'Alpha',
        color: '#222222',
        order: 0,
        status: 'active',
        tagIds: [],
        areaId: 'a1',
        createdAt: '2026-03-01T00:00:00.000Z',
        updatedAt: '2026-03-01T00:00:00.000Z',
    };
    const tasks = [
        baseTask({
            id: 'filled',
            areaId: 'a1',
            projectId: 'p1',
            tags: ['#tag'],
            contexts: ['@ctx'],
            priority: 'high',
            energyLevel: 'high',
            assignedTo: 'Ana',
            completedAt: '2026-02-01T00:00:00.000Z',
        }),
        baseTask({ id: 'bare' }),
    ];

    it.each(EVERY_AXIS)('puts the muted catch-all group last: %s', (axis) => {
        const groups = groupTasks(axis, {
            tasks,
            areas,
            projectMap: new Map([[project.id, project]]),
            t: (key: string) => key,
        });
        const mutedIndex = groups.findIndex((group) => group.muted);
        if (mutedIndex === -1) return;
        expect(mutedIndex).toBe(groups.length - 1);
    });
});

const ROSTERS: Array<[string, readonly TaskGroupAxis[]]> = [
    ['FOCUS_AXES', FOCUS_AXES],
    ['REFERENCE_AXES', REFERENCE_AXES],
    ['SOMEDAY_AXES', SOMEDAY_AXES],
    ['CONTEXTS_AXES', CONTEXTS_AXES],
];

describe.each(ROSTERS)('%s', (_name, axes) => {
    it('survives a persist/reload round trip for every axis it offers', () => {
        // A dropdown axis its own sanitizer rejects would reset the user's view
        // to 'none' on the next launch, silently. Both now read this array.
        for (const axis of axes) {
            const reloaded = JSON.parse(JSON.stringify({ groupBy: axis })) as { groupBy: unknown };
            expect(sanitizeAxis(axes, reloaded.groupBy, 'none')).toBe(axis);
        }
    });

    it('has a label for every axis it offers', () => {
        for (const axis of axes) {
            expect(getGroupAxisLabel(axis, (key) => key)).toBeTruthy();
        }
    });

    it('keeps collapse state for every axis it offers', () => {
        const stored = Object.fromEntries(
            axes.filter((axis) => axis !== 'none').map((axis) => [axis, [`${axis}:group-1`]]),
        );
        const state = sanitizeCollapsedGroups(axes, stored, emptyCollapsedGroups(axes));
        for (const axis of axes) {
            if (axis === 'none') continue;
            expect(state[axis]).toEqual([`${axis}:group-1`]);
        }
    });
});

describe('sanitizeAxis', () => {
    it('falls back for anything the roster does not offer', () => {
        expect(sanitizeAxis(REFERENCE_AXES, 'energy', 'none')).toBe('none');
        expect(sanitizeAxis(FOCUS_AXES, 'status', 'none')).toBe('none');
        expect(sanitizeAxis(CONTEXTS_AXES, undefined, 'status')).toBe('status');
        expect(sanitizeAxis(FOCUS_AXES, { project: true }, 'area')).toBe('area');
    });
});

describe('sanitizeCollapsedGroups', () => {
    // The hole this closes: collapse rosters used to be hand-written
    // `Partial<Record<Axis, string[]>>` literals, one per view. Because they
    // were Partial, adding a ninth axis and forgetting the literal compiled
    // clean, and that axis lost its collapse state on every read. Adding an
    // axis to the array is now the entire change — nothing here lists keys.
    const NINTH_AXIS_ROSTER = [...FOCUS_AXES, 'status'] as const;

    it('carries an axis added to the roster, with no other edit', () => {
        const stored = { status: ['status:next'], project: ['project:p1'] };
        const state = sanitizeCollapsedGroups(
            NINTH_AXIS_ROSTER,
            stored,
            emptyCollapsedGroups(NINTH_AXIS_ROSTER),
        );

        expect(state.status).toEqual(['status:next']);
        expect(state.project).toEqual(['project:p1']);
        // Every axis of the roster has a key: none can be silently absent.
        expect(Object.keys(state).sort()).toEqual(
            NINTH_AXIS_ROSTER.filter((axis) => axis !== 'none').slice().sort(),
        );
    });

    it('drops junk ids and duplicates but keeps the axis key', () => {
        const state = sanitizeCollapsedGroups(
            REFERENCE_AXES,
            { area: ['area:a1', 'area:a1', '  ', 7, null], project: 'not-an-array' },
            emptyCollapsedGroups(REFERENCE_AXES),
        );

        expect(state.area).toEqual(['area:a1']);
        expect(state.project).toEqual([]);
        expect(state.tag).toEqual([]);
    });

    it('falls back per axis when the stored blob is not an object', () => {
        const fallback = { ...emptyCollapsedGroups(REFERENCE_AXES), tag: ['tag:work'] };
        const state = sanitizeCollapsedGroups(REFERENCE_AXES, 'corrupt', fallback);

        expect(state.tag).toEqual(['tag:work']);
        expect(state.area).toEqual([]);
    });
});

describe('contexts view state persistence', () => {
    it('accepts every axis the Contexts dropdown offers', () => {
        // End-to-end version of the round trip: the real stored blob through the
        // real sanitizer, proving the menu and the store agree on the roster.
        for (const axis of CONTEXTS_AXES) {
            const raw = JSON.stringify({ selectedContext: null, statusFilters: [], groupBy: axis });
            const state = sanitizeContextsViewState(JSON.parse(raw) as unknown, DEFAULT_CONTEXTS_VIEW_STATE);
            expect(state.groupBy).toBe(axis);
        }
    });

    it('still rejects an axis the Contexts dropdown does not offer', () => {
        const state = sanitizeContextsViewState({ groupBy: 'energy' }, DEFAULT_CONTEXTS_VIEW_STATE);
        expect(state.groupBy).toBe('none');
    });
});
